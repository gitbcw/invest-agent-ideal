import { randomUUID } from "node:crypto";
import type { DailyReviewContext } from "../handlers/review.js";
import { createSandboxToken, sandboxContextFromUserContext, type SandboxContext } from "../lib/sandbox-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildMobilePrompt, compactDailyReviewContext, type CompactDailyReviewContext } from "./mobile-prompt.js";

export interface BuiltPromptContext {
  promptText: string;
  sandboxContext: SandboxContext;
  sandboxToken: string;
  compactReviewContext: CompactDailyReviewContext | null;
  reviewContextSummary?: Record<string, unknown>;
}

export async function buildAcpPromptContext(input: {
  userText: string;
  userContext: UserContext;
  reviewContext?: DailyReviewContext | null;
  recentConversationContext?: string;
  isFirstConversation?: boolean;
}): Promise<BuiltPromptContext> {
  const sandboxContext = {
    ...sandboxContextFromUserContext(input.userContext),
    tokenId: randomUUID(),
  };
  const sandboxToken = createSandboxToken(sandboxContext);
  const compactReviewContext = input.reviewContext ? compactDailyReviewContext(input.reviewContext) : null;
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
    recentConversationContext: input.recentConversationContext,
    isFirstConversation: input.isFirstConversation,
  });

  return {
    promptText,
    sandboxContext,
    sandboxToken,
    compactReviewContext,
    reviewContextSummary,
  };
}
