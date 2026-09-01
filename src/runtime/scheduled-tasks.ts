import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAgentPromptContext } from "../runtime/prompt-context-builder.js";
import { recordAgentTrace } from "../runtime/trace.js";
import { extractFinalCustomerReply, sanitizeCustomerText, sanitizeWeixinCustomerText } from "../lib/customer-output.js";
import { logger } from "../lib/logger.js";
import { sqlite } from "../db/index.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import type { UserContext } from "../lib/user-context.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { formatUnknownError } from "../lib/errors.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { periodicReviewBackend } from "../lib/periodic-review-backend.js";
import {
  buildDailyReviewContext,
  buildMonthlyReviewContext,
  buildWeeklyReviewContext,
  localDateString,
  weekRangeForDate,
  monthRangeForDate,
} from "../handlers/review.js";
import { createMastraToolMap } from "../mastra/tools/mastra-tools.js";
import { runMastraTurn } from "../mastra/run-turn.js";
import { resolveAutoModel } from "../services/model-health.js";
import { resolveExternalMastraToolsets, withExternalToolCallObserver } from "../mastra/external-mcp.js";
import { buildAgentInstructions } from "./agent-instructions.js";

const SCHEDULED_AGENT_TIMEOUT_MS =
  Number(process.env.SCHEDULED_AGENT_TIMEOUT_MS) || 600_000;


export function isLegacyReviewOrch(): boolean {
  // E8: the workspace rollback backend is removed; legacy orchestration is
  // permanently off.
  return false;
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
      expectedReviewKind: "daily" as const,
      expectedReviewKey: input.date,
    };
    const promptContext = await buildAgentPromptContext({
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
      await runScheduledAgentTask({
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

export async function runScheduledMarketWatchTask(
  scope: ScheduledScope,
  correlation?: { runId?: string },
): Promise<string | null> {
  const pushMode = await resolveMarketWatchPushMode(scope);

  // WP4 新路径: 开放研究交还 Mastra runtime。不约束工具 (Mastra 自由选任意已启用只读 MCP)、
  // 不预抓取 snapshot、不审计纠偏、不矛盾检测、不兜底。只处理精确 NO_PUSH 或可投递正文。
  const userContext = { ...await buildScheduledUserContext(scope, "market-watch"), taskType: "scheduled-market-watch" };
  const promptContext = await buildAgentPromptContext({
    userText: buildMarketWatchTaskPrompt(userContext, pushMode),
    userContext,
  });
  const reply = await runScheduledAgentTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-market-watch",
    runId: correlation?.runId,
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  const cleaned = sanitizeScheduledReply(reply);
  // NO_PUSH 一律 return null (无兜底简报); 空正文也 return null
  if (!cleaned || cleaned === "NO_PUSH") return null;
  return cleaned;
}

export async function runScheduledReviewTask(
  scope: ScheduledScope,
  kind: ScheduledReviewKind,
  correlation?: { runId?: string },
): Promise<string | null> {
  // F1: taskType 驱动最小权限授权 (daily = reads + reviews.save; weekly/monthly = reads only)
  const userContext = { ...await buildScheduledUserContext(scope, `${kind}-review`), taskType: `scheduled-${kind}-review` };

  if (kind === "daily") {
    return runScheduledDailyReview(userContext, correlation?.runId);
  }

  if (kind === "weekly") {
    return runScheduledPeriodicReview(userContext, "weekly", correlation?.runId);
  }

  return runScheduledPeriodicReview(userContext, "monthly", correlation?.runId);
}

/**
 * 日复盘: reviews.save 是唯一完成路径,回读校验四元组 (publicationAt/convId/scheduled/pushBrief)。
 * WP4 新路径不预聚合注入、不禁工具; flag=true 时走旧编排 (buildDailyReviewContext + 禁工具 prompt)。
 */
async function runScheduledDailyReview(userContext: UserContext, runId?: string): Promise<string | null> {
  const publicationStartedAt = Date.now();
  const legacy = isLegacyReviewOrch();
  const reviewContext = legacy
    ? await buildDailyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId })
    : null;
  const reviewDate = reviewContext?.date ?? localDateString();
  userContext.expectedReviewKind = "daily";
  userContext.expectedReviewKey = reviewDate;

  const promptContext = await buildAgentPromptContext({
    userText: buildDailyReviewTaskPrompt(),
    ...(legacy ? { reviewContext, allowReviewPublication: true } : {}),
    userContext,
  });
  await runScheduledAgentTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-daily-review",
    runId,
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
 * F2: 新路径改为受控保存——Agent 调 reviews.save(kind/reportKey)，服务回读校验四元组。
 */
async function runScheduledPeriodicReview(userContext: UserContext, kind: "weekly" | "monthly", runId?: string): Promise<string | null> {
  const legacy = isLegacyReviewOrch();
  const reportKey = kind === "weekly"
    ? `${weekRangeForDate().weekStart}_weekly`
    : monthRangeForDate().monthKey;
  userContext.expectedReviewKind = kind;
  userContext.expectedReviewKey = reportKey;

  if (legacy) {
    if (kind === "weekly") {
      const context = await buildWeeklyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
      const content = await runStructuredReviewPrompt(userContext, "weekly", context, undefined, runId);
      await writeWorkspaceReview(userContext.userId, "weekly", `${context.weekStart}_weekly`, content);
      return sanitizeWeixinCustomerText(buildScheduledReviewPush("周复盘", content));
    }
    const context = await buildMonthlyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
    const content = await runStructuredReviewPrompt(userContext, "monthly", context, undefined, runId);
    await writeWorkspaceReview(userContext.userId, "monthly", context.monthKey, content);
    return sanitizeWeixinCustomerText(buildScheduledReviewPush("月复盘", content));
  }

  // F2 新路径: 受控保存。prompt 要求 Agent 调 reviews.save(kind/reportKey)，
  // 服务回读 periodicReviewBackend 校验四元组（publicationAt/convId/scheduled/pushBrief）。
  const publicationStartedAt = Date.now();
  await runStructuredReviewPrompt(userContext, kind, null, reportKey, runId);
  const published = await periodicReviewBackend.get(userContext.userId, userContext.instanceId!, kind, reportKey);
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
    throw new Error(`scheduled ${kind} review did not publish artifact for ${reportKey}`);
  }
  const pushBrief = sanitizeWeixinCustomerText(published.summary || "").trim();
  if (!pushBrief) throw new Error(`scheduled ${kind} review did not return push brief for ${reportKey}`);
  return pushBrief;
}

export function buildDailyReviewTaskPrompt() {
  return [
    "【后台任务：日复盘】",
    "你正在执行当前用户的自动日复盘。",
    "遵守本任务说明、服务工具权限和已注入的用户上下文；研究方法、工具选择、报告结构和详略由你决定。",
    "发布是本任务唯一完成路径：完成研究后必须调用 reviews.save，content 放完整 Markdown，pushBrief 放独立的微信简报；重要观点和数据质量事件可分别放入 decisionRecords、sourceEvents。",
    "pushBrief 会直接作为微信消息发送给用户，必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本。",
    "完整报告和 pushBrief 都要让三个决策易于找到：是否需要行动、是否需要关注、是否需要用户确认；重要判断同时给出验证信号与失效信号，并说明关键数据的来源、截至时间和质量边界。",
    "不要把未保存的复盘草稿、摘要或自然语言最终回复当作完成。若 reviews.save 未成功，停止，不得输出任何面向用户的复盘内容。",
    "仅在 reviews.save 返回成功后，才可给出最终回复；最终回复必须逐字使用该次成功保存的 pushBrief，不要再次输出完整报告，也不要提到工具、内部路径或执行过程。",
    "事实需要有依据；关键数据缺失、过期或冲突时明确说明，不编造精确数据。不要承诺收益。",
  ].join("\n");
}

async function buildScheduledUserContext(scope: ScheduledScope, taskName: string): Promise<UserContext> {
  const userId = scope.userId;
  const projectId = scope.projectId || DEFAULT_PROJECT_ID;
  const instanceId = scope.instanceId || DEFAULT_INSTANCE_ID;
  return {
    userId,
    projectId,
    instanceId,
    channel: "api",
    conversationId: `scheduler:${taskName}:${userId}:${instanceId}`,
  };
}

async function runStructuredReviewPrompt(
  userContext: UserContext,
  kind: "weekly" | "monthly",
  context: unknown,
  reportKey?: string,
  runId?: string,
) {
  const label = kind === "weekly" ? "周复盘" : "月复盘";
  const promptLines = [
    `【后台任务：${label}】`,
    "你正在执行当前用户的自动复盘生成。",
    "遵守本任务说明、服务工具权限和已注入的用户上下文。",
    "研究方法、工具选择、报告结构和详略由你决定。",
    "数据来源只写可读来源摘要，禁止展示原始 URL、endpoint 或接口路径；完整来源链接只保存在网页/Markdown artifact/Audit。",
    "必须区分事实、推断、行动建议、后续验证点；不要承诺收益；数据不足要明确说明。",
  ];
  // WP4: 新路径 (context=null) 不注入预聚合数据,开放研究交还 Mastra runtime
  if (context) {
    promptLines.push(`复盘上下文 JSON：${JSON.stringify(context)}`);
  }
  // F2: reviews.save 是唯一完成路径（受控保存）
  if (reportKey) {
    promptLines.push(
      `发布是本任务唯一完成路径：完成研究后必须调用 reviews.save，kind 传 "${kind}"，reportKey 传 "${reportKey}"，content 放完整 Markdown，pushBrief 放独立的微信简报。`,
      "pushBrief 会直接作为微信消息发送给用户，必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本。",
      "若 reviews.save 未成功，停止，不得输出任何面向用户的复盘内容。仅在 reviews.save 返回成功后，才可给出最终回复，且最终回复必须逐字使用该次成功保存的 pushBrief。",
    );
  }
  const promptContext = await buildAgentPromptContext({
    userText: promptLines.join("\n"),
    userContext,
  });
  const reply = await runScheduledAgentTask({
    userContext,
    promptText: promptContext.promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: `scheduled-${kind}-review`,
    runId,
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  return sanitizeCustomerText(reply);
}

interface ScheduledAgentTaskInput {
  userContext: UserContext;
  promptText: string;
  conversationId: string;
  messageId: string;
  mode: string;
  reviewContextSummary?: Record<string, unknown>;
  sandboxTokenId?: string;
  sandboxPermissions?: string[];
  runId?: string;
  taskId?: string;
}

async function runScheduledAgentTask(input: ScheduledAgentTaskInput) {
  const startedAt = Date.now();
  try {
    const mastraTools = await createMastraToolMap({
      ...input.userContext,
      instanceId: input.userContext.instanceId ?? DEFAULT_INSTANCE_ID,
      // Explicit correlation so audits link to this turn's trace and its
      // scheduler run without time-proximity guessing (WP3 diagnostic chain).
      traceId: input.messageId,
      runId: input.runId,
      taskId: input.taskId,
    });
    const externalMcp = await resolveExternalMastraToolsets("scheduled-read");
    const observedToolsets = withExternalToolCallObserver(externalMcp.toolsets, {
      userId: input.userContext.userId,
      projectId: input.userContext.projectId ?? DEFAULT_PROJECT_ID,
      instanceId: input.userContext.instanceId ?? DEFAULT_INSTANCE_ID,
      conversationId: input.conversationId,
      runId: input.runId,
    });
    try {
      const autoRoute = resolveAutoModel({ hasImage: false });
      const mastraResult = await runMastraTurn({
        conversationId: input.conversationId,
        text: input.promptText,
        messageId: input.messageId,
        model: autoRoute.model,
        timeoutMs: SCHEDULED_AGENT_TIMEOUT_MS,
        userContext: input.userContext,
        requestContext: {
          userId: input.userContext.userId,
          projectId: input.userContext.projectId ?? DEFAULT_PROJECT_ID,
          instanceId: input.userContext.instanceId ?? DEFAULT_INSTANCE_ID,
        },
        toolsets: observedToolsets,
      }, { agentOptions: { instructions: buildAgentInstructions(), tools: mastraTools } });
      const reply = mastraResult.text;
      await recordAgentTrace({
        traceId: input.messageId,
        runId: input.runId,
        taskId: input.taskId,
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
        status: "success",
        elapsedMs: Date.now() - startedAt,
        firstTokenMs: mastraResult.firstTokenMs,
        usage: mastraResult.usage,
        agentBackend: "mastra",
        agentModel: mastraResult.model,
        modelSource: "auto",
        toolCalls: mastraResult.toolCalls,
      });
      return reply;
    } finally {
      await externalMcp.disconnect();
    }
  } catch (error) {
    logger.error(`后台 Agent 任务失败 mode=${input.mode} user=${input.userContext.userId}:`, error);
    await recordAgentTrace({
      traceId: input.messageId,
      runId: input.runId,
      taskId: input.taskId,
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
      agentBackend: "mastra",
      modelSource: "runtime-config",
    });
    throw error;
  }
}

/**
 * P4b: push mode comes from the active typed market-watch task's delivery
 * policy (wechat_on_condition = exception_only/NO_PUSH semantics), not from
 * scattered preference reads. No active task defaults to exception_only for
 * the manual-trigger path.
 */
async function resolveMarketWatchPushMode(scope: ScheduledScope): Promise<MarketWatchPushMode> {
  try {
    const row = sqlite.prepare(
      "SELECT revision.delivery AS deliveryJson FROM automation_tasks task JOIN automation_task_revisions revision ON revision.revision_id = task.current_revision_id WHERE task.user_id=? AND task.project_id=? AND task.instance_id=? AND task.task_type='scheduled-market-watch' AND task.status='active' LIMIT 1",
    ).get(scope.userId, scope.projectId ?? DEFAULT_PROJECT_ID, scope.instanceId ?? DEFAULT_INSTANCE_ID) as { deliveryJson?: string } | undefined;
    const delivery = row?.deliveryJson ? JSON.parse(row.deliveryJson) as { mode?: string } : null;
    if (delivery?.mode === "wechat_on_condition") return "exception_only";
    if (delivery?.mode === "wechat_summary") return "scheduled_intraday_brief";
  } catch (error) {
    logger.warn(`market-watch delivery policy read failed user=${scope.userId}: ${(error as Error).message}`);
  }
  return "exception_only";
}

export function buildMarketWatchTaskPrompt(userContext: UserContext, pushMode: MarketWatchPushMode) {
  // R4: 服务不再编排研究行为。prompt 只解释精确输出协议；数据工具选择、是否推送
  // 和研究步骤交给 Mastra runtime、业务工具和通知策略决定。
  return [
    "【后台任务：盘中定时简报】",
    "你正在生成当前用户的盘中定时简报。",
    "遵守本任务说明、服务工具权限和已注入的用户上下文。",
    "market-watch 是盘中定时简报/摘要任务，不是明确规则巡检；明确规则巡检只由 rule-alert-check 执行 alert_rules。",
    "是否推送、推送频率、推送内容和提醒边界均以服务端读取的用户配置为准。",
    "研究方法、工具选择、数据来源和报告结构由你根据可用的服务工具和 MCP 工具自行决定。",
    "数据来源只写可读来源摘要；禁止展示原始 URL、endpoint 或接口路径。",
    "输出协议（精确）：",
    "- 若按用户配置本轮不应推送，只输出：NO_PUSH",
    "- 若按用户配置本轮应推送，只输出微信正文：必须使用适合微信阅读且可由微信渲染的简洁 Markdown；使用 `**重点**` 和清晰分段，并按内容需要使用列表或短标题，不要写成无格式的连续纯文本。",
    "这条内容会直接作为微信消息发送给用户。不要披露内部实现、运行环境、接口细节、后台任务或本地路径。",
    `当前用户: ${userContext.userId}`,
    `当前实例: ${userContext.instanceId}`,
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
