import type { AgentMessage, AgentResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { logger } from "../lib/logger.js";
import { dedupeRepeatedCustomerText, sanitizeCustomerText, sanitizeWeixinCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { recordAgentTrace } from "../runtime/trace.js";
import { DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildAgentPromptContext } from "./prompt-context-builder.js";
import { extractInlineSvgVisuals } from "../services/inline-visuals.js";
import { classifyTaskError } from "../services/task-execution.js";
import { OUTPUT_VOLUME_POLICY } from "./spreadsheet-output-policy.js";
import { createMastraToolMap, filterServiceToolsByGrant } from "../mastra/tools/mastra-tools.js";
import { getMastraBindings } from "../mastra/bindings.js";
import { runMastraTurn } from "../mastra/run-turn.js";
import { recordModelFeedback, resolveAutoModel } from "../services/model-health.js";
import { createRegisteredMastraWorkspace } from "../mastra/workspace-registry.js";
import { resolveExternalMastraToolsets, withExternalToolCallObserver } from "../mastra/external-mcp.js";
import { loadConversationHistory } from "../services/conversation-history.js";
import { isConversationWorkingStateEnabled } from "../services/conversation-working-state.js";
import { buildConversationCoherenceContext } from "../services/conversation-working-state-store.js";
import { buildAgentInstructions } from "./agent-instructions.js";
import { hasExecutionBudgetForFallback, resolveTurnExecutionBudget } from "./execution-budget.js";
import { MastraUserPreferenceStore } from "../services/user-preferences.js";
import { readMastraPortfolioProjection } from "../lib/mastra-portfolio-backend.js";
import { readMastraTradingStrategies } from "../lib/mastra-strategy-library.js";
import { sqlite } from "../db/index.js";

async function hasAnyTypedScheduledTask(userContext: UserContext): Promise<boolean> {
  try {
    return Boolean(sqlite.prepare(
      "SELECT 1 AS one FROM automation_tasks WHERE user_id=? AND project_id=? AND instance_id=? AND task_type IS NOT NULL LIMIT 1",
    ).get(userContext.userId, userContext.projectId ?? "invest-agent", userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId)));
  } catch {
    return false;
  }
}

/**
 * R1 feedback (2026-08-15): initialization guidance for the web channel.
 * A user with no holdings, no watchlist and no strategy pack has not
 * finished initialization; each NEW conversation must open with
 * deterministic onboarding guidance instead of silently answering
 * portfolio-adjacent questions. Later turns stay guided through the
 * service notice injected into the prompt.
 */
async function isInitializationUnfinished(userContext: UserContext): Promise<boolean> {
  try {
    const instanceId = userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId);
    const projectId = userContext.projectId ?? "invest-agent";
    const store = new MastraUserPreferenceStore(userContext.userId, instanceId, projectId);
    const state = await store.readOnboardingState();
    if (state?.completed_at) return false;
    if (await hasAnyTypedScheduledTask(userContext)) return false;
    const portfolio = readMastraPortfolioProjection(userContext.userId, instanceId) as
      | { holdings?: unknown[]; watchlist?: unknown[] }
      | null;
    const hasHoldings = Array.isArray(portfolio?.holdings) && portfolio!.holdings!.length > 0;
    const hasWatchlist = Array.isArray(portfolio?.watchlist) && portfolio!.watchlist!.length > 0;
    const strategies = readMastraTradingStrategies({ userId: userContext.userId, projectId, instanceId });
    return !hasHoldings && !hasWatchlist && strategies.length === 0;
  } catch {
    return false;
  }
}

/**
 * Soft initialization notice (R1 feedback round 2): the service only reports
 * state; the AGENT performs the guidance — answer the user's question
 * normally and remind about initialization in passing, without blocking.
 */
function buildInitializationNotice(): string {
  return [
    "",
    "【服务提示·初始化状态】当前用户尚未完成初始化：无持仓、无观察仓、无策略包。",
    "引导要求：正常回答用户的问题，不要拒绝或只输出引导；在回答中或结尾顺带、自然地提醒一次——完成初始化后（Portal「初始化」向导，或直接在对话里粘贴持仓，每行「股票名称 + 6 位代码」），分析、复盘和提醒才能围绕用户的真实持仓展开。",
    "用户表示不需要、已了解或明确拒绝时，本轮起不再重复提醒；用户主动要开始导入时，使用 onboarding draft 工具带领导入。",
  ].join("\n");
}

const WEIXIN_DIRECT_AGENT_TIMEOUT_MS =
  resolvePositiveTimeoutMs("WEIXIN_DIRECT_AGENT_TIMEOUT_MS", 600_000);
// The Portal Relay keeps a small buffer beyond the total execution budget so
// the connector can persist the runtime's terminal response.
let portalDirectAgentTimeoutMs =
  resolvePositiveTimeoutMs("PORTAL_DIRECT_AGENT_TIMEOUT_MS", 600_000);
export const PORTAL_EXECUTION_BUDGET_MS =
  resolvePositiveTimeoutMs("PORTAL_EXECUTION_BUDGET_MS", 1_200_000);
try {
  validatePortalRuntimeTimeouts(portalDirectAgentTimeoutMs, PORTAL_EXECUTION_BUDGET_MS);
} catch (error) {
  // Older production environments may have equal timeout values. Keep the
  // strict validator for explicit callers, but fail closed at startup with a
  // bounded direct timeout instead of taking the whole runtime offline.
  // Preserve the configured total budget when legacy environments set the
  // direct timeout equal to it; the old 10-minute cap silently halved it.
  const safeDirectTimeoutMs = PORTAL_EXECUTION_BUDGET_MS - 1;
  if (safeDirectTimeoutMs <= 0) throw error;
  logger.warn(
    `Invalid Portal timeout configuration; using safe direct timeout ${safeDirectTimeoutMs}ms: ${formatUnknownError(error)}`,
  );
  portalDirectAgentTimeoutMs = safeDirectTimeoutMs;
  validatePortalRuntimeTimeouts(portalDirectAgentTimeoutMs, PORTAL_EXECUTION_BUDGET_MS);
}
export const PORTAL_DIRECT_AGENT_TIMEOUT_MS = portalDirectAgentTimeoutMs;
const AGENT_EVALUATION_CASE_TIMEOUT_MS = Number(process.env.AGENT_EVAL_CASE_TIMEOUT_MS) || 0;

export function validatePortalRuntimeTimeouts(directAgentTimeoutMs: number, executionBudgetMs: number): void {
  if (!Number.isInteger(directAgentTimeoutMs) || directAgentTimeoutMs <= 0) {
    throw new Error(`PORTAL_DIRECT_AGENT_TIMEOUT_MS must be a positive integer: ${directAgentTimeoutMs}`);
  }
  if (!Number.isInteger(executionBudgetMs) || executionBudgetMs <= 0) {
    throw new Error(`PORTAL_EXECUTION_BUDGET_MS must be a positive integer: ${executionBudgetMs}`);
  }
  if (directAgentTimeoutMs >= executionBudgetMs) {
    throw new Error(
      `PORTAL_DIRECT_AGENT_TIMEOUT_MS (${directAgentTimeoutMs}) must be less than PORTAL_EXECUTION_BUDGET_MS (${executionBudgetMs})`,
    );
  }
}

function resolvePositiveTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer: ${raw}`);
  }
  return value;
}

// 与 generic-automation-runner 的 GENERIC_AUTOMATION_MAX_TOOL_CALLS 同步调整
//（2026-08-26：10 -> 30）。此处是硬顶：低于 runner 值会把任务预算压回去。
const INTERNAL_AUTOMATION_MAX_STEPS = 30;
// 2026-08-27：480s → 570s（mgreplay 回放实测 glm-5.3-flash 三步 ~480s，最终
// JSON 步差 ~90s 被掐）。570 + 300 兜底 + 30 提交 = 900s 恰为 15 分钟租约；
// 兜底仅在 attempt 早期失败时发生，全时长 attempt 后无兜底属预期。
const INTERNAL_AUTOMATION_ATTEMPT_TIMEOUT_MS = 570_000;
const INTERNAL_AUTOMATION_FALLBACK_RESERVE_MS = 300_000;
// 共创期不设限观测开关（owner 2026-08-27）：AUTOMATION_UNLIMITED=1 仅注入
// 回放/评测进程环境，不进任何生产 .env。开启后 attempt/步数放宽到观测级
//（步数 50 对齐 run-turn 守卫上限），租约由 AUTOMATION_TASK_LEASE_MS 同步放大。
function internalAutomationCeilings(): { maxSteps: number; attemptTimeoutMs: number } {
  return process.env.AUTOMATION_UNLIMITED === "1"
    ? { maxSteps: 50, attemptTimeoutMs: 3_600_000 }
    : { maxSteps: INTERNAL_AUTOMATION_MAX_STEPS, attemptTimeoutMs: INTERNAL_AUTOMATION_ATTEMPT_TIMEOUT_MS };
}

/** Service-owned limits for generic automation ACP turns. */
export function resolveInternalAutomationBudget(input: {
  channel: string;
  taskType?: string;
  maxToolCalls?: unknown;
  attemptTimeoutMs?: unknown;
  fallbackMinRemainingMs?: unknown;
}): { enabled: boolean; maxSteps: number; attemptTimeoutMs?: number; fallbackMinRemainingMs: number } {
  const enabled = input.channel === "automation" && input.taskType === "automation-execution";
  if (!enabled) return { enabled: false, maxSteps: 20, fallbackMinRemainingMs: 120_000 };
  const ceilings = internalAutomationCeilings();
  const requestedMaxSteps = typeof input.maxToolCalls === "number" && Number.isFinite(input.maxToolCalls)
    ? Math.floor(input.maxToolCalls)
    : ceilings.maxSteps;
  const requestedAttemptTimeout = typeof input.attemptTimeoutMs === "number" && Number.isFinite(input.attemptTimeoutMs)
    ? Math.floor(input.attemptTimeoutMs)
    : ceilings.attemptTimeoutMs;
  const requestedReserve = typeof input.fallbackMinRemainingMs === "number" && Number.isFinite(input.fallbackMinRemainingMs)
    ? Math.floor(input.fallbackMinRemainingMs)
    : INTERNAL_AUTOMATION_FALLBACK_RESERVE_MS;
  return {
    enabled: true,
    maxSteps: Math.min(ceilings.maxSteps, Math.max(1, requestedMaxSteps)),
    attemptTimeoutMs: Math.min(ceilings.attemptTimeoutMs, Math.max(1, requestedAttemptTimeout)),
    fallbackMinRemainingMs: Math.max(1, requestedReserve),
  };
}

export interface RuntimeAgent {
  agentId: string;
  agentName: string;
  capabilities: string[];
  handleMessage(message: AgentMessage): Promise<AgentResponse>;
}

export function createRuntimeAgent(): RuntimeAgent {
  return {
    agentId: process.env.AGENT_ID || "invest-agent",
    agentName: process.env.AGENT_NAME || "投资选股助手",
    capabilities: [
      "chat",
      "portfolio",
      "watchlist",
      "screening",
      "alert",
      "review",
      "market_data",
      "stock_plan",
    ],

    async handleMessage(message: AgentMessage): Promise<AgentResponse> {
      const text = message.content.text;
      if (!text) {
        return textResponse("请发送文字消息");
      }

      logger.info(`Agent 主链路收到消息: ${text.slice(0, 100)}`);
      const startedAt = Date.now();
      const conversationId = String(
        message.context?.conversationId || message.from || "invest-agent"
      );
      const channel = String(message.context?.channel || "unknown");
      const userId = String(message.context?.userId || DEFAULT_USER_ID);
      const mode = "chat";
      const cancelSignal = message.context?._cancelSignal instanceof AbortSignal
        ? message.context._cancelSignal
        : undefined;
      // D25/W1: per-turn model selection. Explicit model locks in; empty or
      // "auto" routes through the health-gated auto chain.
      const requestedModel = typeof message.context?.model === "string" && message.context.model.trim()
        ? message.context.model.trim()
        : undefined;
      const hasImageTurn = Array.isArray(message.context?.attachments)
        && message.context.attachments.some((item) => {
          const record = item as Record<string, unknown> | null;
          const mime = typeof record?.mimeType === "string" ? record.mimeType : typeof record?.type === "string" ? record.type : "";
          return mime.startsWith("image/");
        });
      const autoRoute = !requestedModel || requestedModel === "auto"
        ? resolveAutoModel({ hasImage: hasImageTurn })
        : undefined;
      let selectedModel = requestedModel && requestedModel !== "auto" ? requestedModel : autoRoute?.model;
      const modelSource = requestedModel && requestedModel !== "auto" ? "user-selection" : "auto";
      // T-327 取证：catch 里拿不到 try 内的 const，提前挂一个可写的引用。
      let promptTextForTrace: string | undefined;

      try {
        if (cancelSignal?.aborted) throw new Error("TASK_CANCELLED");
        const userChannel: UserContext["channel"] =
          channel === "weixin-mobile" || channel === "dashboard" || channel === "api" || channel === "web" ? channel : "api";
        const userContext: UserContext = {
          userId,
          projectId: message.context?.projectId ? String(message.context.projectId) : undefined,
          instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
          instanceExpansionPath: message.context?.instanceExpansionPath ? String(message.context.instanceExpansionPath) : undefined,
          workspacePath: message.context?.workspacePath ? String(message.context.workspacePath) : undefined,
          taskType: message.context?.taskType ? String(message.context.taskType) : undefined,
          expectedReviewKind: message.context?.expectedReviewKind === "daily"
            || message.context?.expectedReviewKind === "weekly"
            || message.context?.expectedReviewKind === "monthly"
            ? message.context.expectedReviewKind
            : undefined,
          expectedReviewKey: message.context?.expectedReviewKey ? String(message.context.expectedReviewKey) : undefined,
          mcpAllowedTools: Array.isArray(message.context?.mcpAllowedTools)
            ? message.context.mcpAllowedTools.filter((item): item is string => typeof item === "string")
            : undefined,
          channel: userChannel,
          conversationId,
        };

        // O1: WeChat is not an onboarding channel. Users who have not finished
        // Portal initialization get light guidance instead of a full turn.
        if (userChannel === "weixin-mobile") {
          try {
            const store = new MastraUserPreferenceStore(userContext.userId, userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId), userContext.projectId ?? "invest-agent");
            const state = await store.readOnboardingState();
            const hasTypedTasks = await hasAnyTypedScheduledTask(userContext);
            if (!state?.completed_at && !hasTypedTasks) {
              return textResponse("欢迎！我已就绪。为了给你配置持仓、策略和复盘节奏，请先在电脑端登录 Portal 完成初始化（约 2 分钟），完成后我们就可以直接在这里对话了。");
            }
          } catch {
            // Preference read failures must not block the WeChat message path.
          }
        }
        const promptContext = await buildAgentPromptContext({
          userText: buildChannelForwardPrompt(text, message.context?.attachments)
            + (await isInitializationUnfinished(userContext) ? buildInitializationNotice() : ""),
          userContext,
          includeContextPacket: false,
        });
        promptTextForTrace = promptContext.promptText;
        // Multi-turn context: the authoritative conversation_messages rows for
        // this conversation, minus the already-persisted current turn. The
        // adapter appends the live user message itself.
        const turnRequestId = typeof message.context?.requestId === "string" ? message.context.requestId : undefined;
        const recentHistory = loadConversationHistory({
          conversationId,
          excludeRequestId: turnRequestId ?? message.id,
          excludeCurrentText: text,
        });
        const coherenceInstanceId = userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId);
        const coherenceContext: {
          status: string;
          text?: string;
          checkpointMessageId?: string;
        } = isConversationWorkingStateEnabled(coherenceInstanceId)
          ? buildConversationCoherenceContext({
              conversationId,
              scope: {
                userId: userContext.userId,
                projectId: userContext.projectId ?? "invest-agent",
                instanceId: coherenceInstanceId,
              },
              userText: text,
              excludeRequestId: turnRequestId ?? message.id,
            })
          : { status: "disabled" as const };
        const history = coherenceContext.text
          // This context is derived from user-controlled conversation text. It
          // must stay at user priority and never be promoted into system instructions.
          ? [{ role: "user" as const, content: coherenceContext.text }, ...recentHistory]
          : recentHistory;
        const mastraTools = await createMastraToolMap({
          ...userContext,
          instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId),
          // Explicit turn correlation so service-tool audits link to the trace
          // without time-proximity guessing (WP3 diagnostic chain).
          traceId: message.id,
          runId: typeof message.context?.runId === "string" ? message.context.runId : undefined,
          taskId: typeof message.context?.taskId === "string" ? message.context.taskId : undefined,
        });
        const workspaceScope = {
          userId: userContext.userId,
          projectId: userContext.projectId ?? "invest-agent",
          instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId),
        };
        // 授权即清单：带 mcpAllowedTools 的轮次（通用自动化）只下发授权的服务
        // 工具 schema（2026-08-27 glm 卡死定性：90 工具/38.7k 输入 → 思考型
        // 模型每步思考超时）。外部 MCP 数据面与 workspace/skill 不在此裁剪。
        const grantedServiceTools = filterServiceToolsByGrant(mastraTools, userContext.mcpAllowedTools);
        // This returns undefined unless a service-owned bootstrap explicitly
        // registered an isolated project root for the authenticated scope.
        const scopedWorkspace = await createRegisteredMastraWorkspace({
          scope: workspaceScope,
          bindings: await getMastraBindings(),
        });
        const externalMcp = await resolveExternalMastraToolsets("interactive");
        const observedToolsets = withExternalToolCallObserver(externalMcp.toolsets, {
          userId,
          projectId: userContext.projectId ?? "invest-agent",
          instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userId),
          conversationId,
          runId: turnRequestId ?? message.id,
        });
        try {
          // Generic automation runs carry service-owned internal budget hints.
          // They are intentionally ignored for interactive/API messages and
          // capped here so a prompt cannot raise the runtime ceiling.
          const automationBudget = resolveInternalAutomationBudget({
            channel,
            taskType: userContext.taskType,
            maxToolCalls: message.context?._automationMaxToolCalls,
            attemptTimeoutMs: message.context?._attemptTimeoutMs,
            fallbackMinRemainingMs: message.context?._fallbackMinRemainingMs,
          });
          const genericAutomationExecution = automationBudget.enabled;
          const maxSteps = automationBudget.maxSteps;
          const inlineImages = await loadImageAttachmentParts(message.context?.attachments, userContext.workspacePath);
          const executionDeadlineMs = typeof message.context?._executionDeadlineAt === "string"
            ? Date.parse(message.context._executionDeadlineAt)
            : Number.NaN;
          const channelTimeoutMs = userChannel === "weixin-mobile"
            ? WEIXIN_DIRECT_AGENT_TIMEOUT_MS
            : userChannel === "web"
              ? PORTAL_DIRECT_AGENT_TIMEOUT_MS
              : AGENT_EVALUATION_CASE_TIMEOUT_MS > 0 ? AGENT_EVALUATION_CASE_TIMEOUT_MS : undefined;
          const initialBudget = resolveTurnExecutionBudget({
            executionDeadlineMs,
            configuredTimeoutMs: genericAutomationExecution ? automationBudget.attemptTimeoutMs : channelTimeoutMs,
            firstTokenTimeoutMs: Number(process.env.MASTRA_AUTO_FIRST_TOKEN_TIMEOUT_MS ?? 45_000),
          });
          if (initialBudget.expired) throw new Error("TASK_CANCELLED: execution deadline exceeded");
          const turnParams = {
            conversationId,
            text: promptContext.promptText,
            messageId: message.id,
            history,
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(inlineImages.length > 0 ? { images: inlineImages } : {}),
            timeoutMs: initialBudget.timeoutMs,
            userContext,
            requestContext: workspaceScope,
            toolsets: observedToolsets,
            signal: cancelSignal,
            maxSteps,
            ...(message.context?._onProgress ? { onProgress: message.context._onProgress as import("./protocol.js").AgentTurnProgressCallback } : {}),
          } as Parameters<typeof runMastraTurn>[0];
          const turnDeps = { agentOptions: { instructions: buildAgentInstructions({ channel: userChannel }), tools: grantedServiceTools, ...(scopedWorkspace ? { workspace: scopedWorkspace } : {}) } };
          // W1-P3 自动路由轮内兜底：首字超时（45s）或可重试的上游错误时，沿自动链换下一顺位模型重试。
          // 2026-08-18 加强：从只允许一跳扩展到走完整条自动链（默认最多 3 次兜底），
          // 并把网关 upstream 错误（如 Upstream error: 400）纳入可重试签名。
          const AUTO_FIRST_TOKEN_TIMEOUT_MS = Number(process.env.MASTRA_AUTO_FIRST_TOKEN_TIMEOUT_MS ?? 45_000);
          const AUTO_FALLBACK_MAX = Math.max(1, Number(process.env.MASTRA_AUTO_FALLBACK_MAX ?? 3));
          const AUTO_FALLBACK_MIN_REMAINING_MS = genericAutomationExecution
            ? automationBudget.fallbackMinRemainingMs
            : Math.max(1, Number(process.env.MASTRA_AUTO_FALLBACK_MIN_REMAINING_MS ?? 120_000));
          const isRetriableTurnError = (text: string) => {
            const normalized = text.toLowerCase();
            return normalized.includes("mastra_first_token_timeout")
              || normalized.includes("mastra_turn_timeout")
              || normalized.includes("mastra_empty_response")
              || normalized.includes("upstream")
              || normalized.includes("fetch failed")
              || normalized.includes("econnreset");
          };
          let mastraResult: Awaited<ReturnType<typeof runMastraTurn>>;
          if (!autoRoute) {
            mastraResult = await runMastraTurn(turnParams, turnDeps);
          } else {
            const excluded: string[] = [];
            let attemptModel = selectedModel ?? "";
            let attempt = 0;
            for (;;) {
              try {
                const attemptBudget = resolveTurnExecutionBudget({
                  executionDeadlineMs,
                  configuredTimeoutMs: turnParams.timeoutMs,
                  firstTokenTimeoutMs: AUTO_FIRST_TOKEN_TIMEOUT_MS,
                });
                if (attemptBudget.expired) {
                  throw new Error("TASK_CANCELLED: execution deadline exceeded");
                }
                mastraResult = await runMastraTurn(
                  { ...turnParams, model: attemptModel, timeoutMs: attemptBudget.timeoutMs, firstTokenTimeoutMs: attemptBudget.firstTokenTimeoutMs },
                  turnDeps,
                );
                break;
              } catch (error) {
                const errorText = formatUnknownError(error);
                recordModelFeedback(attemptModel, { ok: false });
                excluded.push(attemptModel);
                const next = resolveAutoModel({ hasImage: hasImageTurn, exclude: excluded });
                const canRetry = attempt < AUTO_FALLBACK_MAX
                  && !excluded.includes(next.model)
                  && isRetriableTurnError(errorText)
                  && !(cancelSignal?.aborted ?? false)
                  && hasExecutionBudgetForFallback({ executionDeadlineMs, minimumRemainingMs: AUTO_FALLBACK_MIN_REMAINING_MS });
                if (!canRetry) throw error;
                attempt += 1;
                logger.warn(`自动路由轮内兜底（第 ${attempt}/${AUTO_FALLBACK_MAX} 跳）：${attemptModel} 失败（${errorText.slice(0, 120)}），换用 ${next.model} 重试`);
                const progressCallback = message.context?._onProgress as import("./protocol.js").AgentTurnProgressCallback | undefined;
                progressCallback?.({
                  kind: "model_fallback",
                  at: new Date().toISOString(),
                  seq: 0,
                  conversationId,
                  message: `${attemptModel} 失败（${errorText.slice(0, 80)}），换用 ${next.model} 重试`,
                });
                attemptModel = next.model;
                selectedModel = attemptModel;
              }
            }
          }
          const postProcessed = await postProcessAgentReply({ reply: mastraResult.text, userContext, originalText: text });
          const extractedVisuals = userChannel === "web"
            ? extractInlineSvgVisuals(postProcessed.finalReply)
            : { text: postProcessed.finalReply, visuals: [] };
          const deduped = dedupeRepeatedCustomerText(extractedVisuals.text);
          const cleaned = userChannel === "weixin-mobile" ? sanitizeWeixinCustomerText(deduped) : sanitizeCustomerText(deduped);
          await recordAgentTrace({
            traceId: message.id,
            runId: typeof message.context?.runId === "string" ? message.context.runId : undefined,
            taskId: typeof message.context?.taskId === "string" ? message.context.taskId : undefined,
            userId, projectId: userContext.projectId, instanceId: userContext.instanceId,
            conversationId, messageId: message.id, channel, userText: text,
            promptText: promptContext.promptText, replyTextRaw: postProcessed.finalReply,
            replyTextSanitized: cleaned, mode,
            status: "success", elapsedMs: Date.now() - startedAt, usage: mastraResult.usage,
            agentBackend: "mastra", agentModel: mastraResult.model, toolCalls: mastraResult.toolCalls,
            modelSource, firstTokenMs: mastraResult.firstTokenMs,
            reviewContextSummary: {
              budget: mastraResult.budget,
              coherenceState: {
                status: coherenceContext.status,
                checkpointMessageId: coherenceContext.checkpointMessageId,
                injectedChars: coherenceContext.text?.length ?? 0,
              },
            },
          });
          return textResponse(cleaned, true, extractedVisuals.visuals.length > 0 ? { inlineVisuals: extractedVisuals.visuals } : undefined);
        } finally {
          await externalMcp.disconnect();
          await scopedWorkspace?.destroy?.();
        }
      } catch (error) {
        logger.error("Agent 运行失败:", error);
        const errorMessage = formatUnknownError(error);
        const taskError = classifyTaskError(errorMessage);
        const isBusy = errorMessage.includes("MASTRA_TURN_BUSY");
        const executionErrorCode = isBusy
          ? "MASTRA_TURN_BUSY"
          : taskError.code === "TASK_TIMEOUT"
            ? "MASTRA_TURN_TIMEOUT"
            : taskError.code;
        await recordAgentTrace({
          traceId: message.id,
          runId: typeof message.context?.runId === "string" ? message.context.runId : undefined,
          taskId: typeof message.context?.taskId === "string" ? message.context.taskId : undefined,
          userId,
          projectId: message.context?.projectId ? String(message.context.projectId) : undefined,
          instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
          conversationId,
          messageId: message.id,
          channel,
          userText: text,
          promptText: promptTextForTrace,
          mode,
          reviewContextSummary: undefined,
          status: errorMessage.includes("超时") ? "timeout" : "error",
          errorMessage,
          elapsedMs: Date.now() - startedAt,
          agentBackend: "mastra",
          // T-327 取证：失败轮次也要留下实际模型与已发生的工具调用
          //（2026-08-19 mg 复盘事故排查时 error trace 全空是最大盲区）。
          agentModel: selectedModel || (error as { model?: string }).model,
          toolCalls: (error as { toolCalls?: unknown[] }).toolCalls,
          firstTokenMs: (error as { firstTokenMs?: number }).firstTokenMs,
          modelSource,
        });
        if (isBusy) {
          return textResponse(
            "上一条消息还在处理中，我处理完会直接回复。你可以稍等一下再发下一条。",
            true,
            { executionStatus: "failed", executionErrorCode, executionErrorCategory: "transient", executionRetryable: true },
          );
        }
        return textResponse(
          taskError.userMessage,
          true,
          {
            executionStatus: "failed",
            executionErrorCode,
            executionErrorCategory: taskError.category,
            executionRetryable: taskError.retryable,
          },
        );
      }
    },
  };
}

async function postProcessAgentReply(input: {
  reply: string;
  userContext: UserContext;
  originalText: string;
}) {
  return { finalReply: input.reply };
}

const MAX_INLINE_IMAGES_PER_TURN = 4;
const DEFAULT_IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Load image attachments from the turn workspace so vision-capable models
 * receive them as inline image parts. Failures degrade to a text-only turn
 * (the attachment prompt still lists the file) instead of failing the turn.
 */
async function loadImageAttachmentParts(
  attachments: unknown,
  workspacePath: string | undefined,
): Promise<Array<{ mimeType: string; base64: string }>> {
  if (!Array.isArray(attachments) || !workspacePath || attachments.length === 0) return [];
  const maxBytes = Number(process.env.AGENT_IMAGE_ATTACHMENT_MAX_BYTES) || DEFAULT_IMAGE_ATTACHMENT_MAX_BYTES;
  const workspaceRoot = path.resolve(workspacePath);
  const images: Array<{ mimeType: string; base64: string }> = [];
  for (const item of attachments) {
    if (images.length >= MAX_INLINE_IMAGES_PER_TURN) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType : "";
    const relativePath = typeof record.relativePath === "string" ? record.relativePath : "";
    const label = typeof record.fileName === "string" ? record.fileName : relativePath || "(unknown)";
    if (!mimeType.startsWith("image/") || !relativePath) continue;
    if (relativePath.includes("..") || path.isAbsolute(relativePath)) {
      logger.warn(`图片附件路径异常，跳过内联: ${relativePath}`);
      continue;
    }
    const absolute = path.join(workspaceRoot, relativePath);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      if (info.size > maxBytes) {
        logger.warn(`图片附件超过内联上限（${info.size}/${maxBytes} 字节），跳过: ${label}`);
        continue;
      }
      images.push({ mimeType, base64: (await readFile(absolute)).toString("base64") });
    } catch (error) {
      logger.warn(`图片附件读取失败（降级为纯文本轮）: ${label}: ${(error as Error).message}`);
    }
  }
  return images;
}

function buildChannelForwardPrompt(text: string, attachmentsInput?: unknown): string {
  // Channel presentation policy lives in the agent instructions now; the
  // user-message wrapper only frames attachments that need interpretation.
  const attachmentContext = buildAttachmentPrompt(attachmentsInput);
  if (!attachmentContext) return text;
  return [
    attachmentContext,
    "【用户消息】",
    text,
  ].join("\n");
}

function buildAttachmentPrompt(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const lines = input
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const data = item as Record<string, unknown>;
      const type = String(data.type || "");
      const mimeType = String(data.mimeType || "");
      const fileName = String(data.fileName || "");
      const attachmentId = String(data.id || data.attachmentId || "");
      const filePath = String(data.path || "");
      if (!attachmentId || !filePath) return null;
      return `${index + 1}. attachment_id=${attachmentId} type=${type || "unknown"} mime=${mimeType || "unknown"} fileName=${fileName || "-"} localPath=${filePath}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return null;
  return [
    "【附件上下文】用户随消息发送了附件，附件已保存到当前 workspace 的受控目录。",
    "图片附件：已作为图片内容直接附在本条消息中，请直接查看图片识别内容；不要用文件工具读取图片字节（读出来的是二进制文本，没有意义）。如附件是持仓/观察仓/交易记录截图，请先识别成结构化草案，列出股票名称/代码/数量或金额/成本价/关注原因/不确定字段，并明确要求用户确认后再写入；不要直接落库。",
    "文档附件：PDF/Word/PPT/Excel/CSV/html/md/txt 等，若当前会话接入了文档解析工具（如 mineru），优先调用该工具把附件解析为结构化文本，不要自己写解析代码；解析后请先概括内容，再提取和投资决策相关的结构化信息、事实依据和不确定字段。",
    "所有附件：不要向用户暴露 localPath 或内部目录；如果用户明确要求保存附件、或要求基于附件创建自动化任务，先调用 assets.attachment.save 将 attachment_id 保存到“我的文件”，再使用返回的 assetId；不要手工读取或编码附件字节。若只是分析附件，保持临时状态。",
    ...lines,
  ].join("\n");
}

export function buildChannelContextInstruction(channel: UserContext["channel"]): string | null {
  if (channel === "weixin-mobile") {
    return [
      "【通道上下文】这是一条来自微信用户的消息，回复会直接发回微信。",
      "渠道只影响呈现方式，不改变投资助手身份、投资纪律、事实标准或结论口径。",
      "请使用适合微信阅读的简洁 Markdown，例如分段、列表、重点加粗或必要的表格；不要输出执行过程、内部路径或调试信息。",
    ].join("");
  }
  if (channel === "web") {
    return [
      "【通道上下文】这是一条来自门户网页聊天的消息。",
      "这是同一个 workspace-backed 投资助手，必须沿用同一套投资纪律、事实标准和结论口径；渠道只影响呈现方式。",
      "网页端可以稍微更结构化，但不要输出执行过程、内部路径或调试信息。",
      `结果数量规则：${OUTPUT_VOLUME_POLICY}`,
      "门户表格交付规则：只有数据行不超过 7 条且列不超过 5 列时，才在回复正文使用 Markdown 表格。任何一个维度超限（超过 7 条数据行或超过 5 列）时，必须调用 `spreadsheet.create` 生成真实 .xlsx 文件交付（服务端会自动把附件卡片挂到回复下方，含预览与下载）；正文只保留简短结论和文件说明，绝不能用 CSV 代码块或超限 Markdown 表格代替文件。表头不计入 7 条数据行。",
      "如果用户要求制作、生成、发送、下载或复制 Excel/表格，必须调用 `spreadsheet.create` 生成真实 .xlsx；不要声称当前会话没有 Excel 二进制写入能力，也不要把本地脚本或伪造扩展名当成交付。将列名和数据行作为结构化参数传入，工具成功后在回复中告知用户文件已生成并给出文件名即可；文件以附件卡片形式出现在回复下方（可预览/下载），此时**尚未**保存到「我的文件」——正文提及可点卡片上的「保存到我的文件」留存即可，不要声称已入库；只有用户在卡片上保存或明确要求存入后才算入库。正文不要放置任何下载链接或路径（包括 sandbox:/mnt/data/…）。",
      "生成 Excel 表格时应使用清晰表头、冻结表头、筛选和适合阅读的列宽。",
      "门户内联图示的选择原则是“看比读更划算时才给”，不是等用户每次都说画图。以下情形默认主动给一张简洁 SVG：教学/讲解/介绍投资概念；两个或以上对象或方案的比较；行业景气、估值、风险或投资方法的阶段/周期；筛选漏斗；多条件决策路径；已有预案的情景分支。默认最多一张；只有用户明确要求多图、两张图或分别画图，或者单张图无法清晰表达两个彼此独立的分析维度时，才可给第二张。复杂话题本身不是生成第二张图的理由。用户明确要求“图、示意图、流程图、可视化、diagram、chart”时同样必须给。纯词义解释、单一事实或简短行情问答、文字已足够清楚的回答，以及用户明确要求文件/报告/下载/HTML 时，不要生成内联图；后者走现有 workspace 文件/artifact 路径。图示必须基于本轮已取证事实；概念图要明确为概念框架，不能伪造行情或数据。",
      "门户图示协议是硬约束：凡是决定生成内联图示的情况，只能使用下方的 `invest-svg` 内联图示，绝不能创建或发布 HTML、SVG、PNG 等 workspace 文件，也不得调用 artifacts.publish。每个图示必须用独立的 ```invest-svg 代码块包裹；代码块内只能有一个以 <svg 开始、带 viewBox=\"0 0 宽 高\" 的静态 SVG。图中必须显式设置填充色，必须包含简短 <title>；禁止 HTML、脚本、外链、图片、动画或交互。最多 2 张。图示只辅助正文，正文仍须给出事实、判断、行动和验证条件。",
      "门户文件交付规则是硬约束：仅在以下三种情况把文件作为本轮回复的 artifact 交付：用户明确要求发送、提供链接或下载某个文件；本轮实际新建或生成了文件；本轮实际修改了用户 Workspace 中的文件。仅仅读取、引用、提到、在历史消息中出现，或文件本来就存在于 Workspace，都不构成本轮交付条件。只有文件真实成功创建或修改、且 artifact 发布成功后，才能在回复中告知用户文件可用；不要编造链接、不要只输出绝对路径，也不要暴露内部路径。对本轮交付的文件按文件路径去重；文件写入失败、修改未生效或已删除时不要发送。开发期 `config/` 下的用户自有原始配置文件可以直接交付；当前已开放的 Workspace 写入工具会自动发布本轮实际修改的 `config/` 文件并返回一个或多个 artifact descriptor，必须使用所有成功返回的 descriptor，不要重复调用 `artifacts.publish`。`portfolio.apply_changes` 成功后服务会自动发布并绑定 `config/portfolio.yaml`；其他领域写入工具返回的 `artifacts` 同样适用。若是 Agent 直接新建或修改 `reports/`、`config/` 文件且工具没有自动发布，必须对每个变更路径调用 `artifacts.publish`；若当前 artifact 能力不覆盖该文件，不要伪造文件链接或绕过服务层。",
    ].join("");
  }
  return null;
}

export const __test__ = { isInitializationUnfinished, buildInitializationNotice };
