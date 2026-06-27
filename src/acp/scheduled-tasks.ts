import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentAcpAgent, loadCurrentBackendId } from "./stdio-agent.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { recordAcpTrace } from "./trace.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import type { UserContext } from "../lib/user-context.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID } from "../lib/user-context.js";
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

export async function runScheduledMarketWatchTask(scope: ScheduledScope): Promise<string | null> {
  const userContext = await buildScheduledUserContext(scope, "market-watch");
  const promptContext = await buildAcpPromptContext({
    userText: buildMarketWatchTaskPrompt(promptContextTokenPlaceholder, userContext),
    userContext,
  });
  const promptText = buildMarketWatchTaskPrompt(promptContext.sandboxToken, userContext);
  const reply = await runAcpTask({
    userContext,
    promptText,
    conversationId: userContext.conversationId!,
    messageId: randomUUID(),
    mode: "scheduled-market-watch",
    sandboxTokenId: promptContext.sandboxContext.tokenId,
    sandboxPermissions: promptContext.sandboxContext.permissions,
  });
  const cleaned = sanitizeScheduledReply(reply);
  if (!cleaned || cleaned === "NO_PUSH") return null;
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
      "这条内容会直接作为微信消息发送给用户。",
      "请基于下方复盘上下文生成今日收盘复盘，控制在微信可读的简短长度，默认不超过 500 字。",
      "只输出给用户看的复盘正文，不要输出执行过程。",
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
        source: "scheduled-hermes",
      },
    });
    return summary;
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
    projectType: "invest-agent",
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
      "这条内容会直接作为微信消息发送给用户，请用微信可读的简短表达，默认不超过 500 字。",
      "请优先遵守 AGENTS.md、config/schedules.yaml、config/notification.yaml 和 review/market 相关 skills。",
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
    const reply = await (await getCurrentAcpAgent(input.userContext.workspacePath)).chat({
      conversationId: input.conversationId,
      text: input.promptText,
      messageId: input.messageId,
      timeoutMs: SCHEDULED_ACP_TIMEOUT_MS,
      cwd: input.userContext.workspacePath,
    });
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
    });
    return reply;
  } catch (error) {
    logger.error(`后台 Hermes ACP 任务失败 mode=${input.mode} user=${input.userContext.userId}:`, error);
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
      errorMessage: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
      sandboxTokenId: input.sandboxTokenId,
      sandboxPermissions: input.sandboxPermissions,
    });
    throw error;
  }
}

const promptContextTokenPlaceholder = "__SANDBOX_TOKEN__";

function buildMarketWatchTaskPrompt(sandboxToken: string, userContext: UserContext) {
  const api = `http://127.0.0.1:${config.port}/api/sandbox/alerts/check`;
  return [
    "【后台任务：智能盯盘】",
    "你正在当前用户 Workspace 中执行自动盘中巡检。",
    "这条内容会直接作为微信消息发送给用户，请保持简短、明确、可直接转发。",
    "请读取 AGENTS.md、config/watch.yaml、config/notification.yaml、config/portfolio.yaml、reports/daily/ 和 market-watch skill。",
    "先判断是否真的有需要打断用户的异常。不要输出普通行情陪伴，不要输出执行过程。",
    "",
    "可调用确定性巡检 API 获取本轮触发结果：",
    `curl -s -X POST ${api} -H 'Authorization: Bearer ${sandboxToken}' -H 'Content-Type: application/json' -d '{"force":true}'`,
    "",
    "输出契约：",
    "- 若没有需要推送的 P0/P1 异常，必须只输出：NO_PUSH",
    "- 若需要推送，只输出微信正文，500 字以内，包含事实、推断、触发规则、用户是否需要确认。",
    "- 不要提到 Hermes、workspace、sandbox、curl、接口、后台任务或本地路径。",
    `当前用户: ${userContext.userId}`,
    `当前实例: ${userContext.instanceId}`,
  ].join("\n");
}

function sanitizeScheduledReply(reply: string) {
  const cleaned = sanitizeCustomerText(reply).trim();
  if (/^NO_PUSH[。.!！\s]*$/i.test(cleaned)) return "NO_PUSH";
  if (/^(当前无提醒|暂无提醒|无提醒|无需推送|没有需要推送)/.test(cleaned)) return "NO_PUSH";
  return cleaned;
}

async function writeWorkspaceReview(userId: string, kind: "weekly" | "monthly", key: string, content: string) {
  const wsRoot = resolveWorkspacePath(userId);
  const dir = join(wsRoot, "reports", kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.md`), content, "utf-8");
}

function buildScheduledReviewPush(label: string, content: string) {
  const head = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join("\n");
  return `【${label}已生成】\n${head}\n\n完整内容已保存到复盘记录。`;
}
