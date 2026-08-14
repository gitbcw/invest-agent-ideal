import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabaseAt } from "../src/lib/db";
import { ConversationMirrorRepository } from "../src/lib/db/conversations";

const scope = {
  userId: "portal-user",
  assistantId: "assistant-a",
  instanceId: "instance-a"
};

test("conversation processing survives remount through pending mirror state", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-processing-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Pending task"
    });
    repo.upsertMessage({
      messageId: "user-pending",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "继续处理",
      status: "pending",
      createdAt: "2026-08-10T01:00:00.000Z"
    });

    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), true);
    assert.equal(
      repo.getConversationProcessingStartedAt({ conversationId: "conversation-a", ...scope }),
      "2026-08-10T01:00:00.000Z"
    );

    repo.upsertMessage({
      messageId: "user-pending",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "继续处理",
      status: "sent",
      createdAt: "2026-08-10T01:00:00.000Z"
    });
    repo.upsertMessage({
      messageId: "assistant-complete",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "assistant",
      content: "已完成",
      status: "sent",
      createdAt: "2026-08-10T01:01:00.000Z"
    });

    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation processing remains true while timeout reconciliation is pending", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-reconciling-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Reconciling task"
    });
    repo.upsertMessage({
      messageId: "user-failed",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "继续处理",
      status: "failed",
      createdAt: "2026-08-10T02:00:00.000Z"
    });
    repo.markReconciliationPending({
      conversationId: "conversation-a",
      ...scope,
      userMessageId: "user-failed",
      reason: "TIMEOUT"
    });

    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), true);
    assert.equal(
      repo.getConversationProcessingStartedAt({ conversationId: "conversation-a", ...scope }),
      "2026-08-10T02:00:00.000Z"
    );
    repo.clearReconciliation({ conversationId: "conversation-a", ...scope });
    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), false);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal assistant message closes an older pending user turn", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-processing-terminal-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Recovered task"
    });
    repo.upsertMessage({
      messageId: "user-stale-pending",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "旧请求",
      status: "pending",
      createdAt: "2026-08-06T14:41:34.537Z"
    });
    repo.upsertMessage({
      messageId: "assistant-terminal",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "assistant",
      content: "已完成",
      status: "sent",
      createdAt: "2026-08-09T06:39:17.022Z"
    });

    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), false);
    assert.equal(
      repo.getConversationProcessingStartedAt({ conversationId: "conversation-a", ...scope }),
      null
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal assistant message closes legacy pending turn with runtime user id", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-processing-legacy-user-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Recovered legacy task"
    });
    repo.upsertMessage({
      messageId: "user-stale-pending",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "旧请求",
      status: "pending",
      createdAt: "2026-08-06T14:41:34.537Z"
    });
    repo.upsertMessage({
      messageId: "assistant-terminal",
      conversationId: "conversation-a",
      userId: "runtime-user",
      assistantId: scope.assistantId,
      instanceId: scope.instanceId,
      channel: "web",
      role: "assistant",
      content: "已完成",
      status: "sent",
      createdAt: "2026-08-09T06:39:17.022Z"
    });

    assert.equal(repo.isConversationProcessing({ conversationId: "conversation-a", ...scope }), false);
    assert.equal(
      repo.getConversationProcessingStartedAt({ conversationId: "conversation-a", ...scope }),
      null
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy message rows are backfilled to the Portal conversation owner", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-processing-scope-backfill-"));
  const dbPath = path.join(directory, "portal.db");
  let db = openDatabaseAt(dbPath);
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Legacy conversation"
    });
    db.prepare(`
      INSERT INTO conversation_message_mirror (
        message_id, conversation_id, user_id, assistant_id, instance_id, channel,
        role, content, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-assistant", "conversation-a", "runtime-user", scope.assistantId, scope.instanceId,
      "web", "assistant", "历史回复", "sent", "2026-08-10T01:00:00.000Z"
    );
    db.close();

    db = openDatabaseAt(dbPath);
    const row = db.prepare("SELECT user_id FROM conversation_message_mirror WHERE message_id = ?").get("legacy-assistant") as { user_id: string };
    assert.equal(row.user_id, scope.userId);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical upsert repairs a legacy message scope and provisional rows can be removed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-processing-idempotent-retry-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Retry conversation"
    });
    db.prepare(`
      INSERT INTO conversation_message_mirror (
        message_id, conversation_id, user_id, assistant_id, instance_id, channel,
        role, content, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "canonical-assistant", "conversation-a", "runtime-user", scope.assistantId, scope.instanceId,
      "web", "assistant", "已完成", "sent", "2026-08-10T01:01:00.000Z"
    );
    repo.upsertMessage({
      messageId: "canonical-assistant",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "assistant",
      content: "已完成",
      status: "sent",
      createdAt: "2026-08-10T01:01:00.000Z"
    });
    repo.upsertMessage({
      messageId: "provisional-user",
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      role: "user",
      content: "重试请求",
      status: "pending",
      createdAt: "2026-08-10T01:02:00.000Z"
    });
    repo.removeMessage({
      ...scope,
      messageId: "provisional-user",
      conversationId: "conversation-a",
      updatedAt: "2026-08-10T01:02:01.000Z"
    });

    const repaired = db.prepare("SELECT user_id FROM conversation_message_mirror WHERE message_id = ?").get("canonical-assistant") as { user_id: string };
    assert.equal(repaired.user_id, scope.userId);
    const provisional = db.prepare("SELECT COUNT(*) AS count FROM conversation_message_mirror WHERE message_id = ?")
      .get("provisional-user") as { count: number };
    assert.equal(provisional.count, 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
