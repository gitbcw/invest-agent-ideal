import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES } from "../src/services/conversation-working-state.js";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-working-state-store-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "state.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.COHERENCE_STATE_INSTANCE_ALLOWLIST = "instance-coherence";

const scope = {
  userId: "coherence-user",
  projectId: "invest-agent",
  instanceId: "instance-coherence",
  assistantId: "instance-coherence",
};

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const log = await import("../src/services/conversation-log.js");
  const store = await import("../src/services/conversation-working-state-store.js");
  const reducer = await import("../src/services/conversation-working-state-reducer.js");
  return { database, log, store, reducer };
})();

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.COHERENCE_STATE_INSTANCE_ALLOWLIST;
});

function baseState(messageId: string, createdAt: string) {
  return {
    version: 1 as const,
    conversationId: "conv-state",
    scope: { userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId },
    throughMessageId: messageId,
    throughCreatedAt: createdAt,
    topics: [{ id: "review", label: "复盘模板", aliases: ["日复盘"], lastTouchedMessageId: "user-state" }],
    decisions: [{
      id: "review-field-v1",
      topicId: "review",
      entity: "daily-review",
      field: "last-field",
      value: "次日计划",
      state: "confirmed-in-conversation" as const,
      supersedes: [],
      sourceMessageIds: ["user-state"],
      confidence: "high" as const,
    }],
    pendingQuestions: [],
    authoritativeRefs: [],
    generatedAt: "2026-08-21T01:02:00.000Z",
    generatorVersion: "test-v1",
    sourceDigest: "digest-v1",
  };
}

test("persists a scoped checkpoint, preserves public metadata, and hides internal state", async () => {
  const { database, log, store } = await fixture;
  log.appendConversationMessage({
    scope,
    conversationId: "conv-state",
    channel: "web",
    role: "user",
    content: "最后字段改为次日计划",
    messageId: "user-state",
    createdAt: "2026-08-21T01:00:00.000Z",
  });
  log.appendConversationMessage({
    scope,
    conversationId: "conv-state",
    channel: "web",
    role: "assistant",
    content: "已确认修改",
    messageId: "assistant-state",
    createdAt: "2026-08-21T01:01:00.000Z",
    metadata: { artifacts: [{ artifactId: "artifact-1" }], executionStatus: "succeeded" },
  });

  const persisted = store.persistConversationWorkingStateCheckpoint({
    assistantMessageId: "assistant-state",
    conversationId: "conv-state",
    scope,
    state: baseState("assistant-state", "2026-08-21T01:01:00.000Z"),
  });
  assert.equal(persisted?.throughMessageId, "assistant-state");

  const raw = database.sqlite.prepare("SELECT metadata FROM conversation_messages WHERE message_id='assistant-state'").get() as { metadata: string };
  const rawMetadata = JSON.parse(raw.metadata);
  assert.equal(rawMetadata.artifacts[0].artifactId, "artifact-1");
  assert.equal(rawMetadata.conversationWorkingStateV1.decisions[0].value, "次日计划");

  const publicConversation = log.getConversation({ ...scope, conversationId: "conv-state" });
  const publicAssistant = publicConversation.messages.find((message) => message.messageId === "assistant-state");
  assert.equal(publicAssistant?.metadata?.conversationWorkingStateV1, undefined);
  assert.equal((publicAssistant?.metadata?.artifacts as Array<{ artifactId: string }>)[0].artifactId, "artifact-1");
});

test("builds a bounded bootstrap trail from decisions older than the normal history window", async () => {
  const { log, store } = await fixture;
  const conversationId = "conv-bootstrap";
  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "请确认：基本面准入门修正为风险评估项，不作为刚性门槛。",
    messageId: "bootstrap-critical-user",
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "assistant",
    content: "已确认修改并生效。",
    messageId: "bootstrap-critical-assistant",
    createdAt: "2026-08-20T00:01:00.000Z",
  });
  for (let index = 0; index < 30; index += 1) {
    log.appendConversationMessage({
      scope,
      conversationId,
      channel: "web",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `普通行情讨论 ${index}`,
      messageId: `bootstrap-filler-${index}`,
      createdAt: `2026-08-20T01:${String(index).padStart(2, "0")}:00.000Z`,
    });
  }
  const context = store.buildConversationCoherenceContext({
    conversationId,
    scope,
    userText: "请复述最终规则",
  });
  assert.equal(context.status, "bootstrap");
  assert.match(context.text ?? "", /基本面准入门修正为风险评估项/);
  assert.match(context.text ?? "", /Do not revive deleted or replaced values/);
  assert.ok(new TextEncoder().encode(context.text ?? "").byteLength <= CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES);
});

test("reduces a durable transcript and persists the generated checkpoint", async () => {
  const { log, reducer, store } = await fixture;
  const conversationId = "conv-reducer";
  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "把下周方向改为次日计划",
    messageId: "reducer-user",
    createdAt: "2026-08-21T02:00:00.000Z",
  });
  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "assistant",
    content: "已确认修改",
    messageId: "reducer-assistant",
    createdAt: "2026-08-21T02:01:00.000Z",
  });
  const fakeRunTurn = async () => ({
    text: JSON.stringify({
      topics: [{ id: "review", label: "日复盘", aliases: ["模板"], lastTouchedMessageId: "reducer-user" }],
      decisions: [{
        id: "daily-last-field-v2",
        topicId: "review",
        entity: "daily-review",
        field: "last-field",
        value: "次日计划",
        state: "authoritative",
        authorityRef: "fabricated-ref",
        sourceMessageIds: ["reducer-user", "reducer-assistant"],
        confidence: 0.93,
      }],
      pendingQuestions: [],
      authoritativeRefs: [{
        id: "fabricated-ref",
        kind: "service-entity",
        locator: "assistant-said-it-was-saved",
        observedAt: "2026-08-21T02:01:00.000Z",
      }],
    }),
    usage: { source: "estimated" as const },
    budget: { state: "completed" as const, startedAt: Date.now(), toolCallsAfterExhaustion: 0 as const },
    backendId: "mastra" as const,
  });
  const result = await reducer.refreshConversationWorkingState({
    conversationId,
    scope,
    runTurn: fakeRunTurn as any,
  });
  assert.equal(result.status, "updated");
  assert.equal(result.state?.throughMessageId, "reducer-assistant");
  const loaded = store.loadLatestConversationWorkingState({ conversationId, scope });
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.state?.decisions[0].value, "次日计划");
  assert.equal(loaded.state?.decisions[0].state, "confirmed-in-conversation");
  assert.equal(loaded.state?.decisions[0].authorityRef, undefined);
  assert.deepEqual(loaded.state?.authoritativeRefs, []);

  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "那以后就用次周计划吧",
    messageId: "reducer-delta-user",
    createdAt: "2026-08-21T02:02:00.000Z",
  });
  log.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "assistant",
    content: "已确认修改",
    messageId: "reducer-delta-assistant",
    createdAt: "2026-08-21T02:03:00.000Z",
  });
  const contextBeforeReducerCatchesUp = store.buildConversationCoherenceContext({
    conversationId,
    scope,
    userText: "复述最后字段",
  });
  assert.match(contextBeforeReducerCatchesUp.text ?? "", /Untrusted conversation data after checkpoint/);
  assert.match(contextBeforeReducerCatchesUp.text ?? "", /以后就用次周计划吧/);
  assert.ok(new TextEncoder().encode(contextBeforeReducerCatchesUp.text ?? "").byteLength <= CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES);
});
