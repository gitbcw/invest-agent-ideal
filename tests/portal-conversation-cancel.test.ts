import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-cancel-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "cancel.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.PORTAL_EXECUTION_BUDGET_MS = "2000";
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const conversations = await import("../src/services/conversation-log.js");
  const connector = await import("../src/portal/connector.js");
  return { conversations, connector };
})();

const scope = {
  userId: "portal-cancel-user",
  projectId: "invest-agent",
  instanceId: "portal-cancel-instance",
  assistantId: "portal-cancel-instance",
};

test("cancel stops an accepted chat before ACP starts and does not poison the next turn", async () => {
  const { conversations } = await fixture;
  const conversationId = "cancel-before-acp";
  let firstHandled = false;
  const first = conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "立即停止",
    agent: {
      agentId: "cancel-test-agent",
      agentName: "cancel test",
      capabilities: ["chat"],
      async handleMessage() {
        firstHandled = true;
        return { content: { type: "text" as const, text: "不应发布" }, finished: true };
      },
    },
  });

  const cancelled = await conversations.cancelConversationChat({ ...scope, conversationId });
  assert.deepEqual(cancelled, { conversationId, status: "cancelled" });
  const firstResult = await first;
  assert.equal(firstHandled, false);
  assert.equal(firstResult.assistantMessage.status, "failed");
  assert.equal(firstResult.assistantMessage.metadata?.executionErrorCategory, "cancelled");

  const secondResult = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "下一轮继续",
    agent: {
      agentId: "cancel-test-agent",
      agentName: "cancel test",
      capabilities: ["chat"],
      async handleMessage() {
        return { content: { type: "text" as const, text: "下一轮已完成" }, finished: true };
      },
    },
  });
  assert.equal(secondResult.assistantMessage.status, "sent");
  assert.equal(secondResult.assistantMessage.content, "下一轮已完成");
});

test("startup reconciliation closes an orphaned active turn", async () => {
  const { conversations } = await fixture;
  const { markTurnStart, getCurrentTurnId } = await import("../src/services/conversation-turns.js");
  const conversationId = "cancel-orphaned-startup";
  const turnId = "orphaned-turn";
  conversations.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "进程重启前的任务",
    requestId: turnId,
  });
  markTurnStart({ ...scope, conversationId, turnId });

  assert.equal(conversations.reconcileInterruptedConversationTurnsOnStartup(), 1);
  const result = conversations.getConversation({ ...scope, conversationId });
  const terminal = result?.messages.at(-1);
  assert.equal(terminal?.role, "assistant");
  assert.equal(terminal?.status, "failed");
  assert.equal(terminal?.metadata?.executionErrorCode, "TASK_RUNTIME_RESTARTED");
  assert.equal(getCurrentTurnId({ ...scope, conversationId }), null);
  assert.equal(conversations.reconcileInterruptedConversationTurnsOnStartup(), 0);
});

test("cancel closes an orphaned turn when no in-memory chat remains", async () => {
  const { conversations } = await fixture;
  const { markTurnStart, getCurrentTurnId } = await import("../src/services/conversation-turns.js");
  const conversationId = "cancel-orphaned-command";
  const turnId = "orphaned-cancel-turn";
  conversations.appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "停止孤儿任务",
    requestId: turnId,
  });
  markTurnStart({ ...scope, conversationId, turnId });

  const cancelled = await conversations.cancelConversationChat({ ...scope, conversationId });
  assert.equal(cancelled.status, "cancelled");
  const terminal = conversations.getConversation({ ...scope, conversationId })?.messages.at(-1);
  assert.equal(terminal?.metadata?.executionErrorCode, "TASK_CANCELLED");
  assert.equal(getCurrentTurnId({ ...scope, conversationId }), null);
});

test("cancel interrupts an active agent and suppresses its late success", async () => {
  const { conversations } = await fixture;
  const conversationId = "cancel-active-agent";
  let signalStarted!: () => void;
  let releaseAgent!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const chat = conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "长任务",
    agent: {
      agentId: "cancel-test-agent",
      agentName: "cancel test",
      capabilities: ["chat"],
      async handleMessage() {
        signalStarted();
        await released;
        return { content: { type: "text" as const, text: "迟到的成功" }, finished: true };
      },
      async cancelMessage() {
        releaseAgent();
        return true;
      },
    },
  });

  await started;
  const cancelled = await conversations.cancelConversationChat({ ...scope, conversationId });
  assert.equal(cancelled.status, "cancelled");
  const result = await chat;
  assert.equal(result.assistantMessage.status, "failed");
  assert.equal(result.assistantMessage.content.includes("停止"), true);
  assert.equal(result.assistantMessage.content.includes("迟到的成功"), false);
  assert.equal(result.assistantMessage.metadata?.executionErrorCode, "TASK_CANCELLED");
});

test("a queued turn does not hide the active turn from cancellation", async () => {
  const { conversations } = await fixture;
  const conversationId = "cancel-active-with-queued";
  let signalStarted!: () => void;
  let releaseActive!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const released = new Promise<void>((resolve) => { releaseActive = resolve; });
  const active = conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "正在执行",
    agent: {
      agentId: "cancel-test-agent",
      agentName: "cancel test",
      capabilities: ["chat"],
      async handleMessage() {
        signalStarted();
        await released;
        return { content: { type: "text" as const, text: "不应发布" }, finished: true };
      },
      async cancelMessage() {
        releaseActive();
        return true;
      },
    },
  });
  await started;
  const queued = conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "排队执行",
    agent: {
      agentId: "cancel-test-agent",
      agentName: "cancel test",
      capabilities: ["chat"],
      async handleMessage() {
        return { content: { type: "text" as const, text: "排队回合已完成" }, finished: true };
      },
    },
  });

  const cancelled = await conversations.cancelConversationChat({ ...scope, conversationId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await active).assistantMessage.metadata?.executionErrorCategory, "cancelled");
  assert.equal((await queued).assistantMessage.content, "排队回合已完成");
});

test("connector cancel rejects payload scope overrides and cross-scope conversations", async () => {
  const { conversations, connector } = await fixture;
  const conversationId = "cancel-scope";
  conversations.createConversationSession({ scope, conversationId, title: "取消范围" });
  const connectorScope = { ...scope, connectorId: "cancel-connector", displayName: "cancel" };
  const envelope = (payload: Record<string, unknown>) => ({
    protocolVersion: "2026-08-05",
    requestId: `cancel-${Math.random()}`,
    type: "conversation.cancel",
    sentAt: new Date().toISOString(),
    payload,
  });

  const override = await connector.__test__.handleCommand(
    connectorScope,
    envelope({ conversationId, userId: "another-user" }),
  ) as any;
  assert.equal(override.ok, false);
  assert.equal(override.error.code, "INVALID_REQUEST");

  await assert.rejects(
    () => connector.__test__.handleCommand(
      { ...connectorScope, userId: "another-user" },
      envelope({ conversationId }),
    ),
    conversations.ConversationScopeError,
  );
});

test("ACP cancellation rejects the local prompt and sends session/cancel once", async () => {
  const { StdioAcpAgent } = await import("../src/acp/stdio-agent.js");
  const agent = new StdioAcpAgent({
    id: "codex",
    label: "cancel-test",
    command: "unused",
    args: [],
    cwd: root,
    timeoutMs: 1000,
  } as never);
  const internal = agent as any;
  let cancelCalls = 0;
  let rejectedWith = "";
  let releaseCancel!: () => void;
  const cancelReleased = new Promise<void>((resolve) => { releaseCancel = resolve; });
  internal.connection = {
    async cancel(input: { sessionId: string }) {
      assert.equal(input.sessionId, "session-cancel");
      cancelCalls += 1;
      await cancelReleased;
    },
  };
  internal.activeConversationSessions.set("conversation-cancel", "session-cancel");
  internal.inFlightPromptRejectors.set("session-cancel", (error: Error) => {
    rejectedWith = error.message;
  });

  const [first, second] = await Promise.all([
    agent.cancelConversation("conversation-cancel"),
    agent.cancelConversation("conversation-cancel"),
  ]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(cancelCalls, 1);
  assert.equal(rejectedWith, "TASK_CANCELLED");
  assert.equal(await agent.cancelConversation("unknown-conversation"), false);
  releaseCancel();
});

test("ACP startup cancellation returns without waiting for session initialization", async () => {
  const { StdioAcpAgent } = await import("../src/acp/stdio-agent.js");
  const agent = new StdioAcpAgent({
    id: "codex",
    label: "cancel-startup-test",
    command: "unused",
    args: [],
    cwd: root,
    timeoutMs: 1000,
  } as never);
  const internal = agent as any;
  let releaseReady!: (connection: unknown) => void;
  internal.ensureReady = () => new Promise((resolve) => { releaseReady = resolve; });
  const controller = new AbortController();
  const chat = agent.chatWithUsage({
    conversationId: "cancel-during-startup",
    text: "stop before ready",
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort();

  await assert.rejects(chat, /TASK_CANCELLED/);
  assert.equal(internal.activeConversations.has("cancel-during-startup"), false);
  releaseReady({});
});
