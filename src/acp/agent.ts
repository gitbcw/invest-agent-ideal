import { randomUUID } from "node:crypto";
import type { AcpMessage, AcpResponse } from "./protocol.js";
import { textResponse } from "./protocol.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { getCurrentAcpAgent } from "./stdio-agent.js";
import { buildDailyReviewContext, saveSkillDailyReview } from "../handlers/review.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { recordCodexAcpTrace } from "./trace.js";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildAcpPromptContext } from "./prompt-context-builder.js";
import { triage } from "./triage.js";

export interface AcpAgent {
  agentId: string;
  agentName: string;
  capabilities: string[];
  handleMessage(message: AcpMessage): Promise<AcpResponse>;
}

export function isDailyReviewRequest(text: string) {
  const compact = text.replace(/\s+/g, "");
  if (/(查看|查询|看看|看一下|看下|列出|列表|记录|历史|最近).{0,8}复盘|复盘.{0,8}(记录|历史|列表|存档)/.test(compact)) {
    return false;
  }
  return /(?:生成|做|来一份|出一份)(?:今日|今天|日|收盘)?复盘|^(?:今日|今天|日|收盘)?复盘$|明日关注/.test(compact);
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

      const isFirstConversation = Boolean(message.context?.isFirstConversation);

      // 首次对话跳过 triage,直接进 Codex(避免被 DeepSeek 吞成通用问候)
      if (!isFirstConversation) {
        // 路由层先跑:简单问题直接回复,边界问题礼貌拒绝,复杂问题才 fallback Codex
        const triageResult = await triage(text, {
          conversationId: String(message.context?.conversationId || message.from || ""),
        });
        if (triageResult.kind === "direct_reply") {
          logger.info(`triage direct_reply provider=${triageResult.provider ?? "-"} elapsedMs=${triageResult.elapsedMs}`);
          return textResponse(triageResult.text ?? "");
        }
        if (triageResult.kind === "reject") {
          logger.info(`triage reject provider=${triageResult.provider ?? "-"} confidence=${triageResult.confidence.toFixed(2)}`);
          return textResponse(triageResult.text ?? "抱歉,我只能处理投资相关问题。");
        }
        logger.info(`triage fallback_codex reason=${triageResult.reason ?? "-"} 准备转发: ${text.slice(0, 100)}`);
      } else {
        logger.info(`首次对话,跳过 triage 直接进 Codex onboarding 流程`);
      }
      const startedAt = Date.now();
      const conversationId = String(
        message.context?.conversationId || message.from || "invest-agent"
      );
      const channel = String(message.context?.channel || "unknown");
      const userId = String(message.context?.userId || DEFAULT_USER_ID);
      const mode = isFirstConversation ? "onboarding" : isDailyReviewRequest(text) ? "daily-review" : "chat";
      let traceSandboxTokenId: string | undefined;
      let traceSandboxPermissions: string[] | undefined;

      try {
        const reviewContext = isDailyReviewRequest(text)
          ? await buildDailyReviewContext({
              userId,
              instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
            })
          : null;
        if (reviewContext) {
          logger.info(
            `日复盘上下文已整理 date=${reviewContext.date} stocks=${reviewContext.stocks.length} alerts=${reviewContext.alerts.length}`
          );
        }
        const userChannel: UserContext["channel"] =
          channel === "weixin-mobile" || channel === "dashboard" || channel === "api" ? channel : "api";
        const userContext: UserContext = {
          userId,
          projectId: message.context?.projectId ? String(message.context.projectId) : undefined,
          instanceId: message.context?.instanceId ? String(message.context.instanceId) : undefined,
          projectType: message.context?.projectType ? String(message.context.projectType) : undefined,
          skillBundleId: message.context?.skillBundleId ? String(message.context.skillBundleId) : undefined,
          strategySkillId: message.context?.strategySkillId ? String(message.context.strategySkillId) : undefined,
          instanceExpansionPath: message.context?.instanceExpansionPath ? String(message.context.instanceExpansionPath) : undefined,
          channel: userChannel,
          backend: "codex" as const,
          conversationId,
        };
        const promptContext = await buildAcpPromptContext({
          userText: text,
          reviewContext,
          userContext,
          isFirstConversation,
        });
        traceSandboxTokenId = promptContext.sandboxContext.tokenId;
        traceSandboxPermissions = promptContext.sandboxContext.permissions;
        const promptText = promptContext.promptText;
        const reply = await (await getCurrentAcpAgent()).chat({
          conversationId,
          text: promptText,
          messageId: randomUUID(),
        });
        const cleaned = sanitizeCustomerText(reply);
        if (reviewContext) {
          await saveSkillDailyReview({
            userId,
            date: reviewContext.date,
            content: cleaned,
            summary: cleaned.slice(0, 1200),
            context: {
              generatedAt: reviewContext.generatedAt,
              stocks: reviewContext.stocks.map((stock) => ({ code: stock.code, name: stock.name, pool: stock.pool })),
              alertCount: reviewContext.alerts.length,
            },
          });
        }
        await recordCodexAcpTrace({
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
          reviewContextSummary: promptContext.reviewContextSummary,
          sandboxTokenId: promptContext.sandboxContext.tokenId,
          sandboxPermissions: promptContext.sandboxContext.permissions,
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return textResponse(cleaned);
      } catch (error) {
        logger.error("转发 Codex ACP 失败:", error);
        const errorMessage = formatUnknownError(error);
        await recordCodexAcpTrace({
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
          sandboxTokenId: traceSandboxTokenId,
          sandboxPermissions: traceSandboxPermissions,
        });
        return textResponse("这次分析生成超时了，请稍后再试。我已记录本次异常，方便继续排查。");
      }
    },
  };
}
