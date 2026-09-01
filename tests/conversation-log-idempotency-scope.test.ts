import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-idempotency-scope-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "scope.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const conversation = await import("../src/services/conversation-log.js");
  return { conversation };
})();

const scopeA = {
  userId: "111",
  projectId: "invest-agent",
  instanceId: "invest-agent-111",
  assistantId: "invest-agent-111",
};
const scopeB = {
  userId: "222",
  projectId: "invest-agent",
  instanceId: "invest-agent-222",
  assistantId: "invest-agent-222",
};

test("idempotent append still replays the same message within one conversation scope", async () => {
  const { conversation } = await fixture;
  const first = conversation.appendConversationMessage({
    scope: scopeA,
    conversationId: "conv-a",
    channel: "web",
    role: "user",
    content: "同一条消息重试",
    idempotencyKey: "retry-key-1",
  });
  const replay = conversation.appendConversationMessage({
    scope: scopeA,
    conversationId: "conv-a",
    channel: "web",
    role: "user",
    content: "同一条消息重试",
    idempotencyKey: "retry-key-1",
  });
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.conversationId, "conv-a");
});

test("the same client idempotency key in another scope must not replay another scope's message", async () => {
  const { conversation } = await fixture;
  const inA = conversation.appendConversationMessage({
    scope: scopeA,
    conversationId: "conv-a",
    channel: "web",
    role: "user",
    content: "用户 111 的消息",
    idempotencyKey: "shared-key",
  });
  const inB = conversation.appendConversationMessage({
    scope: scopeB,
    conversationId: "conv-b",
    channel: "web",
    role: "user",
    content: "用户 222 的消息",
    idempotencyKey: "shared-key",
  });
  assert.notEqual(inB.messageId, inA.messageId);
  assert.equal(inB.conversationId, "conv-b");
  assert.equal(inB.userId, "222");
  assert.equal(inB.content, "用户 222 的消息");
});

test("the same idempotency key in another conversation of the same scope writes a new message", async () => {
  const { conversation } = await fixture;
  const first = conversation.appendConversationMessage({
    scope: scopeA,
    conversationId: "conv-a2",
    channel: "web",
    role: "user",
    content: "会话一的消息",
    idempotencyKey: "cross-conversation-key",
  });
  const second = conversation.appendConversationMessage({
    scope: scopeA,
    conversationId: "conv-a3",
    channel: "web",
    role: "user",
    content: "会话二的消息",
    idempotencyKey: "cross-conversation-key",
  });
  assert.notEqual(second.messageId, first.messageId);
  assert.equal(second.conversationId, "conv-a3");
  assert.equal(second.content, "会话二的消息");
});
