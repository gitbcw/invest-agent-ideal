import { randomUUID } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { DailyReviewContext } from "../handlers/review.js";
import { createSandboxToken, sandboxContextFromUserContext, type SandboxContext } from "../lib/sandbox-context.js";
import type { UserContext } from "../lib/user-context.js";
import { buildMobilePrompt, compactDailyReviewContext, type CompactDailyReviewContext } from "./mobile-prompt.js";
import { buildContextPacket, type ContextPacket } from "./context-packet.js";

export const SANDBOX_TOKEN_FILENAME = ".sandbox-token";

export interface BuiltPromptContext {
  promptText: string;
  sandboxContext: SandboxContext;
  sandboxToken: string;
  sandboxTokenFile: string | null;
  compactReviewContext: CompactDailyReviewContext | null;
  contextPacket?: ContextPacket;
  reviewContextSummary?: Record<string, unknown>;
}

export async function buildAcpPromptContext(input: {
  userText: string;
  userContext: UserContext;
  reviewContext?: DailyReviewContext | null;
  contextPacket?: ContextPacket;
  includeContextPacket?: boolean;
}): Promise<BuiltPromptContext> {
  const sandboxContext = {
    ...sandboxContextFromUserContext(input.userContext),
    tokenId: randomUUID(),
  };
  const sandboxToken = createSandboxToken(sandboxContext);
  const sandboxTokenFile = input.userContext.workspacePath
    ? writeSandboxTokenFile(input.userContext.workspacePath, sandboxToken)
    : null;
  const compactReviewContext = input.reviewContext ? compactDailyReviewContext(input.reviewContext) : null;
  const contextPacket = input.includeContextPacket === false
    ? undefined
    : input.contextPacket ?? await buildContextPacket(input.userContext);
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
    sandboxTokenFile,
    sandboxPermissions: sandboxContext.permissions,
  });

  return {
    promptText,
    sandboxContext,
    sandboxToken,
    sandboxTokenFile,
    compactReviewContext,
    contextPacket,
    reviewContextSummary,
  };
}

function writeSandboxTokenFile(workspacePath: string, token: string): string {
  const filePath = join(workspacePath, SANDBOX_TOKEN_FILENAME);
  writeFileSync(filePath, token, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}
