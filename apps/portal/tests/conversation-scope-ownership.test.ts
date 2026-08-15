import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabaseAt } from "../src/lib/db";
import { ConversationMirrorRepository } from "../src/lib/db/conversations";

const OWNER = { userId: "usr_owner", assistantId: "invest-agent-111", instanceId: "invest-agent-111" };
const OTHER = { userId: "usr_other", assistantId: "invest-agent-222", instanceId: "invest-agent-222" };

function insertRuntimeSession(db: import("better-sqlite3").Database, conversationId: string, channel: string) {
  db.prepare(
    `INSERT INTO conversation_sessions (
       conversation_id, user_id, project_id, instance_id, assistant_id, channel,
       title, created_at, updated_at
     ) VALUES (?, '111', 'invest-agent', ?, ?, ?, ?, ?, ?)`
  ).run(
    conversationId,
    OWNER.instanceId,
    OWNER.assistantId,
    channel,
    "导入会话",
    "2026-08-14T10:00:00.000Z",
    "2026-08-14T10:00:00.000Z"
  );
}

test("single-conversation ownership resolves via session scope, not meta user_id equality", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-conversation-scope2-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);

    // Imported conversation: runtime session row + portal meta row.
    insertRuntimeSession(db, "conv-imported", "weixin-mobile");
    repo.upsertConversation({
      conversationId: "conv-imported",
      userId: OWNER.userId,
      assistantId: OWNER.assistantId,
      instanceId: OWNER.instanceId,
      channel: "weixin-mobile",
      title: "导入会话",
      createdAt: "2026-08-14T10:00:00.000Z",
      updatedAt: "2026-08-14T10:00:00.000Z"
    });

    // Regression 1 (the delete 403): a scope-less lookup must resolve the real
    // meta owner instead of an empty user_id that always fails equality.
    const scopeless = repo.getConversation("conv-imported");
    assert.ok(scopeless);
    assert.equal(scopeless.user_id, OWNER.userId, "scope-less lookup resolves the meta owner, not ''");

    // Regression 2: scoped lookup authorizes by instance+assistant.
    assert.ok(repo.getConversation("conv-imported", OWNER));
    assert.equal(repo.getConversation("conv-imported", OTHER), null, "cross-scope lookup misses");
    assert.equal(repo.getConversation("conv-missing", OWNER), null);

    // Regression 3 (new conversations have no meta row yet): scoped lookup
    // still finds the session and falls back to the requesting portal user.
    insertRuntimeSession(db, "conv-fresh", "web");
    const fresh = repo.getConversation("conv-fresh", OWNER);
    assert.ok(fresh);
    assert.equal(fresh.user_id, OWNER.userId, "meta-less session falls back to the scoped portal user");
    assert.equal(repo.getConversation("conv-fresh", OTHER), null);

    // Regression 4: deleting (and undeleting via list) works for both shapes.
    repo.softDeleteConversation({ conversationId: "conv-imported", userId: OWNER.userId, assistantId: OWNER.assistantId });
    assert.equal(repo.getConversation("conv-imported", OWNER)?.deleted_at != null, true);
    repo.softDeleteConversation({ conversationId: "conv-fresh", userId: OWNER.userId, assistantId: OWNER.assistantId });
    assert.equal(repo.getConversation("conv-fresh", OWNER)?.deleted_at != null, true, "meta-less conversation deletes create their meta row");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
