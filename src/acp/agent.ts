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
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { listWatchRules, createWatchRule } from "../services/watch-rules.js";
import { loadRecentWeixinMemory } from "../lib/weixin-conversation-memory.js";
import { resolveStockRefDetails } from "../services/stock-resolver.js";

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

        const directConfirmation = isConfirmationText(text)
          ? await resolvePendingWatchRuleConfirmation(userContext, text)
          : null;
        if (directConfirmation) {
          const directReply = `已为你添加：${directConfirmation.stockName} ${directConfirmation.description}`;
          await recordAcpTrace({
            userId,
            projectId: userContext.projectId,
            instanceId: userContext.instanceId,
            conversationId,
            messageId: message.id,
            channel,
            userText: text,
            promptText: `[direct-confirmation] ${text}`,
            replyTextRaw: directReply,
            replyTextSanitized: sanitizeCustomerText(directReply),
            mode,
            status: "success",
            elapsedMs: Date.now() - startedAt,
          });
          return textResponse(sanitizeCustomerText(directReply));
        }

        const promptContext = await buildAcpPromptContext({
          userText: buildChannelForwardPrompt(text, userContext),
          userContext,
        });
        const acpAgent = await getCurrentAcpAgent(userContext.workspacePath);
        const reply = await acpAgent.chat({
          conversationId,
          text: promptContext.promptText,
          messageId: randomUUID(),
          timeoutMs: userChannel === "weixin-mobile" ? WEIXIN_DIRECT_ACP_TIMEOUT_MS : undefined,
          cwd: userChannel === "weixin-mobile" ? userContext.workspacePath : undefined,
        });
        const postProcessed = await postProcessAcpReply({
          reply,
          userContext,
          originalText: text,
        });
        const cleaned = sanitizeCustomerText(postProcessed.finalReply);
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

async function postProcessAcpReply(input: {
  reply: string;
  userContext: UserContext;
  originalText: string;
}) {
  const confirmation = await resolvePendingWatchRuleConfirmation(input.userContext, input.originalText);
  if (confirmation) {
    return {
      finalReply: `已加上：${confirmation.stockName} ${confirmation.description}`,
    };
  }
  const draft = parseWatchRuleDraft(input.reply);
  if (!draft) return { finalReply: input.reply };
  const existingRules = await listWatchRules(input.userContext.userId, input.userContext.instanceId);
  const duplicate = existingRules.find((rule) => rule.stockCode === draft.stockCode && rule.ruleType === draft.ruleType);
  if (duplicate) {
    return { finalReply: `这条规则已经存在了：${duplicate.stockName} ${duplicate.ruleType}` };
  }
  return { finalReply: input.reply };
}

async function resolvePendingWatchRuleConfirmation(userContext: UserContext, originalText: string) {
  if (!isConfirmationText(originalText)) return null;
  const recent = await loadRecentWeixinMemory(userContext, 8, { scope: "conversation" });
  const draftMessage = [...recent]
    .reverse()
    .find((message) => message.role === "assistant" && /盯盘|提醒|草案|条件|规则|确认/.test(message.content));
  if (!draftMessage) return null;
  const stockMatch =
    draftMessage.content.match(/标的[：:]\s*([^\n]+)/) ??
    draftMessage.content.match(/([\u4e00-\u9fa5A-Za-z0-9·*（）()]{2,40})(?:[（(](\d{6})(?:\.\w+)?[）)])?/);
  const thresholdMatch = draftMessage.content.match(/(?:股价)?(?:跌破|涨到|涨过|突破|上穿)\s*`?([0-9.]+)`?/);
  if (!stockMatch || !thresholdMatch) return null;
  const stockName = stockMatch[1].trim().replace(/[:：].*$/, "").trim();
  const parsedCode = stockMatch[2];
  const threshold = Number(thresholdMatch[1]);
  if (!Number.isFinite(threshold)) return null;
  const operator = /(?:涨到|涨过|突破|上穿)/.test(draftMessage.content) ? ">=" : "<=";
  const resolved = parsedCode
    ? [{ code: parsedCode, name: stockName, confidence: "high" as const, candidates: [{ code: parsedCode, name: stockName }] }]
    : (await resolveStockRefDetails([{ name: stockName }])).resolved;
  const stockCode = resolved[0]?.code;
  const finalStockName = resolved[0]?.name ?? stockName;
  if (!stockCode) return null;
  const existingRules = await listWatchRules(userContext.userId, userContext.instanceId);
  const duplicate = existingRules.find((rule) => rule.stockCode === stockCode && rule.ruleType === "price_cross" && Number(rule.params.value) === threshold && String(rule.params.operator) === operator);
  if (duplicate) {
    return {
      stockName: duplicate.stockName,
      description: `${operator === ">=" ? "涨到" : "跌破"} ${threshold} 元提醒（${duplicate.stockCode}）`,
    };
  }
  const created = await createWatchRule({
    userId: userContext.userId,
    instanceId: userContext.instanceId,
    stockCode,
    stockName: finalStockName,
    ruleType: "price_cross",
    targetScope: "manual",
    params: { operator, value: threshold },
    notification: { priority: "P0", push: true },
    enabled: true,
    source: { kind: "conversation_confirmation", origin: "wechat_confirm" },
  });
  return {
    stockName: created.stockName,
    description: `${operator === ">=" ? "涨到" : "跌破"} ${threshold} 元提醒（${created.stockCode}）`,
  };
}

function isConfirmationText(text: string) {
  return /^(确认|可以|同意|就这样|就用这个|好|行|确认添加)$/u.test(text.trim());
}

function parseWatchRuleDraft(text: string) {
  const stockMatch = text.match(/([\u4e00-\u9fa5A-Za-z0-9·*（）()]+)\s*盯盘规则草案/);
  const ruleMatch = text.match(/跌破\s*`?([0-9.]+)`?\s*元/);
  if (!stockMatch || !ruleMatch) return null;
  return {
    stockName: stockMatch[1].trim(),
    stockCode: undefined,
    ruleType: "price_cross" as const,
    threshold: Number(ruleMatch[1]),
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
