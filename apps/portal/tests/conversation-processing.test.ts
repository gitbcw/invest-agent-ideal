import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "conv-processing-"));
process.env.PORTAL_DB_PATH = path.join(root, "shared.db");
// NODE_ENV is set by the test runner
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

describe("conversation processing (shared DB)", { concurrency: false }, () => {
  test("pending user message with no terminal assistant reply means processing", async () => {
    const { openDatabase } = await import("../src/lib/db");
    const { ConversationMirrorRepository } = await import("../src/lib/db/conversations");
    const db = openDatabase();
    const repo = new ConversationMirrorRepository(db);

    const scope = { userId: "usr-test", assistantId: "invest-agent-test", instanceId: "invest-agent-test" };
    repo.upsertConversation({ ...scope, conversationId: "conv-1", channel: "web", title: "Test" });
    repo.upsertMessage({
      messageId: "msg-1", conversationId: "conv-1", ...scope,
      channel: "web", role: "user", content: "hello", status: "pending", createdAt: new Date().toISOString()
    });

    assert.equal(repo.isConversationProcessing({ ...scope, conversationId: "conv-1" }), true);
  });

  test("terminal assistant reply closes processing", async () => {
    const { openDatabase } = await import("../src/lib/db");
    const { ConversationMirrorRepository } = await import("../src/lib/db/conversations");
    const db = openDatabase();
    const repo = new ConversationMirrorRepository(db);

    const scope = { userId: "usr-test2", assistantId: "invest-agent-test2", instanceId: "invest-agent-test2" };
    repo.upsertConversation({ ...scope, conversationId: "conv-2", channel: "web", title: "Test 2" });
    const t1 = new Date("2026-08-15T10:00:00Z").toISOString();
    const t2 = new Date("2026-08-15T10:00:05Z").toISOString();
    repo.upsertMessage({ messageId: "msg-u", conversationId: "conv-2", ...scope, channel: "web", role: "user", content: "hi", status: "pending", createdAt: t1 });
    repo.upsertMessage({ messageId: "msg-a", conversationId: "conv-2", ...scope, channel: "web", role: "assistant", content: "reply", status: "sent", createdAt: t2 });

    assert.equal(repo.isConversationProcessing({ ...scope, conversationId: "conv-2" }), false);
  });

  test("failed assistant reply also closes processing", async () => {
    const { openDatabase } = await import("../src/lib/db");
    const { ConversationMirrorRepository } = await import("../src/lib/db/conversations");
    const db = openDatabase();
    const repo = new ConversationMirrorRepository(db);

    const scope = { userId: "usr-test3", assistantId: "invest-agent-test3", instanceId: "invest-agent-test3" };
    repo.upsertConversation({ ...scope, conversationId: "conv-3", channel: "web", title: "Test 3" });
    const t1 = new Date("2026-08-15T11:00:00Z").toISOString();
    const t2 = new Date("2026-08-15T11:00:03Z").toISOString();
    repo.upsertMessage({ messageId: "msg-u3", conversationId: "conv-3", ...scope, channel: "web", role: "user", content: "hi", status: "pending", createdAt: t1 });
    repo.upsertMessage({ messageId: "msg-a3", conversationId: "conv-3", ...scope, channel: "web", role: "assistant", content: "error", status: "failed", createdAt: t2 });

    assert.equal(repo.isConversationProcessing({ ...scope, conversationId: "conv-3" }), false);
  });
});
