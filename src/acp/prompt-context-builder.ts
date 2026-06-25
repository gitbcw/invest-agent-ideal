import { randomUUID } from "node:crypto";
import type { DailyReviewContext } from "../handlers/review.js";
import { createSandboxToken, sandboxContextFromUserContext, type SandboxContext } from "../lib/sandbox-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildMobilePrompt, compactDailyReviewContext, type CompactDailyReviewContext } from "./mobile-prompt.js";
import { buildContextPacket, type ContextPacket } from "./context-packet.js";

export interface BuiltPromptContext {
  promptText: string;
  sandboxContext: SandboxContext;
  sandboxToken: string;
  compactReviewContext: CompactDailyReviewContext | null;
  contextPacket: ContextPacket;
  reviewContextSummary?: Record<string, unknown>;
}

export async function buildAcpPromptContext(input: {
  userText: string;
  userContext: UserContext;
  reviewContext?: DailyReviewContext | null;
  recentConversationContext?: string;
  contextPacket?: ContextPacket;
}): Promise<BuiltPromptContext> {
  const sandboxContext = {
    ...sandboxContextFromUserContext(input.userContext),
    tokenId: randomUUID(),
  };
  const sandboxToken = createSandboxToken(sandboxContext);
  const compactReviewContext = input.reviewContext ? compactDailyReviewContext(input.reviewContext) : null;
  const contextPacket = input.contextPacket ?? await buildContextPacket(input.userContext);
  const reviewContextSummary = compactReviewContext
    ? {
        date: compactReviewContext.date,
        holdings: compactReviewContext.holdings.length,
        watchlist: compactReviewContext.watchlist.length,
        alertCount: compactReviewContext.alertCount,
        existingPlans: compactReviewContext.existingPlans.length,
      }
    : undefined;
  const promptText = buildMobilePrompt({
    userText: input.userText,
    reviewContext: compactReviewContext,
    userContext: input.userContext,
    sandboxToken,
    recentConversationContext: input.recentConversationContext ?? formatContextPacketForPrompt(contextPacket),
  });

  return {
    promptText,
    sandboxContext,
    sandboxToken,
    compactReviewContext,
    contextPacket,
    reviewContextSummary,
  };
}

function formatContextPacketForPrompt(packet: ContextPacket) {
  const lines: string[] = [];
  if (packet.recentConversation.length > 0) {
    lines.push("【最近对话】");
    lines.push(...packet.recentConversation.map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`));
  }
  if (packet.pendingConfirmations.length > 0) {
    lines.push("【待确认事项】");
    lines.push(...packet.pendingConfirmations.map((item) => `- ${item.kind}: ${item.summary}${item.expiresAt ? ` (expires ${item.expiresAt})` : ""}`));
  }
  if (packet.latestArtifacts.length > 0) {
    lines.push("【最近产物】");
    lines.push(...packet.latestArtifacts.map((item) => `- ${item.title}${item.date ? ` (${item.date})` : ""}: ${item.summary}`));
  }
  lines.push("【状态摘要】");
  lines.push(`- 持仓 ${packet.stateSummary.portfolioCount}；自选 ${packet.stateSummary.watchlistCount}；提醒 ${packet.stateSummary.alertCount}；预案 ${packet.stateSummary.planCount}；最新复盘 ${packet.stateSummary.latestReviewDate ?? "暂无"}`);
  return lines.join("\n");
}
