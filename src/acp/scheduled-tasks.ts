import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentAcpAgent, loadCurrentBackendId } from "./stdio-agent.js";
import { resolveScheduledModelTier, type AcpModelTier } from "./model-router.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { recordAcpTrace } from "./trace.js";
import { extractFinalCustomerReply, sanitizeCustomerText, sanitizeWeixinCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import type { UserContext } from "../lib/user-context.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { readSchedules } from "../lib/schedules-loader.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { formatUnknownError } from "../lib/errors.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { captureMarketWatchSnapshot } from "../services/market-watch-snapshot.js";
import { db } from "../db/index.js";
import { sandboxAuditLogs } from "../db/schema.js";
import type { MarketSnapshot } from "../services/market-data.js";
import {
  buildDailyReviewContext,
  buildMonthlyReviewContext,
  buildWeeklyReviewContext,
  localDateString,
  weekRangeForDate,
  monthRangeForDate,
} from "../handlers/review.js";

const SCHEDULED_ACP_TIMEOUT_MS =
  Number(process.env.SCHEDULED_ACP_TIMEOUT_MS) || 600_000;

/**
 * WP4: 预编排 feature flag。
 *
 * 新路径 (flag=false, 默认) 把开放研究完全交还 ACP 与 Workspace Skills：
 * market-watch 不约束工具/不预抓取/不审计纠偏/不兜底；review 不预聚合注入/不禁工具。
 * flag=true 保留旧编排,可灰度回切。flag 读取统一用 `=== "true"`,与 ACP_EVAL_* 一致。
 */
export function isLegacyMarketWatchOrch(): boolean {
  return process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH === "true";
}

export function isLegacyReviewOrch(): boolean {
  return process.env.SCHEDULED_REVIEW_LEGACY_ORCH === "true";
}

export interface ScheduledScope {
  userId: string;
  instanceId?: string;
  projectId?: string;
}

export interface ScheduledReviewPublicationProbeInput {
  date: string;
  content: string;
  pushBrief: string;
  maxAttempts?: number;
}

type ScheduledReviewKind = "daily" | "weekly" | "monthly";
type MarketWatchPushMode = "exception_only" | "scheduled_intraday_brief";
const MARKET_WATCH_ALLOWED_TOOLS = [
  "market_watch.snapshot",
  "market.snapshot",
  "market.quote",
  "market.indices",
  "market.kline",
  "market.capital_flow",
  "market.sector_theme",
  "market.stock_info",
  "market.calendar",
  "market.health",
  "watch_rules.list",
  "watch_rules.dry_run",
];

// Calendar and health describe the availability of a market session or source,
// but neither supplies the market facts a scheduled brief is required to use.
export const MARKET_WATCH_FACT_TOOLS = [
  "market_watch.snapshot",
  "market.snapshot",
  "market.quote",
  "market.indices",
  "market.kline",
  "market.capital_flow",
  "market.sector_theme",
  "market.stock_info",
] as const;

/**
 * Single-purpose acceptance probe for the scheduled review publication step.
 * It does not collect market data, enqueue a push, or run the full review.
 */
export async function runScheduledReviewPublicationProbe(
  scope: ScheduledScope,
  input: ScheduledReviewPublicationProbeInput,
) {
  const content = input.content.trim();
  const pushBrief = input.pushBrief.trim();
  if (!input.date.trim() || !content || !pushBrief) {
    throw new Error("publication probe requires date, content, and pushBrief");
  }
  const maxAttempts = Math.max(1, Math.min(2, input.maxAttempts ?? 2));
  const baseContext = await buildScheduledUserContext(scope, "daily-review");
  let lastError = "publication was not observed";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const publicationStartedAt = Date.now();
    const conversationId = [
      "scheduler",
      "daily-review",
      "publication-probe",
      baseContext.userId,
      baseContext.instanceId,
      randomUUID(),
    ].join(":");
    const userContext = {
      ...baseContext,
      conversationId,
      mcpAllowedTools: ["reviews.save"],
    };
    const promptContext = await buildAcpPromptContext({
      userText: [
        "【定时日复盘发布单点验收】",
        "这是发布步骤验收，不要分析行情、不要改写内容、不要调用其他工具。",
        "立即调用 reviews.save，参数必须严格使用下面的 JSON。工具成功后只回复 PUBLISHED。",
        JSON.stringify({ date: input.date, content, pushBrief }),
      ].join("\n"),
      userContext,
      includeContextPacket: false,
    });

    try {
      await runAcpTask({
        userContext,
        promptText: promptContext.promptText,
        conversationId,
        messageId: randomUUID(),
        mode: "scheduled-daily-review-publication-probe",
        sandboxTokenId: promptContext.sandboxContext.tokenId,
        sandboxPermissions: promptContext.sandboxContext.permissions,
      });
      const published = await dailyPlanBackend.get(userContext.userId, userContext.instanceId!, input.date);
      const publishedAt = published?.generatedAt ? Date.parse(published.generatedAt) : Number.NaN;
      const publication = published?.data && typeof published.data === "object"
        ? (published.data as any).context?.publication
        : null;
      if (
        published
        && Number.isFinite(publishedAt)
        && publishedAt >= publicationStartedAt - 1_000
        && publication?.conversationId === conversationId
        && publication?.scheduled === true
        && published.content === content
        && published.summary === pushBrief
      ) {
        return {
          ok: true,
          userId: userContext.userId,
          instanceId: userContext.instanceId,
          date: input.date,
          attempts: attempt,
          conversationId,
        };
      }
      lastError = "reviews.save did not create an exact scoped publication";
    } catch (error) {
      lastError = formatUnknownError(error);
    }
  }

  throw new Error(`scheduled review publication probe failed after ${maxAttempts} attempts: ${lastError}`);
}

export async function runScheduledMarketWatchTask(scope: ScheduledScope): Promise<string | null> {
  const pushMode = await resolveMarketWatchPushMode(scope.userId);

  if (isLegacyMarketWatchOrch()) {
    return runLegacyMarketWatchTask(scope, pushMode);
  }

  // WP4 新路径: 开放研究完全交还 ACP。不约束工具 (ACP 自由选任意已启用只读 MCP)、
  // 不预抓取 snapshot、不审计纠偏、不矛盾检测、不兜底。只处理精确 NO_PUSH 或可投递正文。
  const userContext = await buildScheduledUserContext(scope, "market-watch");
  const promptContext = await buildAcpPromptContext({
    userText: buildMarketWatchTaskPrompt(userContext, pushMode),
    userContext,
  });
  const reply = await runAcpTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-market-watch",
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  const cleaned = sanitizeScheduledReply(reply);
  // NO_PUSH 一律 return null (无兜底简报); 空正文也 return null
  if (!cleaned || cleaned === "NO_PUSH") return null;
  return cleaned;
}

/**
 * 旧 market-watch 编排 (flag=true 时): snapshot 预抓取 + 具名行情审计 + 纠偏重跑
 * + 文本/快照矛盾检测 + 固定简报模式兜底。保留用于灰度回切。
 */
async function runLegacyMarketWatchTask(scope: ScheduledScope, pushMode: MarketWatchPushMode): Promise<string | null> {
  const userContext = {
    ...await buildScheduledUserContext(scope, "market-watch"),
    mcpAllowedTools: MARKET_WATCH_ALLOWED_TOOLS,
  };
  const windowKey = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  const captured = await captureMarketWatchSnapshot({ userId: userContext.userId, projectId: userContext.projectId || DEFAULT_PROJECT_ID, instanceId: userContext.instanceId || DEFAULT_INSTANCE_ID, windowKey });
  const promptContext = await buildAcpPromptContext({
    userText: buildMarketWatchTaskPrompt(userContext, pushMode),
    userContext,
  });
  let reply = await runAcpTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-market-watch",
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  if (!await readMarketWatchFactsWereAudited(userContext)) {
    reply = await runMarketWatchCorrection(userContext, pushMode, promptContext, "上一轮没有通过任何具名行情工具取得本轮市场事实。现在必须调用至少一个行情事实工具，再依据实际返回结果重写简报。");
  }
  if (!await readMarketWatchFactsWereAudited(userContext)) {
    throw new Error("scheduled market-watch did not read current facts through a named market MCP tool");
  }
  if (marketWatchReplyClaimsMissingData(reply, captured.snapshot)) {
    reply = await runMarketWatchCorrection(userContext, pushMode, promptContext, "调度器已采集到有效实时行情，但上一版正文仍声称行情不可用。请通过具名行情工具核实本轮事实后重写；不得沿用昨日行情，也不得把可用事实写成不可用。 ");
  }
  if (marketWatchReplyClaimsMissingData(reply, captured.snapshot)) {
    throw new Error("scheduled market-watch reply contradicts a usable captured snapshot");
  }
  const cleaned = sanitizeScheduledReply(reply);
  if (!cleaned) return null;
  if (cleaned === "NO_PUSH") {
    if (pushMode === "scheduled_intraday_brief") {
      logger.warn(`固定盘中简报返回 NO_PUSH，改用兜底简报 user=${userContext.userId} instance=${userContext.instanceId}`);
      return buildMarketWatchFallbackBrief();
    }
    return null;
  }
  return cleaned;
}

async function runMarketWatchCorrection(
  userContext: UserContext,
  pushMode: MarketWatchPushMode,
  promptContext: Awaited<ReturnType<typeof buildAcpPromptContext>>,
  correction: string,
) {
  return runAcpTask({
    userContext,
    promptText: [buildMarketWatchTaskPrompt(userContext, pushMode), correction].join("\n"),
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-market-watch",
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
}

export async function readMarketWatchFactsWereAudited(userContext: UserContext) {
  const [audit] = await db.select({ id: sandboxAuditLogs.id }).from(sandboxAuditLogs).where(and(
    eq(sandboxAuditLogs.userId, userContext.userId),
    eq(sandboxAuditLogs.instanceId, userContext.instanceId || DEFAULT_INSTANCE_ID),
    eq(sandboxAuditLogs.conversationId, userContext.conversationId || ""),
    inArray(sandboxAuditLogs.operation, [...MARKET_WATCH_FACT_TOOLS]),
    eq(sandboxAuditLogs.status, "success"),
  )).limit(1);
  return Boolean(audit);
}

export function marketWatchReplyClaimsMissingData(reply: string, snapshot: MarketSnapshot) {
  const hasUsableQuote = [...snapshot.holdings, ...snapshot.watchlist, ...snapshot.plans]
    .some((item) => item.quote && !["stale", "invalid", "unknown"].includes(item.quote.tradingStatus.status));
  if (!hasUsableQuote) return false;
  return /(?:实时行情|行情快照|本轮行情).{0,12}(?:不可用|未返回|缺失|未获得)/.test(reply);
}

export async function runScheduledReviewTask(scope: ScheduledScope, kind: ScheduledReviewKind): Promise<string | null> {
  const userContext = await buildScheduledUserContext(scope, `${kind}-review`);

  if (kind === "daily") {
    return runScheduledDailyReview(userContext);
  }

  if (kind === "weekly") {
    return runScheduledPeriodicReview(userContext, "weekly");
  }

  return runScheduledPeriodicReview(userContext, "monthly");
}

/**
 * 日复盘: reviews.save 是唯一完成路径,回读校验四元组 (publicationAt/convId/scheduled/pushBrief)。
 * WP4 新路径不预聚合注入、不禁工具; flag=true 时走旧编排 (buildDailyReviewContext + 禁工具 prompt)。
 */
async function runScheduledDailyReview(userContext: UserContext): Promise<string | null> {
  const publicationStartedAt = Date.now();
  const legacy = isLegacyReviewOrch();
  const reviewContext = legacy
    ? await buildDailyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId })
    : null;
  const reviewDate = reviewContext?.date ?? localDateString();

  const promptContext = await buildAcpPromptContext({
    userText: buildDailyReviewTaskPrompt(),
    ...(legacy ? { reviewContext, allowReviewPublication: true } : {}),
    userContext,
  });
  await runAcpTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-daily-review",
    reviewContextSummary: promptContext.reviewContextSummary,
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  // The Agent's final text is not authoritative: only reviews.save is the
  // durable publication contract. This also prevents a mismatched draft
  // reply from being delivered after a successful save.
  const published = await dailyPlanBackend.get(userContext.userId, userContext.instanceId!, reviewDate);
  const publishedAt = published?.generatedAt ? Date.parse(published.generatedAt) : Number.NaN;
  const publication = published?.data && typeof published.data === "object"
    ? (published.data as any).context?.publication
    : null;
  if (
    !published
    || !Number.isFinite(publishedAt)
    || publishedAt < publicationStartedAt - 1_000
    || publication?.conversationId !== userContext.conversationId
    || publication?.scheduled !== true
  ) {
    throw new Error(`scheduled daily review did not publish artifact for ${reviewDate}`);
  }
  const pushBrief = sanitizeWeixinCustomerText(published.summary || "").trim();
  if (!pushBrief) throw new Error(`scheduled daily review did not return push brief for ${reviewDate}`);
  return pushBrief;
}

/**
 * 周复盘: WP4 新路径不预聚合注入 context; flag=true 时走旧编排。
 * 完成条件保留 writeWorkspaceReview (reviews.save 完成校验另立任务)。
 */
async function runScheduledPeriodicReview(userContext: UserContext, kind: "weekly" | "monthly"): Promise<string | null> {
  const legacy = isLegacyReviewOrch();
  if (legacy) {
    if (kind === "weekly") {
      const context = await buildWeeklyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
      const content = await runStructuredReviewPrompt(userContext, "weekly", context);
      await writeWorkspaceReview(userContext.userId, "weekly", `${context.weekStart}_weekly`, content);
      return sanitizeWeixinCustomerText(buildScheduledReviewPush("周复盘", content));
    }
    const context = await buildMonthlyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
    const content = await runStructuredReviewPrompt(userContext, "monthly", context);
    await writeWorkspaceReview(userContext.userId, "monthly", context.monthKey, content);
    return sanitizeWeixinCustomerText(buildScheduledReviewPush("月复盘", content));
  }

  // WP4 新路径: 不预聚合 context, 开放研究交还 ACP
  const content = await runStructuredReviewPrompt(userContext, kind, null);
  const reportKey = kind === "weekly"
    ? `${weekRangeForDate().weekStart}_weekly`
    : monthRangeForDate().monthKey;
  await writeWorkspaceReview(userContext.userId, kind, reportKey, content);
  return sanitizeWeixinCustomerText(buildScheduledReviewPush(kind === "weekly" ? "周复盘" : "月复盘", content));
}

export function buildDailyReviewTaskPrompt() {
  return [
    "【后台任务：日复盘】",
    "你正在当前用户 Workspace 中执行自动日复盘。",
    "请优先遵守 AGENTS.md、config/schedules.yaml、config/notification.yaml 和 daily-review skill；研究方法、工具选择、报告结构和详略由你决定。",
    "发布是本任务唯一完成路径：完成研究后必须调用 reviews.save，content 放完整 Markdown，pushBrief 放独立的微信简报；重要观点和数据质量事件可分别放入 decisionRecords、sourceEvents。",
    "pushBrief 会直接作为微信消息发送给用户，必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本。",
    "不要把未保存的复盘草稿、摘要或自然语言最终回复当作完成。若 reviews.save 未成功，停止，不得输出任何面向用户的复盘内容。",
    "仅在 reviews.save 返回成功后，才可给出最终回复；最终回复必须逐字使用该次成功保存的 pushBrief，不要再次输出完整报告，也不要提到工具、内部路径或执行过程。",
    "事实需要有依据；关键数据缺失、过期或冲突时明确说明，不编造精确数据。不要承诺收益。",
  ].join("\n");
}

async function buildScheduledUserContext(scope: ScheduledScope, taskName: string): Promise<UserContext> {
  const userId = scope.userId;
  const projectId = scope.projectId || DEFAULT_PROJECT_ID;
  const instanceId = scope.instanceId || DEFAULT_INSTANCE_ID;
  const workspace = await ensureWorkspace({ userId, projectId });
  return {
    userId,
    projectId,
    instanceId,
    channel: "api",
    backend: await loadCurrentBackendId(),
    conversationId: `scheduler:${taskName}:${userId}:${instanceId}`,
    workspacePath: workspace.path,
  };
}

async function runStructuredReviewPrompt(userContext: UserContext, kind: "weekly" | "monthly", context: unknown) {
  const label = kind === "weekly" ? "周复盘" : "月复盘";
  const promptLines = [
    `【后台任务：${label}】`,
    "你正在当前用户 Workspace 中执行自动复盘生成。",
    "这条内容会直接作为微信消息发送给用户，必须使用适合微信阅读的 Markdown。",
    "请优先遵守 AGENTS.md、config/schedules.yaml、config/notification.yaml 和 review/market 相关 skills。",
    "结构和详略由 Workspace 规则决定；不要在服务层任务中自行压缩成固定字数摘要。",
    "只输出给用户看的微信复盘正文，不要输出执行过程、工具调用过程或内部路径。",
    "数据来源只写可读来源摘要，禁止展示原始 URL、endpoint 或接口路径；完整来源链接只保存在网页/Markdown artifact/Audit。",
    "必须区分事实、推断、行动建议、后续验证点；不要承诺收益；数据不足要明确说明。",
  ];
  // WP4: 新路径 (context=null) 不注入预聚合数据,开放研究交还 ACP
  if (context) {
    promptLines.push(`复盘上下文 JSON：${JSON.stringify(context)}`);
  }
  const promptContext = await buildAcpPromptContext({
    userText: promptLines.join("\n"),
    userContext,
  });
  const reply = await runAcpTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: `scheduled-${kind}-review`,
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  return sanitizeCustomerText(reply);
}

interface ScheduledAcpTaskInput {
  userContext: UserContext;
  promptText: string;
  conversationId: string;
  messageId: string;
  mode: string;
  modelTier?: AcpModelTier;
  reviewContextSummary?: Record<string, unknown>;
  sandboxTokenId?: string;
  sandboxPermissions?: string[];
}

export function buildScheduledAcpChatParams(input: ScheduledAcpTaskInput) {
  return {
    conversationId: input.conversationId,
    text: input.promptText,
    messageId: input.messageId,
    timeoutMs: SCHEDULED_ACP_TIMEOUT_MS,
    cwd: input.userContext.workspacePath,
    // MCP server scope is derived when the ACP session is created. Without
    // this context scheduled tasks silently fall back to the primary user.
    userContext: input.userContext,
  };
}

async function runAcpTask(input: ScheduledAcpTaskInput) {
  const startedAt = Date.now();
  try {
    const acpResult = await (await getCurrentAcpAgent(input.userContext.workspacePath, {
      modelTier: input.modelTier || resolveScheduledModelTier(input.mode),
    })).chatWithUsage(buildScheduledAcpChatParams(input));
    const reply = acpResult.text;
    await recordAcpTrace({
      userId: input.userContext.userId,
      projectId: input.userContext.projectId,
      instanceId: input.userContext.instanceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      channel: "scheduler",
      userText: input.promptText.slice(0, 2000),
      promptText: input.promptText,
      replyTextRaw: reply,
      replyTextSanitized: sanitizeCustomerText(reply),
      mode: input.mode,
      reviewContextSummary: input.reviewContextSummary,
      sandboxTokenId: input.sandboxTokenId,
      sandboxPermissions: input.sandboxPermissions,
      status: "success",
      elapsedMs: Date.now() - startedAt,
      usage: acpResult.usage,
    });
    return reply;
  } catch (error) {
    logger.error(`后台 ACP 任务失败 mode=${input.mode} user=${input.userContext.userId}:`, error);
    await recordAcpTrace({
      userId: input.userContext.userId,
      projectId: input.userContext.projectId,
      instanceId: input.userContext.instanceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      channel: "scheduler",
      userText: input.promptText.slice(0, 2000),
      promptText: input.promptText,
      mode: input.mode,
      status: "error",
      errorMessage: formatUnknownError(error),
      elapsedMs: Date.now() - startedAt,
      sandboxTokenId: input.sandboxTokenId,
      sandboxPermissions: input.sandboxPermissions,
    });
    throw error;
  }
}

async function resolveMarketWatchPushMode(userId: string): Promise<MarketWatchPushMode> {
  const schedules = readSchedules(userId);
  const watch = await readWatchConfig(userId);
  const mode = String(watch?.mode || schedules.market_watch?.push_mode || "");
  if (mode === "scheduled_intraday_brief" || schedules.market_watch?.only_push_on_exception === false || watch?.only_push_on_exception === false) {
    return "scheduled_intraday_brief";
  }
  return "exception_only";
}

async function readWatchConfig(userId: string) {
  try {
    return await new WorkspaceStore(userId).readWatch();
  } catch (error) {
    logger.warn(`scheduled.marketWatch.readWatch failed user=${userId}: ${(error as Error).message}`);
    return null;
  }
}

export function buildMarketWatchTaskPrompt(userContext: UserContext, pushMode: MarketWatchPushMode) {
  const isBriefMode = pushMode === "scheduled_intraday_brief";
  return [
    "【后台任务：盘中定时简报】",
    "你正在当前用户 Workspace 中生成盘中定时简报。",
    "这条内容会直接作为微信消息发送给用户，必须使用适合微信阅读的 Markdown。",
    "请读取 AGENTS.md、config/watch.yaml、config/notification.yaml、config/portfolio.yaml、reports/daily/ 和 market-watch skill。",
    "market-watch 是盘中定时简报/摘要任务，不是明确规则巡检；明确规则巡检只由 rule-alert-check 执行 alert_rules。",
    "是否推送、推送频率、推送内容和提醒边界均以 Workspace 配置与 market-watch skill 为准。",
    "结构和详略由 Workspace 规则决定；不要输出执行过程。",
    "数据来源只写可读来源摘要，例如“腾讯行情、腾讯日K、东方财富新闻线索”；禁止展示原始 URL、endpoint 或接口路径。",
    "开始判断前，必须通过至少一个当前暴露的具名行情读取能力取得本轮市场事实。根据 MCP 能力描述和参数 schema 自行选择最小有用组合，可按需取得调度窗口变化、组合全貌、指数、定向行情、价格历史、资金流、行业题材或事件证据。交易时段或数据源健康证据不能单独替代当前行情事实。核对明确规则时使用 watch_rules.list 或 watch_rules.dry_run。不要使用 shell、curl、本地 HTTP、sandbox token 或工作区文件兜底。",
    "输出契约：",
    isBriefMode
      ? "- 当前是固定盘中简报模式：必须输出一条微信正文；即使没有异常，也要给出盘面状态、持仓观察和“是否需要操作”。"
      : "- 当前是异常触发模式：若按 Workspace 规则本轮不应推送，只输出：NO_PUSH",
    isBriefMode
      ? "- 固定盘中简报模式禁止输出 NO_PUSH、无需推送、暂无提醒等拒绝推送文本。"
      : "- 若按 Workspace 规则本轮应推送，只输出微信正文。",
    "- 不要提到 Codex、Hermes、ACP、workspace、sandbox、curl、接口、后台任务或本地路径。",
    `当前用户: ${userContext.userId}`,
    `当前实例: ${userContext.instanceId}`,
  ].join("\n");
}

function buildMarketWatchFallbackBrief() {
  return [
    "【盘中简报】",
    "本轮未检测到需要立即确认的 P0 级风险或明确买卖区触发。",
    "当前按固定盘中简报规则推送：普通波动先观察，不追涨杀跌；如后续接近关键区间、出现重大公告或核心逻辑变化，再单独提醒。",
    "是否需要操作：暂不需要。",
  ].join("\n");
}

export function sanitizeScheduledReply(reply: string) {
  const cleaned = sanitizeWeixinCustomerText(extractFinalCustomerReply(reply)).trim();
  if (/^NO_PUSH[。.!！\s]*$/i.test(cleaned)) return "NO_PUSH";
  if (/NO_PUSH[。.!！\s]*$/i.test(cleaned) && !/^#{1,3}\s/m.test(cleaned)) return "NO_PUSH";
  if (/^(当前无提醒|暂无提醒|无提醒|无需推送|没有需要推送)/.test(cleaned)) return "NO_PUSH";
  return cleaned;
}

async function writeWorkspaceReview(userId: string, kind: "weekly" | "monthly", key: string, content: string) {
  const wsRoot = resolveWorkspacePath(userId);
  const dir = join(wsRoot, "reports", kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.md`), content, "utf-8");
}

export function buildScheduledReviewPush(label: string, content: string) {
  const cleaned = content.trim();
  if (!cleaned) return `【${label}已生成】\n完整内容已保存到复盘记录。`;
  return cleaned;
}
