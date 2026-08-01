import type { AcpMessage, AcpResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { getCurrentAcpAgent, loadCurrentBackendId } from "./stdio-agent.js";
import { dedupeRepeatedCustomerText, sanitizeCustomerText, sanitizeWeixinCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { recordAcpTrace } from "./trace.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { extractInlineSvgVisuals } from "../services/inline-visuals.js";

const WEIXIN_DIRECT_ACP_TIMEOUT_MS =
  Number(process.env.WEIXIN_DIRECT_ACP_TIMEOUT_MS) || 600_000;
const ACP_EVALUATION_CASE_TIMEOUT_MS = Number(process.env.ACP_EVAL_CASE_TIMEOUT_MS) || 0;

export interface AcpAgent {
  agentId: string;
  agentName: string;
  capabilities: string[];
  handleMessage(message: AcpMessage): Promise<AcpResponse>;
}

export function createAgent(): AcpAgent {
  return {
    agentId: config.acp.agentId,
    agentName: config.acp.agentName,
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

    async handleMessage(message: AcpMessage): Promise<AcpResponse> {
      const text = message.content.text;
      if (!text) {
        return textResponse("请发送文字消息");
      }

      logger.info(`ACP 主链路收到消息: ${text.slice(0, 100)}`);
      const startedAt = Date.now();
      const conversationId = String(
        message.context?.conversationId || message.from || "invest-agent"
      );
      const channel = String(message.context?.channel || "unknown");
      const userId = String(message.context?.userId || DEFAULT_USER_ID);
      const mode = "chat";

      try {
        const userChannel: UserContext["channel"] =
          channel === "weixin-mobile" || channel === "dashboard" || channel === "api" || channel === "web" ? channel : "api";
        const activeBackend = await loadCurrentBackendId();
        const userContext: UserContext = {
          userId,
          projectId: message.context?.projectId ? String(message.context.projectId) : undefined,
          instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
          instanceExpansionPath: message.context?.instanceExpansionPath ? String(message.context.instanceExpansionPath) : undefined,
          workspacePath: message.context?.workspacePath ? String(message.context.workspacePath) : undefined,
          channel: userChannel,
          backend: activeBackend,
          conversationId,
        };

        const promptContext = await buildAcpPromptContext({
          userText: buildChannelForwardPrompt(text, userContext, message.context?.attachments),
          userContext,
          includeContextPacket: false,
        });
        const acpAgent = await getCurrentAcpAgent(userContext.workspacePath);
        const acpResult = await acpAgent.chatWithUsage({
          conversationId,
          text: promptContext.promptText,
          // Reuse the service message id so the ACP trace and external MCP observer
          // share one stable per-turn correlation key.
          messageId: message.id,
          timeoutMs: userChannel === "weixin-mobile"
            ? WEIXIN_DIRECT_ACP_TIMEOUT_MS
            : ACP_EVALUATION_CASE_TIMEOUT_MS > 0
              ? ACP_EVALUATION_CASE_TIMEOUT_MS
              : undefined,
          cwd: resolveAcpWorkspaceCwd(userContext),
          userContext,
        });
        const postProcessed = await postProcessAcpReply({
          reply: acpResult.text,
          userContext,
          originalText: text,
        });
        const extractedVisuals = userChannel === "web"
          ? extractInlineSvgVisuals(postProcessed.finalReply)
          : { text: postProcessed.finalReply, visuals: [] };
        const deduped = dedupeRepeatedCustomerText(extractedVisuals.text);
        const cleaned = userChannel === "weixin-mobile"
          ? sanitizeWeixinCustomerText(deduped)
          : sanitizeCustomerText(deduped);
        await recordAcpTrace({
          userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          messageId: message.id,
          channel,
          userText: text,
          promptText: promptContext.promptText,
          replyTextRaw: postProcessed.finalReply,
          replyTextSanitized: cleaned,
          mode,
          status: "success",
          elapsedMs: Date.now() - startedAt,
          usage: acpResult.usage,
          acpBackend: acpResult.backendId,
          acpModel: acpResult.model,
          mcpManifest: acpResult.mcpManifest,
          toolCalls: acpResult.toolCalls,
        });
        return textResponse(
          cleaned,
          true,
          extractedVisuals.visuals.length > 0 ? { inlineVisuals: extractedVisuals.visuals } : undefined,
        );
      } catch (error) {
        logger.error("转发 ACP 后端失败:", error);
        const errorMessage = formatUnknownError(error);
        const isBusy = errorMessage.includes("ACP_TURN_BUSY") || errorMessage.includes("turn.agent_busy");
        await recordAcpTrace({
          userId,
          projectId: message.context?.projectId ? String(message.context.projectId) : undefined,
          instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
          conversationId,
          messageId: message.id,
          channel,
          userText: text,
          mode,
          status: errorMessage.includes("超时") ? "timeout" : "error",
          errorMessage,
          elapsedMs: Date.now() - startedAt,
          acpBackend: config.acp.backend,
          acpModel: config.codex.model,
        });
        if (isBusy) {
          return textResponse("上一条消息还在处理中，我处理完会直接回复。你可以稍等一下再发下一条。");
        }
        if (errorMessage.includes("超时")) {
          return textResponse("这次分析生成超时了，请稍后再试。我已记录本次异常，方便继续排查。");
        }
        return textResponse("这次回复生成失败了，请稍后重试。我已记录本次异常，方便继续排查。");
      }
    },
  };
}

async function postProcessAcpReply(input: {
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
      const filePath = String(data.path || "");
      if (!filePath) return null;
      return `${index + 1}. type=${type || "unknown"} mime=${mimeType || "unknown"} fileName=${fileName || "-"} localPath=${filePath}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return null;
  return [
    "【附件上下文】用户随消息发送了附件，附件已保存到当前 workspace 的受控目录。",
    "图片附件：可以读取图片并识别截图内容；如附件是持仓/观察仓/交易记录截图，请先识别成结构化草案，列出股票名称/代码/数量或金额/成本价/关注原因/不确定字段，并明确要求用户确认后再写入；不要直接落库。",
    "文档附件：PDF/Word/PPT/Excel/CSV/html/md/txt 等，若当前会话接入了文档解析工具（如 mineru），优先调用该工具把附件解析为结构化文本，不要自己写解析代码；解析后请先概括内容，再提取和投资决策相关的结构化信息、事实依据和不确定字段。",
    "所有附件：不要向用户暴露 localPath 或内部目录；如果当前后端无法读取或解析附件，必须如实说明限制，不要编造附件内容。",
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
      "门户内联图示的选择原则是“看比读更划算时才给”，不是等用户每次都说画图。以下情形默认主动给一张简洁 SVG：教学/讲解/介绍投资概念；两个或以上对象或方案的比较；行业景气、估值、风险或投资方法的阶段/周期；筛选漏斗；多条件决策路径；已有预案的情景分支。默认最多一张；只有用户明确要求多图、两张图或分别画图，或者单张图无法清晰表达两个彼此独立的分析维度时，才可给第二张。复杂话题本身不是生成第二张图的理由。用户明确要求“图、示意图、流程图、可视化、diagram、chart”时同样必须给。纯词义解释、单一事实或简短行情问答、文字已足够清楚的回答，以及用户明确要求文件/报告/下载/HTML 时，不要生成内联图；后者走现有 workspace 文件/artifact 路径。图示必须基于本轮已取证事实；概念图要明确为概念框架，不能伪造行情或数据。",
      "门户图示协议是硬约束：凡是决定生成内联图示的情况，只能使用下方的 `invest-svg` 内联图示，绝不能创建或发布 HTML、SVG、PNG 等 workspace 文件，也不得调用 artifacts.publish。每个图示必须用独立的 ```invest-svg 代码块包裹；代码块内只能有一个以 <svg 开始、带 viewBox=\"0 0 宽 高\" 的静态 SVG。图中必须显式设置填充色，必须包含简短 <title>；禁止 HTML、脚本、外链、图片、动画或交互。最多 2 张。图示只辅助正文，正文仍须给出事实、判断、行动和验证条件。",
    ].join("");
  }
  return null;
}

function resolveAcpWorkspaceCwd(context: UserContext): string | undefined {
  return context.workspacePath || undefined;
}
