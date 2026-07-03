import { randomUUID } from "node:crypto";
import type { AcpMessage, AcpResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { getCurrentAcpAgent, loadCurrentBackendId, type AcpModelTier } from "./stdio-agent.js";
import { dedupeRepeatedCustomerText, sanitizeCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { recordAcpTrace } from "./trace.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";

const WEIXIN_DIRECT_ACP_TIMEOUT_MS =
  Number(process.env.WEIXIN_DIRECT_ACP_TIMEOUT_MS) || 600_000;

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

      logger.info(`微信直通 ACP 主链路: ${text.slice(0, 100)}`);
      const startedAt = Date.now();
      const conversationId = String(
        message.context?.conversationId || message.from || "invest-agent"
      );
      const channel = String(message.context?.channel || "unknown");
      const userId = String(message.context?.userId || DEFAULT_USER_ID);
      const mode = "chat";

      try {
        const userChannel: UserContext["channel"] =
          channel === "weixin-mobile" || channel === "dashboard" || channel === "api" ? channel : "api";
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
          userText: buildChannelForwardPrompt(text, userContext),
          userContext,
        });
        const modelTier = resolveChatModelTier(text);
        const acpAgent = await getCurrentAcpAgent(userContext.workspacePath, { modelTier });
        const acpResult = await acpAgent.chatWithUsage({
          conversationId,
          text: promptContext.promptText,
          messageId: randomUUID(),
          timeoutMs: userChannel === "weixin-mobile" ? WEIXIN_DIRECT_ACP_TIMEOUT_MS : undefined,
          cwd: userChannel === "weixin-mobile" ? userContext.workspacePath : undefined,
        });
        const postProcessed = await postProcessAcpReply({
          reply: acpResult.text,
          userContext,
          originalText: text,
        });
        const deduped = dedupeRepeatedCustomerText(postProcessed.finalReply);
        const cleaned = sanitizeCustomerText(deduped);
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
        });
        return textResponse(cleaned);
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
        });
        if (isBusy) {
          return textResponse("上一条消息还在处理中，我处理完会直接回复。你可以稍等一下再发下一条。");
        }
        return textResponse("这次分析生成超时了，请稍后再试。我已记录本次异常，方便继续排查。");
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

function buildChannelForwardPrompt(text: string, context: UserContext): string {
  if (context.channel !== "weixin-mobile") return text;
  return [
    "【通道上下文】这是一条来自微信用户的消息；你的回复会直接发回该用户微信。必须使用适合微信阅读的 Markdown 提升可读性，例如分段、列表、重点加粗或必要的表格；但请按内容场景选择，不要机械套用复杂格式。不要输出执行过程、内部路径或调试信息。",
    "【用户消息】",
    text,
  ].filter(Boolean).join("\n");
}

function resolveChatModelTier(text: string): AcpModelTier {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "simple";
  if (
    /(复盘|选股|筛选|筛股|研究|研判|分析.+股票|股票.+分析|行业.+分析|主题.+分析|估值|财报|公告|交易计划|出预案|策略匹配|投资模型)/i.test(normalized)
  ) {
    return "complex";
  }
  return "simple";
}
