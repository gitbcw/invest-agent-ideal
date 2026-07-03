import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentAcpAgent, loadCurrentBackendId } from "./stdio-agent.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { recordAcpTrace } from "./trace.js";
import { extractFinalCustomerReply, sanitizeCustomerText } from "../lib/customer-output.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import type { UserContext } from "../lib/user-context.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { readSchedules } from "../lib/schedules-loader.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { formatUnknownError } from "../lib/errors.js";
import {
  buildDailyReviewContext,
  buildMonthlyReviewContext,
  buildReviewPushSummary,
  buildWeeklyReviewContext,
  saveSkillDailyReview,
} from "../handlers/review.js";

const SCHEDULED_ACP_TIMEOUT_MS =
  Number(process.env.SCHEDULED_ACP_TIMEOUT_MS) || 600_000;

export interface ScheduledScope {
  userId: string;
  instanceId?: string;
  projectId?: string;
}

type ScheduledReviewKind = "daily" | "weekly" | "monthly";
type MarketWatchPushMode = "exception_only" | "scheduled_intraday_brief";

export async function runScheduledMarketWatchTask(scope: ScheduledScope): Promise<string | null> {
  const userContext = await buildScheduledUserContext(scope, "market-watch");
  const pushMode = await resolveMarketWatchPushMode(userContext.userId);
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

export async function runScheduledReviewTask(scope: ScheduledScope, kind: ScheduledReviewKind): Promise<string | null> {
  const userContext = await buildScheduledUserContext(scope, `${kind}-review`);

  if (kind === "daily") {
    const reviewContext = await buildDailyReviewContext({
      userId: userContext.userId,
      instanceId: userContext.instanceId,
    });
    const promptContext = await buildAcpPromptContext({
      userText: [
        "【后台任务：日复盘】",
        "你正在当前用户 Workspace 中执行自动日复盘。",
        "这条内容会直接作为微信消息发送给用户，必须使用适合微信阅读的 Markdown。",
        "请优先遵守 AGENTS.md、config/schedules.yaml、config/notification.yaml 和 daily-review 相关 skills；结构和详略由 Workspace 规则决定。",
        "只输出给用户看的复盘正文，不要输出执行过程、工具调用过程、接口、token 或内部路径。",
        "必须区分事实、推断、行动建议、后续验证点；不要承诺收益；数据不足要明确说明。",
      ].join("\n"),
      reviewContext,
      userContext,
    });
    const reply = await runAcpTask({
      userContext,
      promptText: promptContext.promptText,
      conversationId: userContext.conversationId!,
      messageId: randomUUID(),
      mode: "scheduled-daily-review",
      reviewContextSummary: promptContext.reviewContextSummary,
      sandboxTokenId: promptContext.sandboxContext.tokenId,
      sandboxPermissions: promptContext.sandboxContext.permissions,
    });
    const cleaned = sanitizeCustomerText(reply);
    const summary = buildReviewPushSummary(cleaned, reviewContext.date);
    await saveSkillDailyReview({
      userId: userContext.userId,
      instanceId: userContext.instanceId,
      date: reviewContext.date,
      content: cleaned,
      summary,
      context: {
        generatedAt: reviewContext.generatedAt,
        stocks: reviewContext.stocks.map((stock) => ({ code: stock.code, name: stock.name, pool: stock.pool })),
        alertCount: reviewContext.alerts.length,
        source: "scheduled-acp",
      },
    });
    return cleaned;
  }

  if (kind === "weekly") {
    const context = await buildWeeklyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
    const content = await runStructuredReviewPrompt(userContext, "weekly", context);
    await writeWorkspaceReview(userContext.userId, "weekly", `${context.weekStart}_weekly`, content);
    return buildScheduledReviewPush("周复盘", content);
  }

  const context = await buildMonthlyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
  const content = await runStructuredReviewPrompt(userContext, "monthly", context);
  await writeWorkspaceReview(userContext.userId, "monthly", context.monthKey, content);
  return buildScheduledReviewPush("月复盘", content);
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
  const promptContext = await buildAcpPromptContext({
    userText: [
      `【后台任务：${label}】`,
      "你正在当前用户 Workspace 中执行自动复盘生成。",
      "这条内容会直接作为微信消息发送给用户，必须使用适合微信阅读的 Markdown。",
      "请优先遵守 AGENTS.md、config/schedules.yaml、config/notification.yaml 和 review/market 相关 skills。",
      "结构和详略由 Workspace 规则决定；不要在服务层任务中自行压缩成固定字数摘要。",
      "只输出给用户看的复盘正文，不要输出执行过程、工具调用过程或内部路径。",
      "必须区分事实、推断、行动建议、后续验证点；不要承诺收益；数据不足要明确说明。",
      `复盘上下文 JSON：${JSON.stringify(context)}`,
    ].join("\n"),
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

async function runAcpTask(input: {
  userContext: UserContext;
  promptText: string;
  conversationId: string;
  messageId: string;
  mode: string;
  reviewContextSummary?: Record<string, unknown>;
  sandboxTokenId?: string;
  sandboxPermissions?: string[];
}) {
  const startedAt = Date.now();
  try {
    const acpResult = await (await getCurrentAcpAgent(input.userContext.workspacePath)).chatWithUsage({
      conversationId: input.conversationId,
      text: input.promptText,
      messageId: input.messageId,
      timeoutMs: SCHEDULED_ACP_TIMEOUT_MS,
      cwd: input.userContext.workspacePath,
    });
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

function buildMarketWatchTaskPrompt(userContext: UserContext, pushMode: MarketWatchPushMode) {
  const api = `http://127.0.0.1:${config.port}/api/sandbox/alerts/check`;
  const isBriefMode = pushMode === "scheduled_intraday_brief";
  return [
    "【后台任务：智能盯盘】",
    "你正在当前用户 Workspace 中执行自动盘中巡检。",
    "这条内容会直接作为微信消息发送给用户，必须使用适合微信阅读的 Markdown。",
    "请读取 AGENTS.md、config/watch.yaml、config/notification.yaml、config/portfolio.yaml、reports/daily/ 和 market-watch skill。",
    "是否推送、推送频率、推送内容和提醒规则均以 Workspace 配置与 market-watch skill 为准。",
    "结构和详略由 Workspace 规则决定；不要输出执行过程。",
    "",
    "可调用确定性巡检 API 获取本轮触发结果（sandbox token 已写入 workspace 根目录的 .sandbox-token 文件，curl 必须用 shell 展开，禁止在命令里写出 token 字面值）：",
    `curl -s -X POST ${api} -H "Authorization: Bearer $(cat .sandbox-token)" -H "Content-Type: application/json" -d '{"force":true}'`,
    "",
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
  const cleaned = sanitizeCustomerText(extractFinalCustomerReply(reply)).trim();
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
