import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabaseAt } from "../src/lib/db";
import { ConversationMirrorRepository } from "../src/lib/db/conversations";
import { syncConversationDetail } from "../src/lib/conversation-detail-sync";

function makeMessage(messageId: string, conversationId: string, createdAt: string) {
  return {
    messageId,
    conversationId,
    userId: "runtime-user",
    assistantId: "assistant-a",
    instanceId: "instance-a",
    channel: "web" as const,
    role: "assistant" as const,
    content: messageId,
    status: "sent" as const,
    createdAt
  };
}

test("syncDepth=first syncs exactly one remote page even when more pages exist (T-448)", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portal-sync-first-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    const scope = { userId: "user-a", assistantId: "assistant-a", instanceId: "instance-a" };
    repo.upsertConversation({
      conversationId: "conversation-a",
      ...scope,
      channel: "web",
      title: "Long conversation",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    });
    for (let i = 0; i < 150; i++) {
      repo.upsertMessage(makeMessage(`message-${String(i).padStart(3, "0")}`, "conversation-a", new Date(i * 1000).toISOString()));
    }

    let pagesRequested = 0;
    const result = await syncConversationDetail({
      repo,
      conversationId: "conversation-a",
      ...scope,
      syncDepth: "first",
      requestPage: async (cursor, limit) => {
        pagesRequested += 1;
        // The remote still advertises another page; the shallow sync must
        // stop after the first one instead of walking all history.
        const offset = Number(cursor ?? "0");
        const messages = Array.from({ length: Math.min(limit, 40) }, (_, index) =>
          makeMessage(`fresh-${offset + index}`, "conversation-a", new Date((offset + index) * 1000).toISOString())
        );
        return {
          ok: true as const,
          data: {
            conversationId: "conversation-a",
            title: "Long conversation",
            messages,
            nextCursor: String(offset + messages.length)
          }
        };
      }
    });

    assert.equal(pagesRequested, 1, "processing poll must not walk every remote page");
    assert.equal(result.complete, true);
    assert.ok(
      repo.listMessages({ conversationId: "conversation-a", limit: 200 }).items.some((m) => m.message_id === "fresh-0")
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("syncDepth=first falls back to the full walk when a reconciliation is pending (T-448)", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portal-sync-pending-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    const scope = { userId: "user-a", assistantId: "assistant-a", instanceId: "instance-a" };
    repo.upsertConversation({
      conversationId: "conversation-b",
      ...scope,
      channel: "web",
      title: "Recovery",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    });
    repo.upsertMessage({
      ...makeMessage("user-recover", "conversation-b", "2026-08-02T00:00:00.000Z"),
      userId: scope.userId,
      role: "user" as const,
      status: "failed" as const,
      requestId: "portal-turn-1",
      content: "请完成选股"
    });
    repo.markReconciliationPending({
      ...scope,
      conversationId: "conversation-b",
      userMessageId: "user-recover",
      requestId: "portal-turn-1",
      reason: "TIMEOUT"
    });

    let pagesRequested = 0;
    const result = await syncConversationDetail({
      repo,
      conversationId: "conversation-b",
      ...scope,
      syncDepth: "first",
      requestPage: async (cursor) => {
        pagesRequested += 1;
        // Page 1: the failed turn plus a terminal assistant reply.
        if (!cursor) {
          return {
            ok: true as const,
            data: {
              conversationId: "conversation-b",
              title: "Recovery",
              messages: [
                { ...makeMessage("user-recover", "conversation-b", "2026-08-02T00:00:00.000Z"), role: "user" as const, requestId: "portal-turn-1", content: "请完成选股" },
                { ...makeMessage("assistant-recover", "conversation-b", "2026-08-02T00:20:00.000Z"), requestId: "portal-turn-1", content: "done", status: "failed" as const }
              ],
              nextCursor: "page-2"
            }
          };
        }
        return {
          ok: true as const,
          data: { conversationId: "conversation-b", title: "Recovery", messages: [], nextCursor: undefined }
        };
      }
    });

    assert.ok(pagesRequested >= 2, "pending reconciliation must keep the multi-page walk");
    assert.equal(result.complete, true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upsertMessage no longer stamps the session per row; touchConversation does it once (T-448)", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "portal-upsert-touch-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    const scope = { userId: "user-a", assistantId: "assistant-a", instanceId: "instance-a" };
    repo.upsertConversation({
      conversationId: "conversation-c",
      ...scope,
      channel: "web",
      title: "Touch",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    });
    for (let i = 0; i < 5; i++) {
      repo.upsertMessage(makeMessage(`m-${i}`, "conversation-c", `2026-08-02T00:0${i}:00.000Z`));
    }
    // The per-row session UPDATE inside upsertMessage is retired; the session
    // keeps its original stamp until a caller touches it once per page.
    assert.equal(repo.getConversation("conversation-c")?.updated_at, "2026-08-02T00:00:00.000Z");

    repo.touchConversation("conversation-c", "2026-08-02T00:05:00.000Z");
    assert.equal(repo.getConversation("conversation-c")?.updated_at, "2026-08-02T00:05:00.000Z");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation list route skips the remote connector round-trip for query searches (T-448)", () => {
  const route = readFileSync(
    new URL("../src/app/api/conversations/route.ts", import.meta.url),
    "utf8"
  );
  // The blocking CONVERSATION_LIST connector sync must be wrapped in the
  // query gate so a debounced search hits only the local mirror.
  assert.match(route, /if \(!parsed\.data\.query\) \{\s*const remote = await sendConnectorRequest/);
});
