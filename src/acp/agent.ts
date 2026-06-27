import { randomUUID } from "node:crypto";
import type { AcpMessage, AcpResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { getCurrentAcpAgent, loadCurrentBackendId } from "./stdio-agent.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { recordAcpTrace } from "./trace.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import type { UserContext } from "../lib/user-context.js";

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
          projectType: message.context?.projectType ? String(message.context.projectType) : undefined,
          skillBundleId: message.context?.skillBundleId ? String(message.context.skillBundleId) : undefined,
          strategySkillId: message.context?.strategySkillId ? String(message.context.strategySkillId) : undefined,
          instanceExpansionPath: message.context?.instanceExpansionPath ? String(message.context.instanceExpansionPath) : undefined,
          workspacePath: message.context?.workspacePath ? String(message.context.workspacePath) : undefined,
          channel: userChannel,
          backend: activeBackend,
          conversationId,
        };
        const promptText = buildChannelForwardPrompt(text, userContext);
        const acpAgent = await getCurrentAcpAgent(userContext.workspacePath);
        const reply = await acpAgent.chat({
          conversationId,
          text: promptText,
          messageId: randomUUID(),
          timeoutMs: userChannel === "weixin-mobile" ? WEIXIN_DIRECT_ACP_TIMEOUT_MS : undefined,
          cwd: userChannel === "weixin-mobile" ? userContext.workspacePath : undefined,
        });
        const cleaned = sanitizeCustomerText(reply);
        await recordAcpTrace({
          userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          messageId: message.id,
          channel,
          userText: text,
          promptText,
          replyTextRaw: reply,
          replyTextSanitized: cleaned,
          mode,
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return textResponse(cleaned);
      } catch (error) {
        logger.error("转发 Hermes ACP 失败:", error);
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

function buildChannelForwardPrompt(text: string, context: UserContext): string {
  if (context.channel !== "weixin-mobile") return text;
  return [
    "【通道上下文】这是一条来自微信用户的消息；你的回复会直接发回该用户微信。只输出最终微信正文，保持简短，不输出执行过程、内部路径或调试信息。",
    `用户: ${context.userId}`,
    context.instanceId ? `实例: ${context.instanceId}` : "",
    "【用户消息】",
    text,
  ].filter(Boolean).join("\n");
}
