import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-busy-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "busy.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// T-395：退避可注入，测试不等 20s。
process.env.PORTAL_TURN_RETRY_BACKOFF_MS = "10";
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const conversations = await import("../src/services/conversation-log.js");
  return { conversations };
})();

const scope = {
  userId: "portal-busy-user",
  projectId: "invest-agent",
  instanceId: "portal-busy-instance",
  assistantId: "portal-busy-instance",
};

function busyAgent(plan: Array<{ content: string; data?: Record<string, unknown> }>, seen: Array<Record<string, unknown>> = []) {
  let call = 0;
  return {
    agentId: "busy-test-agent",
    agentName: "busy test",
    capabilities: ["chat"],
    async handleMessage(message: Record<string, unknown>) {
      call += 1;
      seen.push({ call, text: String((message as { content?: { text?: string } }).content?.text ?? "") });
      const step = plan[Math.min(call - 1, plan.length - 1)];
      return { content: { type: "text" as const, text: step.content }, finished: true, ...(step.data ? { data: step.data } : {}) };
    },
  };
}

const BUSY_RESPONSE = {
  executionStatus: "failed",
  executionErrorCode: "MASTRA_TURN_BUSY",
  executionErrorCategory: "transient",
  executionRetryable: true,
};

test("persistent busy lands as a regenerable notice row, never a failed assistant message (T-395)", async () => {
  const { conversations } = await fixture;
  const conversationId = "busy-persistent";
  const seen: Array<Record<string, unknown>> = [];
  const result = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "A",
    agent: busyAgent([
      { content: "上一条消息还在处理中，我处理完会直接回复。你可以稍等一下再发下一条。", data: BUSY_RESPONSE },
      { content: "上一条消息还在处理中，我处理完会直接回复。你可以稍等一下再发下一条。", data: BUSY_RESPONSE },
    ], seen),
  });
  // 退避重试一次：两次 busy 输入，两次 agent 调用（不再是 2ms 立即重试）。
  assert.equal(seen.length, 2);
  // busy = 输入未执行，不是任务失败：落 sent 提示行而非 failed 行。
  assert.equal(result.assistantMessage.status, "sent");
  assert.ok(result.assistantMessage.content.includes("还没有执行"), "notice must state the input was never executed");
  assert.ok(result.assistantMessage.content.includes("重新生成"), "notice must point at the regenerate path");
  assert.equal(result.assistantMessage.metadata?.executionErrorCode, "MASTRA_TURN_BUSY");
  assert.notEqual(result.assistantMessage.metadata?.executionStatus, "failed");
});

test("transient busy followed by success retries through and returns the real reply (T-395)", async () => {
  const { conversations } = await fixture;
  const conversationId = "busy-then-success";
  const seen: Array<Record<string, unknown>> = [];
  const result = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "帮我看下持仓",
    agent: busyAgent([
      { content: "busy", data: BUSY_RESPONSE },
      { content: "真实回答" },
    ], seen),
  });
  assert.equal(seen.length, 2, "first busy response must trigger exactly one backed-off retry");
  assert.equal(result.assistantMessage.status, "sent");
  assert.equal(result.assistantMessage.content, "真实回答");
});

test("busy notice row is regenerable: replay delivers the original user text (T-395 recovery loop)", async () => {
  const { conversations } = await fixture;
  const conversationId = "busy-regenerate-loop";
  const busySeen: Array<Record<string, unknown>> = [];
  const busy = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "A",
    agent: busyAgent([
      { content: "busy", data: BUSY_RESPONSE },
      { content: "busy", data: BUSY_RESPONSE },
    ], busySeen),
  });
  assert.equal(busy.assistantMessage.status, "sent");

  // 前一轮已收尾后，用户点「重新生成」重放 busy 提示行。
  const replaySeen: Array<Record<string, unknown>> = [];
  const replay = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    regenerateAssistantMessageId: busy.assistantMessage.messageId,
    agent: busyAgent([{ content: "重放成功" }], replaySeen),
  });
  assert.equal(replay.assistantMessage.status, "sent");
  assert.equal(replay.assistantMessage.content, "重放成功");
  assert.equal(replaySeen.length, 1);
  assert.equal(replaySeen[0].text, "A", "replay must deliver the original user text, not the busy notice");
});
