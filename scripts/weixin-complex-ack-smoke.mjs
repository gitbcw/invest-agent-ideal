#!/usr/bin/env node
/**
 * Smoke test: WeChat messages use the direct Workspace -> Codex path.
 *
 * This does not start a real ACP backend. It checks the bridge structure:
 * - chat() batches adjacent WeChat events before processing;
 * - processInboundBatch() resolves the channel user and saves WeChat conversation state;
 * - media-only image messages go through the attachment path;
 * - batched messages go straight to agent.handleMessage;
 * - the old complex ACK / fast-lane branches are not called in chat().
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/channels/weixin-message-bridge.ts", "utf-8");
const chatStart = source.indexOf("async chat(request:");
const processStart = source.indexOf("private async processInboundBatch", chatStart);
const processEnd = source.indexOf("\n  async pushToConversation", processStart);

assert.ok(chatStart >= 0, "InvestAgentMobileBridge.chat must exist");
assert.ok(processStart > chatStart, "processInboundBatch must exist after chat");
assert.ok(processEnd > processStart, "processInboundBatch body boundary must be discoverable");

const processingBody = source.slice(chatStart, processEnd);
const resolveUser = processingBody.indexOf("resolveOrCreateChannelUser");
const attachmentStore = processingBody.indexOf("storeWeixinAttachment");
const directAgent = processingBody.indexOf("const response = await this.agent.handleMessage({");
const rememberTurn = processingBody.indexOf("await rememberWeixinTurn");
const batchingWindow = source.indexOf("WEIXIN_INBOUND_BATCH_WINDOW_MS");
const batchFormatter = source.indexOf("formatBatchedUserText");

assert.ok(batchingWindow >= 0, "chat must use a short inbound batching window");
assert.ok(batchFormatter >= 0, "chat must format batched WeChat messages as one user turn");
assert.ok(resolveUser >= 0, "chat must resolve the WeChat user/workspace");
assert.ok(attachmentStore >= 0, "chat must store incoming media attachments");
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
  assert.ok(!processingBody.includes(forbidden), `chat must not use old fast/ACK branch: ${forbidden}`);
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    "short inbound batching window",
    "batched WeChat messages become one user turn",
    "workspace user resolution",
    "media attachment persistence",
    "direct ACP/Codex call",
    "no old fast/ACK branch in chat",
  ],
}, null, 2));
