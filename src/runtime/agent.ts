import type { AgentMessage, AgentResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
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
import { createMastraToolMap } from "../mastra/tools/mastra-tools.js";
import { getMastraBindings } from "../mastra/bindings.js";
import { runMastraTurn } from "../mastra/run-turn.js";
import { createRegisteredMastraWorkspace } from "../mastra/workspace-registry.js";
import { resolveExternalMastraToolsets } from "../mastra/external-mcp.js";
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
      // D25: per-turn model selection from the Portal composer. Empty or
      // absent falls through to the gateway default model.
      const selectedModel = typeof message.context?.model === "string" && message.context.model.trim()
        ? message.context.model.trim()
        : undefined;

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
          userText: buildChannelForwardPrompt(text, userContext, message.context?.attachments)
            + (await isInitializationUnfinished(userContext) ? buildInitializationNotice() : ""),
          userContext,
          includeContextPacket: false,
        });
        const mastraTools = await createMastraToolMap({ ...userContext, instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId) });
        const workspaceScope = {
          userId: userContext.userId,
          projectId: userContext.projectId ?? "invest-agent",
          instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId),
        };
        // This returns undefined unless a service-owned bootstrap explicitly
        // registered an isolated project root for the authenticated scope.
        const scopedWorkspace = await createRegisteredMastraWorkspace({
          scope: workspaceScope,
          bindings: await getMastraBindings(),
        });
        const externalMcp = await resolveExternalMastraToolsets("interactive");
        try {
          const mastraResult = await runMastraTurn({
            conversationId,
            text: promptContext.promptText,
            messageId: message.id,
            ...(selectedModel ? { model: selectedModel } : {}),
            timeoutMs: userChannel === "weixin-mobile"
              ? WEIXIN_DIRECT_AGENT_TIMEOUT_MS
              : userChannel === "web"
                ? PORTAL_DIRECT_AGENT_TIMEOUT_MS
                : AGENT_EVALUATION_CASE_TIMEOUT_MS > 0 ? AGENT_EVALUATION_CASE_TIMEOUT_MS : undefined,
            userContext,
            requestContext: workspaceScope,
            toolsets: externalMcp.toolsets,
            signal: cancelSignal,
            maxSteps: 20,
          }, { agentOptions: { tools: mastraTools, ...(scopedWorkspace ? { workspace: scopedWorkspace } : {}) } });
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
            replyTextSanitized: cleaned, mode, reviewContextSummary: { budget: mastraResult.budget },
            status: "success", elapsedMs: Date.now() - startedAt, usage: mastraResult.usage,
            agentBackend: "mastra", agentModel: mastraResult.model, toolCalls: mastraResult.toolCalls,
            modelSource: selectedModel ? "user-selection" : "runtime-config",
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
          mode,
          reviewContextSummary: undefined,
          status: errorMessage.includes("超时") ? "timeout" : "error",
          errorMessage,
          elapsedMs: Date.now() - startedAt,
          agentBackend: "mastra",
          modelSource: "runtime-config",
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

function buildChannelForwardPrompt(text: string, context: UserContext, attachmentsInput?: unknown): string {
  const channelContext = buildChannelContextInstruction(context.channel);
  const attachmentContext = buildAttachmentPrompt(attachmentsInput);
  if (!channelContext && !attachmentContext) return text;
  return [
    channelContext,
    attachmentContext,
    "【用户消息】",
    text,
  ].filter(Boolean).join("\n");
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
    "图片附件：可以读取图片并识别截图内容；如附件是持仓/观察仓/交易记录截图，请先识别成结构化草案，列出股票名称/代码/数量或金额/成本价/关注原因/不确定字段，并明确要求用户确认后再写入；不要直接落库。",
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
      "如果用户要求制作、生成、发送、下载或复制 Excel/表格，必须调用 `spreadsheet.create` 生成真实 .xlsx；不要声称当前会话没有 Excel 二进制写入能力，也不要把本地脚本或伪造扩展名当成交付。将列名和数据行作为结构化参数传入，工具成功后在回复中告知用户文件已生成并给出文件名即可；文件以附件卡片形式出现在回复下方，正文不要放置任何下载链接或路径（包括 sandbox:/mnt/data/…）。",
      "生成 Excel 表格时应使用清晰表头、冻结表头、筛选和适合阅读的列宽。",
      "门户内联图示的选择原则是“看比读更划算时才给”，不是等用户每次都说画图。以下情形默认主动给一张简洁 SVG：教学/讲解/介绍投资概念；两个或以上对象或方案的比较；行业景气、估值、风险或投资方法的阶段/周期；筛选漏斗；多条件决策路径；已有预案的情景分支。默认最多一张；只有用户明确要求多图、两张图或分别画图，或者单张图无法清晰表达两个彼此独立的分析维度时，才可给第二张。复杂话题本身不是生成第二张图的理由。用户明确要求“图、示意图、流程图、可视化、diagram、chart”时同样必须给。纯词义解释、单一事实或简短行情问答、文字已足够清楚的回答，以及用户明确要求文件/报告/下载/HTML 时，不要生成内联图；后者走现有 workspace 文件/artifact 路径。图示必须基于本轮已取证事实；概念图要明确为概念框架，不能伪造行情或数据。",
      "门户图示协议是硬约束：凡是决定生成内联图示的情况，只能使用下方的 `invest-svg` 内联图示，绝不能创建或发布 HTML、SVG、PNG 等 workspace 文件，也不得调用 artifacts.publish。每个图示必须用独立的 ```invest-svg 代码块包裹；代码块内只能有一个以 <svg 开始、带 viewBox=\"0 0 宽 高\" 的静态 SVG。图中必须显式设置填充色，必须包含简短 <title>；禁止 HTML、脚本、外链、图片、动画或交互。最多 2 张。图示只辅助正文，正文仍须给出事实、判断、行动和验证条件。",
      "门户文件交付规则是硬约束：仅在以下三种情况把文件作为本轮回复的 artifact 交付：用户明确要求发送、提供链接或下载某个文件；本轮实际新建或生成了文件；本轮实际修改了用户 Workspace 中的文件。仅仅读取、引用、提到、在历史消息中出现，或文件本来就存在于 Workspace，都不构成本轮交付条件。只有文件真实成功创建或修改、且 artifact 发布成功后，才能在回复中告知用户文件可用；不要编造链接、不要只输出绝对路径，也不要暴露内部路径。对本轮交付的文件按文件路径去重；文件写入失败、修改未生效或已删除时不要发送。开发期 `config/` 下的用户自有原始配置文件可以直接交付；当前已开放的 Workspace 写入工具会自动发布本轮实际修改的 `config/` 文件并返回一个或多个 artifact descriptor，必须使用所有成功返回的 descriptor，不要重复调用 `artifacts.publish`。`portfolio.apply_changes` 成功后服务会自动发布并绑定 `config/portfolio.yaml`；其他领域写入工具返回的 `artifacts` 同样适用。若是 Agent 直接新建或修改 `reports/`、`config/` 文件且工具没有自动发布，必须对每个变更路径调用 `artifacts.publish`；若当前 artifact 能力不覆盖该文件，不要伪造文件链接或绕过服务层。",
    ].join("");
  }
  return null;
}

export const __test__ = { isInitializationUnfinished, buildInitializationNotice };
