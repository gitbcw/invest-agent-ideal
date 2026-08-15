import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before db/index (transitively loaded by the module under test)
// is imported.
process.env.WORKSPACE_BACKEND = "mastra";
process.env.NODE_ENV = "test";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-conversation-history-"));
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

async function insertMessage(row: {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  requestId?: string | null;
  status?: string;
  createdAt: string;
}) {
  const { sqlite } = await import("../src/db/index.js");
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO conversation_sessions (
         conversation_id, user_id, channel, title, created_at, updated_at
       ) VALUES (?, 'history-tester', 'web', 'history test', ?, ?)`
    )
    .run(row.conversationId, row.createdAt, row.createdAt);
  sqlite
    .prepare(
      `INSERT INTO conversation_messages (
         message_id, conversation_id, role, content, status, request_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.messageId,
      row.conversationId,
      row.role,
      row.content,
      row.status ?? "sent",
      row.requestId ?? null,
      row.createdAt,
    );
}

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
});

test("loadConversationHistory returns chronological turns for one conversation only", async () => {
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const { loadConversationHistory } = await import("../src/services/conversation-history.js");
  await insertMessage({ messageId: "m1", conversationId: "conv-a", role: "user", content: "第一问", createdAt: "2026-08-15T01:00:00.000Z" });
  await insertMessage({ messageId: "m2", conversationId: "conv-a", role: "assistant", content: "第一答", createdAt: "2026-08-15T01:01:00.000Z" });
  await insertMessage({ messageId: "m3", conversationId: "conv-b", role: "user", content: "别的会话", createdAt: "2026-08-15T02:00:00.000Z" });

  const history = loadConversationHistory({ conversationId: "conv-a" });
  assert.deepEqual(history.map((m) => [m.role, m.content]), [
    ["user", "第一问"],
    ["assistant", "第一答"],
  ]);
});

test("loadConversationHistory excludes the in-flight turn by request id and by exact newest text", async () => {
  const { loadConversationHistory } = await import("../src/services/conversation-history.js");
  await insertMessage({ messageId: "h1", conversationId: "conv-ex", role: "user", content: "历史问", createdAt: "2026-08-15T03:00:00.000Z" });
  await insertMessage({ messageId: "h2", conversationId: "conv-ex", role: "assistant", content: "历史答", createdAt: "2026-08-15T03:01:00.000Z" });
  // Web path: current user message persisted with the in-flight request id.
  await insertMessage({ messageId: "h3", conversationId: "conv-ex", role: "user", content: "当前这轮", requestId: "portal-current", createdAt: "2026-08-15T04:00:00.000Z" });

  const byRequestId = loadConversationHistory({ conversationId: "conv-ex", excludeRequestId: "portal-current" });
  assert.deepEqual(byRequestId.map((m) => m.content), ["历史问", "历史答"]);

  // Channel that persists without a shared request id: exact-text guard on
  // the newest row must still drop the current turn.
  const byText = loadConversationHistory({ conversationId: "conv-ex", excludeCurrentText: "当前这轮" });
  assert.deepEqual(byText.map((m) => m.content), ["历史问", "历史答"]);
});

test("loadConversationHistory skips failed rows, truncates long content and honors budgets", async () => {
  const { loadConversationHistory } = await import("../src/services/conversation-history.js");
  await insertMessage({ messageId: "t1", conversationId: "conv-tr", role: "user", content: "问", createdAt: "2026-08-15T05:00:00.000Z" });
  await insertMessage({ messageId: "t2", conversationId: "conv-tr", role: "assistant", content: "失败答", status: "failed", createdAt: "2026-08-15T05:01:00.000Z" });
  await insertMessage({
    messageId: "t3",
    conversationId: "conv-tr",
    role: "assistant",
    content: "长".repeat(5000),
    createdAt: "2026-08-15T05:02:00.000Z",
  });

  const history = loadConversationHistory({ conversationId: "conv-tr", maxCharsPerMessage: 1000 });
  assert.equal(history.length, 2);
  assert.equal(history[0].content, "问");
  const truncated = history[1].content as string;
  assert.ok(truncated.startsWith("长"));
  assert.ok(truncated.length <= 1010);
  assert.ok(truncated.endsWith("…[截断]"));

  // Budget drops oldest overflow but always keeps the newest turn.
  await insertMessage({ messageId: "t4", conversationId: "conv-budget", role: "user", content: "旧问", createdAt: "2026-08-15T06:00:00.000Z" });
  await insertMessage({ messageId: "t5", conversationId: "conv-budget", role: "assistant", content: "最新回答", createdAt: "2026-08-15T06:01:00.000Z" });
  const budgeted = loadConversationHistory({ conversationId: "conv-budget", totalCharsBudget: 2 });
  assert.deepEqual(budgeted.map((m) => m.content), ["最新回答"]);
});

test("loadConversationHistory degrades to empty on a missing conversation or db error", async () => {
  const { loadConversationHistory } = await import("../src/services/conversation-history.js");
  assert.deepEqual(loadConversationHistory({ conversationId: "" }), []);
  assert.deepEqual(loadConversationHistory({ conversationId: "conv-missing" }), []);
});
