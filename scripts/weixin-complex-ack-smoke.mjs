#!/usr/bin/env node
/**
 * Smoke test: WeChat messages use the direct Workspace -> Codex path.
 *
 * This does not start a real ACP backend. It checks the bridge structure:
 * - chat() resolves the channel user and saves WeChat conversation state;
 * - media-only messages are rejected locally;
 * - text messages go straight to agent.handleMessage;
 * - the old complex ACK / fast-lane branches are not called in chat().
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/channels/weixin-mobile.ts", "utf-8");
const chatStart = source.indexOf("async chat(request:");
const chatEnd = source.indexOf("\n  private async pushToConversation", chatStart);

assert.ok(chatStart >= 0, "InvestAgentMobileBridge.chat must exist");
assert.ok(chatEnd > chatStart, "chat body boundary must be discoverable");

const chatBody = source.slice(chatStart, chatEnd);
const resolveUser = chatBody.indexOf("resolveOrCreateChannelUser");
const saveState = chatBody.indexOf("saveWeixinAccount");
const mediaGuard = chatBody.indexOf("if (request.media && !request.text)");
const directAgent = chatBody.indexOf("const response = await this.agent.handleMessage({");
const rememberTurn = chatBody.indexOf("await rememberWeixinTurn");

assert.ok(resolveUser >= 0, "chat must resolve the WeChat user/workspace");
assert.ok(saveState >= 0, "chat must persist WeChat conversation state");
assert.ok(mediaGuard >= 0, "chat must keep the local media-only guard");
assert.ok(directAgent >= 0, "chat must directly call ACP/Codex");
assert.ok(rememberTurn > directAgent, "chat must remember the turn after Codex replies");

for (const forbidden of [
  "tryFastDeterministicReply(",
  "tryFastAdminTool(",
  "tryConfirmPendingAlertDraft(",
  "tryConfirmPendingPlanDraft(",
  "tryConfirmPendingToolWriteDraft(",
  "this.canPushToConversation(request.conversationId)",
  "COMPLEX_TASK_ACK_TEXT",
  "daily-review-ack",
  "complex-ack",
]) {
  assert.ok(!chatBody.includes(forbidden), `chat must not use old fast/ACK branch: ${forbidden}`);
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "workspace user resolution",
    "conversation state persistence",
    "media-only guard",
    "direct ACP/Codex call",
    "no old fast/ACK branch in chat",
  ],
}, null, 2));
