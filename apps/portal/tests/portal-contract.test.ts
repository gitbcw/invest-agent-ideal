import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { statusForCode } from "../src/lib/protocol/error-status";
import { createClientId } from "../src/lib/client-id";
import { sha256Hex } from "../src/components/chat/media-helpers";
import { openPinnedTab, openPreviewTab, pinTab } from "../src/components/chat/workspace-tabs";
import { isVisibleWorkspaceFile } from "../src/components/chat/LibraryTree";
import type { WorkspaceFileItem } from "../src/lib/protocol";
import type { ConversationMessage } from "../src/lib/protocol";
import { cancelConversation, fetchConversation, PortalApiError } from "../src/components/chat/api";
import { openDatabaseAt } from "../src/lib/db";
import { ConversationMirrorRepository } from "../src/lib/db/conversations";
import { syncConversationDetail } from "../src/lib/conversation-detail-sync";
import {
  consumeConversationAnimation,
  updateConversationViewRecord
} from "../src/components/chat/conversation-view-state";
import {
  conversationNavigationUrl,
  hasTerminalReplyAfterLatestUser,
  consumeConversationId,
  isReasonableProcessingMarker,
  PROCESSING_MARKER_MAX_AGE_MS,
  resolveConversationProcessing,
  resolveConversationNavigation
} from "../src/components/chat/conversation-navigation";
import { assetConvertToXlsxSchema, assetFolderRenameSchema, assetListQuerySchema, assetUploadSchema } from "../src/lib/asset-schemas";
import { PORTAL_TYPES } from "../src/lib/protocol";
import { validatePortalTimeoutRelation } from "../src/lib/config";

test("portal error mapping keeps scope and lifecycle statuses stable", () => {
  assert.equal(statusForCode("ATTACHMENT_NOT_FOUND"), 404);
  assert.equal(statusForCode("ARTIFACT_SCOPE_MISMATCH"), 403);
  assert.equal(statusForCode("ARTIFACT_DELETE_CONFLICT"), 409);
  assert.equal(statusForCode("CONCURRENT_TASK_LIMIT"), 429);
  assert.equal(statusForCode("UPLOAD_REQUEST_TOO_LARGE"), 413);
  assert.equal(statusForCode("USER_STORAGE_QUOTA_EXCEEDED"), 409);
  assert.equal(statusForCode("REPORT_MAPPING_NOT_FOUND"), 404);
  assert.equal(statusForCode("ASSET_FOLDER_NOT_EMPTY"), 409);
  assert.equal(statusForCode("future.connector.code"), 400);
});

test("asset protocol supports bounded batch uploads and explicit conversation saves", () => {
  assert.equal(assetUploadSchema.safeParse({ fileName: "note.md", base64: "YQ==" }).success, true);
  assert.equal(assetUploadSchema.safeParse({ fileName: "nested.md", folderId: "folder-a", base64: "YQ==" }).success, true);
  assert.equal(assetUploadSchema.safeParse({ files: [{ fileName: "a.md", base64: "YQ==" }, { fileName: "b.md", base64: "Yg==" }] }).success, true);
  assert.equal(assetUploadSchema.safeParse({ files: [{ fileName: "a.md", folderId: "folder-a", base64: "YQ==" }] }).success, true);
  assert.equal(assetUploadSchema.safeParse({ files: [] }).success, false);
  assert.equal(assetListQuerySchema.safeParse({ folderId: "" }).success, true, "empty folderId represents the root folder");
  assert.equal(assetFolderRenameSchema.safeParse({ name: "重新命名" }).success, true);
  assert.equal(assetFolderRenameSchema.safeParse({ name: "" }).success, false);
  assert.equal(assetConvertToXlsxSchema.safeParse({ expectedVersionId: "version-a", confirmed: true, idempotencyKey: "convert-a" }).success, true);
  assert.equal(assetConvertToXlsxSchema.safeParse({ expectedVersionId: "version-a", confirmed: false, idempotencyKey: "convert-a" }).success, false);
  assert.equal(PORTAL_TYPES.ASSET_FOLDER_RENAME, "asset.folder.rename");
  assert.equal(PORTAL_TYPES.ASSET_FOLDER_DELETE, "asset.folder.delete");
  assert.equal(PORTAL_TYPES.ASSET_CONVERSATION_SAVE, "asset.conversation.save");
  assert.equal(PORTAL_TYPES.ASSET_CONVERT_TO_XLSX, "asset.convert_to_xlsx");
  assert.equal(PORTAL_TYPES.REPORT_MAPPING_GET, "report.mapping.get");
  assert.equal(PORTAL_TYPES.CONVERSATION_CANCEL, "conversation.cancel");
});

test("conversation cancel route enforces full scope before ID-only connector forwarding", () => {
  const route = readFileSync(
    new URL("../src/app/api/conversations/[id]/cancel/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /conversation\.user_id !== session\.sub/);
  assert.match(route, /conversation\.assistant_id !== session\.assistantId/);
  assert.match(route, /conversation\.instance_id !== session\.instanceId/);
  assert.match(route, /PORTAL_TYPES\.CONVERSATION_CANCEL/);
  assert.match(route, /\{ conversationId: params\.id \}/);
  assert.doesNotMatch(route, /userId:\s*session\.sub/);
  assert.doesNotMatch(route, /instanceId:\s*session\.instanceId/);
});

test("client IDs fall back when randomUUID is unavailable", () => {
  assert.equal(createClientId({ randomUUID: () => "native-id" }), "native-id");
  assert.match(createClientId({}), /^client_[a-z0-9]+_[a-z0-9]{8}$/);
});

test("conversation view updates keep parallel task state isolated", () => {
  const initial = updateConversationViewRecord({}, "conversation-a", (view) => ({
    ...view,
    waiting: true,
    waitingStartedAt: 100
  }));
  const withSecond = updateConversationViewRecord(initial, "conversation-b", (view) => ({
    ...view,
    waiting: true,
    waitingStartedAt: 200
  }));
  const firstCompleted = updateConversationViewRecord(withSecond, "conversation-a", (view) => ({
    ...view,
    waiting: false,
    waitingStartedAt: null
  }));

  assert.equal(firstCompleted["conversation-a"].waiting, false);
  assert.equal(firstCompleted["conversation-b"].waiting, true);
  assert.equal(firstCompleted["conversation-b"].waitingStartedAt, 200);
});

test("opening a completed conversation consumes its reply animation", () => {
  const view = updateConversationViewRecord({}, "conversation-a", (current) => ({
    ...current,
    animatingAssistantMessageId: "assistant-message-a"
  }));
  const reopened = updateConversationViewRecord(
    view,
    "conversation-a",
    consumeConversationAnimation
  );

  assert.equal(reopened["conversation-a"].animatingAssistantMessageId, null);
});

test("automation conversation links are consumed without dropping other URL state", () => {
  assert.deepEqual(
    consumeConversationId("http://portal.test/?conversationId=web_123&source=automation#latest"),
    {
      conversationId: "web_123",
      nextUrl: "/?source=automation#latest"
    }
  );
  assert.equal(consumeConversationId("http://portal.test/?source=automation"), null);
});

test("chat navigation prefers URL, restores storage, and honors an explicit new conversation", () => {
  assert.deepEqual(
    resolveConversationNavigation("http://portal.test/chat?conversationId=url-id", "stored-id"),
    { conversationId: "url-id", isNew: false }
  );
  assert.deepEqual(
    resolveConversationNavigation("http://portal.test/chat", "stored-id"),
    { conversationId: "stored-id", isNew: false }
  );
  assert.deepEqual(
    resolveConversationNavigation("http://portal.test/chat?new=1&conversationId=stale", "stored-id"),
    { conversationId: null, isNew: true }
  );
  assert.equal(
    conversationNavigationUrl("http://portal.test/chat?new=1&source=automation#latest", "selected-id"),
    "/chat?source=automation&conversationId=selected-id#latest"
  );
  assert.equal(
    conversationNavigationUrl("http://portal.test/chat?conversationId=selected-id", null),
    "/chat"
  );
});

test("processing markers accept only recent timestamps", () => {
  const now = Date.parse("2026-08-10T04:00:00.000Z");
  assert.equal(isReasonableProcessingMarker(now - 5_000, now), true);
  assert.equal(isReasonableProcessingMarker(now + 1, now), false);
  assert.equal(isReasonableProcessingMarker(now - PROCESSING_MARKER_MAX_AGE_MS - 1, now), false);
  assert.equal(isReasonableProcessingMarker(Number.NaN, now), false);
});

test("an unresolved local send survives a temporary server processing false negative", () => {
  assert.equal(resolveConversationProcessing(false, true), true);
  assert.equal(resolveConversationProcessing(true, false), true);
  assert.equal(resolveConversationProcessing(false, false), false);
  assert.equal(resolveConversationProcessing(false, true, true), false);
  assert.equal(hasTerminalReplyAfterLatestUser([
    { role: "user", status: "sent" },
    { role: "assistant", status: "failed" }
  ]), true);
  assert.equal(hasTerminalReplyAfterLatestUser([
    { role: "assistant", status: "sent" },
    { role: "user", status: "sent" }
  ]), false);
});

test("cancelConversation uses an authenticated POST and preserves connector errors", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({
      ok: true,
      data: { conversationId: "conversation/a", status: "cancelled" }
    });
  };
  try {
    const result = await cancelConversation("conversation/a");
    assert.deepEqual(result, { conversationId: "conversation/a", status: "cancelled" });
    assert.equal(calls[0]?.input, "/api/conversations/conversation%2Fa/cancel");
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(calls[0]?.init?.credentials, "same-origin");

    globalThis.fetch = async () => Response.json(
      { ok: false, error: { code: "FORBIDDEN", message: "无法操作该会话" } },
      { status: 403 }
    );
    await assert.rejects(
      cancelConversation("conversation/a"),
      (error: unknown) => error instanceof PortalApiError
        && error.code === "FORBIDDEN"
        && error.status === 403
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("artifact checksum works on the production HTTP baseline without SubtleCrypto", async () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(
    await sha256Hex(bytes),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("conversation artifact API adds server-parsed workbook previews", () => {
  const route = readFileSync(
    new URL("../src/app/api/artifacts/[artifactId]/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(route, /isXlsxFile\(data\.fileName, data\.mimeType\)/);
  assert.match(route, /parseWorkbookPreview\(Buffer\.from\(data\.base64, "base64"\)\)/);
  assert.match(route, /workbook,\s*\n\s*workbookPreviewError/);
});

test("workspace single-click previews reuse one transient tab", () => {
  const pinned = { tabId: "fixed.md", pinned: true };
  const firstPreview = { tabId: "first.md", pinned: false };
  const secondPreview = { tabId: "second.md", pinned: false };

  const afterFirst = openPreviewTab([pinned], firstPreview, 8);
  const afterSecond = openPreviewTab(afterFirst, secondPreview, 8);

  assert.deepEqual(afterSecond, [pinned, secondPreview]);
});

test("workspace double-click pins a preview so later previews preserve it", () => {
  const preview = { tabId: "keep.md", pinned: false };
  const fixed = pinTab([preview], preview.tabId);
  const next = openPreviewTab(fixed, { tabId: "browse.md", pinned: false }, 8);

  assert.deepEqual(next, [
    { tabId: "keep.md", pinned: true },
    { tabId: "browse.md", pinned: false }
  ]);
});

test("opening an existing preview with explicit intent pins it", () => {
  const next = openPinnedTab(
    [{ tabId: "report.md", pinned: false }],
    { tabId: "report.md", pinned: true },
    8
  );

  assert.deepEqual(next, [{ tabId: "report.md", pinned: true }]);
});

test("workspace tree exposes YAML as a text preview without exposing other text files", () => {
  const yaml: WorkspaceFileItem = {
    fileId: "yaml",
    relativePath: "config/portfolio.yaml",
    fileName: "portfolio.yaml",
    mimeType: "application/yaml",
    sizeBytes: 20,
    updatedAt: "2026-07-29T00:00:00.000Z",
    previewMode: "text",
    downloadable: true
  };
  const source: WorkspaceFileItem = {
    ...yaml,
    fileId: "source",
    relativePath: "analysis.py",
    fileName: "analysis.py",
    mimeType: "text/x-python"
  };

  assert.equal(isVisibleWorkspaceFile(yaml), true);
  assert.equal(isVisibleWorkspaceFile(source), false);
});

test("conversation message pagination keeps equal timestamps stable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-conversation-cursor-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      userId: "user-a",
      assistantId: "assistant-a",
      instanceId: "instance-a",
      channel: "web",
      title: "Conversation A"
    });
    for (const messageId of ["message-a", "message-b", "message-c"]) {
      repo.upsertMessage(makeMessage(messageId, "conversation-a", "2026-08-02T00:00:00.000Z"));
    }

    const first = repo.listMessages({ conversationId: "conversation-a", limit: 2 });
    const second = repo.listMessages({
      conversationId: "conversation-a",
      limit: 2,
      cursor: first.nextCursor ?? undefined
    });

    assert.deepEqual(first.items.map((item) => item.message_id), ["message-a", "message-b"]);
    assert.deepEqual(second.items.map((item) => item.message_id), ["message-c"]);
    assert.equal(second.nextCursor, null);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation detail sync reconciles a partial mirror across runtime pages", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-conversation-sync-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "conversation-a",
      userId: "portal-user",
      assistantId: "assistant-a",
      instanceId: "instance-a",
      channel: "web",
      title: "Conversation A"
    });
    const allMessages = Array.from({ length: 191 }, (_, index) =>
      makeMessage(`message-${String(index).padStart(3, "0")}`, "conversation-a", new Date(index * 1000).toISOString())
    );
    for (const message of allMessages.slice(0, 44)) repo.upsertMessage(message);

    const result = await syncConversationDetail({
      repo,
      conversationId: "conversation-a",
      userId: "portal-user",
      assistantId: "assistant-a",
      instanceId: "instance-a",
      requestPage: async (cursor, limit) => {
        const offset = Number(cursor ?? "0");
        const messages = allMessages.slice(offset, offset + limit);
        const nextOffset = offset + messages.length;
        return {
          ok: true as const,
          data: {
            conversationId: "conversation-a",
            title: "Conversation A",
            messages,
            nextCursor: nextOffset < allMessages.length ? String(nextOffset) : undefined
          }
        };
      }
    });

    assert.equal(result.complete, true);
    assert.equal(repo.listMessages({ conversationId: "conversation-a", limit: 200 }).items.length, 191);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation reconciliation restores a canonical failed assistant turn and is idempotent", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-conversation-recovery-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    const scope = { userId: "portal-user", assistantId: "assistant-a", instanceId: "instance-a" };
    repo.upsertConversation({
      conversationId: "conversation-failure",
      ...scope,
      channel: "web",
      title: "Failure recovery"
    });
    repo.upsertMessage({
      ...makeMessage("user-failure", "conversation-failure", "2026-08-02T00:00:00.000Z"),
      userId: scope.userId,
      role: "user",
      status: "failed",
      requestId: "portal-turn-1",
      content: "请完成选股"
    });
    repo.markReconciliationPending({
      ...scope,
      conversationId: "conversation-failure",
      userMessageId: "user-failure",
      requestId: "portal-turn-1",
      reason: "TIMEOUT"
    });

    const canonical = [
      {
        ...makeMessage("user-failure", "conversation-failure", "2026-08-02T00:00:00.000Z"),
        userId: "runtime-user",
        role: "user" as const,
        status: "sent" as const,
        requestId: "portal-turn-1",
        content: "请完成选股"
      },
      {
        ...makeMessage("assistant-failure", "conversation-failure", "2026-08-02T00:20:00.000Z"),
        userId: "runtime-user",
        role: "assistant" as const,
        status: "failed" as const,
        requestId: "portal-turn-1",
        content: "本次处理超时，未能完成。"
      }
    ];
    const requestPage = async () => ({
      ok: true as const,
      data: {
        conversationId: "conversation-failure",
        title: "Failure recovery",
        messages: canonical
      }
    });

    const first = await syncConversationDetail({ repo, conversationId: "conversation-failure", ...scope, requestPage });
    assert.equal(first.complete, true);
    assert.equal(first.reconciled, true);
    assert.equal(repo.getReconciliation({ ...scope, conversationId: "conversation-failure" }), null);
    const afterFirst = repo.listMessages({ conversationId: "conversation-failure", limit: 10 });
    assert.deepEqual(afterFirst.items.map((message) => [message.message_id, message.status]), [
      ["user-failure", "sent"],
      ["assistant-failure", "failed"]
    ]);

    const beforeDuplicate = db
      .prepare("SELECT message_id, role, content, status, request_id FROM conversation_message_mirror ORDER BY created_at, message_id")
      .all();
    const duplicate = await syncConversationDetail({ repo, conversationId: "conversation-failure", ...scope, requestPage });
    assert.equal(duplicate.complete, true);
    assert.deepEqual(
      db
        .prepare("SELECT message_id, role, content, status, request_id FROM conversation_message_mirror ORDER BY created_at, message_id")
        .all(),
      beforeDuplicate
    );
    assert.equal(repo.listMessages({ conversationId: "conversation-failure", limit: 10 }).items.length, 2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation detail sync rejects a cross-scope conversation without writing it", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "portal-conversation-scope-"));
  const db = openDatabaseAt(path.join(directory, "portal.db"));
  try {
    const repo = new ConversationMirrorRepository(db);
    repo.upsertConversation({
      conversationId: "shared-conversation-id",
      userId: "user-a",
      assistantId: "assistant-a",
      instanceId: "instance-a",
      channel: "web",
      title: "User A"
    });
    repo.upsertMessage({
      ...makeMessage("user-a-message", "shared-conversation-id", "2026-08-02T00:00:00.000Z"),
      userId: "user-a",
      role: "user",
      content: "private"
    });

    const result = await syncConversationDetail({
      repo,
      conversationId: "shared-conversation-id",
      userId: "user-b",
      assistantId: "assistant-a",
      instanceId: "instance-a",
      requestPage: async () => ({
        ok: true as const,
        data: {
          conversationId: "shared-conversation-id",
          title: "User B",
          messages: [
            {
              ...makeMessage("user-b-message", "shared-conversation-id", "2026-08-02T00:01:00.000Z"),
              userId: "user-b",
              role: "user" as const,
              content: "must not write"
            }
          ]
        }
      })
    });
    assert.equal(result.complete, false);
    assert.equal(result.error?.code, "SCOPE_MISMATCH");
    assert.deepEqual(
      repo.listMessages({ conversationId: "shared-conversation-id", limit: 10 }).items.map((message) => message.message_id),
      ["user-a-message"]
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Portal timeout relation leaves a Relay buffer over the execution budget", () => {
  assert.throws(
    () => validatePortalTimeoutRelation(1_200_000, 1_214_999),
    /must be at least/
  );
  assert.doesNotThrow(() => validatePortalTimeoutRelation(1_200_000, 1_215_000));
});

test("fetchConversation consumes every message page", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const allMessages = Array.from({ length: 205 }, (_, index) =>
    makeMessage(`message-${String(index).padStart(3, "0")}`, "conversation-a", new Date(index * 1000).toISOString())
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://portal.test" } }
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/conversations/conversation-a") {
      return Response.json({
        ok: true,
        data: {
          conversationId: "conversation-a",
          title: "Conversation A",
          messages: allMessages.slice(0, 100),
          nextCursor: "page-2",
          processing: true,
          processingStartedAt: "2026-08-10T03:00:00.000Z"
        }
      });
    }
    const cursor = url.searchParams.get("cursor");
    const start = cursor === "page-2" ? 100 : 200;
    return Response.json({
      ok: true,
      data: {
        items: allMessages.slice(start, start + 100),
        nextCursor: start === 100 ? "page-3" : null
      }
    });
  };

  try {
    const result = await fetchConversation("conversation-a");
    assert.equal(result.messages.length, 205);
    assert.equal(result.messages.at(-1)?.messageId, "message-204");
    assert.equal(result.processing, true);
    assert.equal(result.processingStartedAt, "2026-08-10T03:00:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow
    });
  }
});

function makeMessage(messageId: string, conversationId: string, createdAt: string): ConversationMessage {
  return {
    messageId,
    conversationId,
    userId: "runtime-user",
    assistantId: "assistant-a",
    instanceId: "instance-a",
    channel: "web",
    role: "assistant",
    content: messageId,
    status: "sent",
    createdAt
  };
}
