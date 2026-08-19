"use client";

import type {
  ArtifactDescriptor,
  ArtifactEventName,
  ConversationCancelResult,
  ConversationMessage,
  WorkspaceFileGetResult,
  WorkspaceFileListResult
} from "@/lib/protocol";
import type { ChatMessageView, ConversationListItem, TraceDetailView, WorkStepView } from "./types";
import type { WorkbookPreviewData } from "@/lib/workbook-preview";

export interface PortalAttachmentPayload {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

export interface AssistantStatus {
  online: boolean;
  mode: "real" | "mock" | null;
  status: "online" | "busy" | "degraded" | "offline";
  lastHeartbeatAt: string | null;
  capabilities: string[];
  displayName: string | null;
  version: string | null;
  startedAt: string | null;
}

export interface SendMessageResult {
  ok: boolean;
  conversationId: string;
  userMessage?: ConversationMessage;
  assistantMessage?: ConversationMessage;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  traceId?: string;
}

export interface CurrentUser {
  id: string;
  username: string;
  role: "user" | "admin";
  displayName: string;
  assistantId: string;
  instanceId: string;
  mustChangePassword: boolean;
}

export interface ConversationLabel {
  label_id: string;
  name: string;
  position: number;
}

export class PortalApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "PortalApiError";
  }
}

export async function fetchConversationLabels(): Promise<ConversationLabel[]> {
  const res = await fetch("/api/conversation-labels", { credentials: "same-origin" });
  const json = await jsonOrThrow<{ ok: boolean; data?: { items: ConversationLabel[] }; error?: { message: string } }>(res);
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? "读取标签失败");
  return json.data.items;
}

export async function createConversationLabel(name: string): Promise<ConversationLabel> {
  const res = await fetch("/api/conversation-labels", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ name }) });
  const json = await jsonOrThrow<{ ok: boolean; data?: ConversationLabel; error?: { message: string } }>(res);
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? "创建标签失败");
  return json.data;
}

export async function updateConversationLabel(labelId: string, input: { name?: string; position?: number }): Promise<ConversationLabel> {
  const res = await fetch(`/api/conversation-labels?id=${encodeURIComponent(labelId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(input) });
  const json = await jsonOrThrow<{ ok: boolean; data?: ConversationLabel; error?: { message: string } }>(res);
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? "更新标签失败");
  return json.data;
}

export async function deleteConversationLabel(labelId: string): Promise<void> {
  const res = await fetch(`/api/conversation-labels?id=${encodeURIComponent(labelId)}`, { method: "DELETE", credentials: "same-origin" });
  const json = await jsonOrThrow<{ ok: boolean; error?: { message: string } }>(res);
  if (!json.ok) throw new Error(json.error?.message ?? "删除标签失败");
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const json = (await res.json()) as T;
  return json;
}

export async function fetchConversations(opts: {
  limit?: number;
  cursor?: string;
  query?: string;
  archived?: boolean;
} = {}): Promise<{ items: ConversationListItem[]; nextCursor: string | null }> {
  const url = new URL("/api/conversations", window.location.origin);
  if (opts.limit) url.searchParams.set("limit", String(opts.limit));
  if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
  if (opts.query) url.searchParams.set("query", opts.query);
  if (opts.archived) url.searchParams.set("archived", "true");
  const res = await fetch(url, { method: "GET", credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`fetchConversations failed: ${res.status}`);
  }
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: { items: ConversationListItem[]; nextCursor: string | null };
    error?: { message: string };
  }>(res);
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? "未知错误");
  return { items: json.data.items, nextCursor: json.data.nextCursor };
}

export async function updateConversation(
  conversationId: string,
  input: { title?: string; pinned?: boolean; archived?: boolean; labelId?: string | null; position?: number }
): Promise<ConversationListItem> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input)
  });
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: ConversationListItem;
    error?: { message: string };
  }>(res);
  if (!json.ok || !json.data) throw new Error(json.error?.message ?? "更新失败");
  return json.data;
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const res = await fetch(`/api/conversations/${conversationId}`, {
    method: "DELETE",
    credentials: "same-origin"
  });
  const json = await jsonOrThrow<{
    ok: boolean;
    error?: { message: string };
  }>(res);
  if (!json.ok) throw new Error(json.error?.message ?? "删除失败");
}

export async function fetchConversation(
  conversationId: string
): Promise<{
  conversationId: string;
  title: string;
  messages: ConversationMessage[];
  processing: boolean;
  processingStartedAt: string | null;
}> {
  const url = new URL(`/api/conversations/${conversationId}`, window.location.origin);
  url.searchParams.set("limit", "100");
  const res = await fetch(url, { credentials: "same-origin" });
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: {
      conversationId: string;
      title: string;
      messages: ConversationMessage[];
      nextCursor?: string | null;
      processing?: boolean;
      processingStartedAt?: string | null;
    };
    error?: { message: string; code: string };
  }>(res);
  if (!json.ok || !json.data) {
    throw new PortalApiError(
      json.error?.message ?? "未知错误",
      json.error?.code ?? "UNKNOWN",
      res.status
    );
  }
  const messages = [...json.data.messages];
  const messageIds = new Set(messages.map((message) => message.messageId));
  const seenCursors = new Set<string>();
  let cursor = json.data.nextCursor ?? null;

  for (let page = 0; cursor && page < 100; page += 1) {
    if (seenCursors.has(cursor)) throw new Error("会话历史分页游标重复");
    seenCursors.add(cursor);
    const pageUrl = new URL(`/api/conversations/${conversationId}/messages`, window.location.origin);
    pageUrl.searchParams.set("limit", "100");
    pageUrl.searchParams.set("cursor", cursor);
    const pageResponse = await fetch(pageUrl, { credentials: "same-origin" });
    const pageJson = await jsonOrThrow<{
      ok: boolean;
      data?: { items: ConversationMessage[]; nextCursor?: string | null };
      error?: { message: string };
    }>(pageResponse);
    if (!pageJson.ok || !pageJson.data) {
      throw new Error(pageJson.error?.message ?? "会话历史加载失败");
    }
    for (const message of pageJson.data.items) {
      if (!messageIds.has(message.messageId)) {
        messageIds.add(message.messageId);
        messages.push(message);
      }
    }
    cursor = pageJson.data.nextCursor ?? null;
  }
  if (cursor) throw new Error("会话历史过长,未能完整加载");

  return {
    conversationId: json.data.conversationId,
    title: json.data.title,
    messages,
    processing: Boolean(json.data.processing),
    processingStartedAt: json.data.processingStartedAt ?? null
  };
}

export async function sendMessage(
  conversationId: string,
  input: { text?: string; attachments?: PortalAttachmentPayload[]; model?: string },
  idempotencyKey?: string
): Promise<SendMessageResult> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ ...input, idempotencyKey })
  });
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: SendMessageResult;
    error?: { message: string; code: string };
  }>(res);
  if (!json.ok || !json.data) {
    throw new Error(json.error?.message ?? "发送失败");
  }
  return json.data;
}

export async function cancelConversation(conversationId: string): Promise<ConversationCancelResult> {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/cancel`, {
    method: "POST",
    credentials: "same-origin"
  });
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: ConversationCancelResult;
    error?: { message: string; code: string };
  }>(res);
  if (!json.ok || !json.data) {
    throw new PortalApiError(
      json.error?.message ?? "停止处理失败",
      json.error?.code ?? "UNKNOWN",
      res.status
    );
  }
  return json.data;
}

export async function fetchAssistantStatus(): Promise<AssistantStatus> {
  const res = await fetch("/api/assistant/status", { credentials: "same-origin" });
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: AssistantStatus;
    error?: { message: string }
  }>(res);
  if (!json.ok || !json.data) {
    return {
      online: false,
      mode: null,
      status: "offline",
      lastHeartbeatAt: null,
      capabilities: [],
      displayName: null,
      version: null,
      startedAt: null
    };
  }
  return json.data;
}

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (res.status === 401) return null;
  const json = await jsonOrThrow<{
    ok: boolean;
    data?: { user: CurrentUser };
    error?: { message: string }
  }>(res);
  if (!json.ok || !json.data) return null;
  return json.data.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
}

export interface ArtifactPayload extends ArtifactDescriptor {
  base64: string;
  sanitized: boolean;
  workbook?: WorkbookPreviewData;
  workbookPreviewError?: string;
}

export type ArtifactFetchOutcome =
  | { ok: true; payload: ArtifactPayload }
  | { ok: false; code: string; message: string; status: number };

export async function fetchArtifact(artifactId: string): Promise<ArtifactFetchOutcome> {
  const res = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`, {
    method: "GET",
    credentials: "same-origin"
  });
  const json = (await res.json()) as
    | { ok: true; data: ArtifactPayload }
    | { ok: false; error: { code: string; message: string } };
  if (json.ok) return { ok: true, payload: json.data };
  return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
}

export async function saveArtifactToAssets(artifactId: string, name?: string): Promise<{ ok: true; data: import("@/lib/protocol").UserAsset } | { ok: false; error: string }> {
  try {
    const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/save`, {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = await response.json() as { ok?: boolean; data?: import("@/lib/protocol").UserAsset; error?: { message?: string } };
    if (!response.ok || !body.ok || !body.data) return { ok: false, error: body.error?.message || "保存文件失败" };
    return { ok: true, data: body.data };
  } catch { return { ok: false, error: "文件服务暂时不可用" }; }
}

export async function fetchWorkspaceFiles(): Promise<ApiOutcome<WorkspaceFileListResult>> {
  const res = await fetch("/api/workspace/files", { credentials: "same-origin" });
  const json = (await res.json()) as
    | { ok: true; data: WorkspaceFileListResult }
    | { ok: false; error: { code: string; message: string } };
  if (json.ok) return { ok: true, data: json.data };
  return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
}

export async function fetchWorkspaceFile(relativePath: string): Promise<ArtifactFetchOutcome> {
  const url = new URL("/api/workspace/files/content", window.location.origin);
  url.searchParams.set("path", relativePath);
  const res = await fetch(url, { credentials: "same-origin" });
  const json = (await res.json()) as
    | { ok: true; data: WorkspaceFileGetResult }
    | { ok: false; error: { code: string; message: string } };
  if (!json.ok) return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
  return {
    ok: true,
    payload: {
      artifactId: json.data.fileId,
      title: json.data.fileName,
      fileName: json.data.fileName,
      mimeType: json.data.mimeType,
      sizeBytes: json.data.sizeBytes,
      kind: "document",
      previewMode: json.data.previewMode,
      createdAt: json.data.updatedAt,
      checksum: json.data.checksum,
      sanitized: false,
      base64: json.data.base64
    }
  };
}

export type LegacyPublishOutcome =
  | { ok: true; descriptor: ArtifactDescriptor }
  | { ok: false; code: string; message: string; status: number };

export async function publishLegacyArtifact(
  relativePath: string,
  conversationId?: string
): Promise<LegacyPublishOutcome> {
  const res = await fetch("/api/artifacts/legacy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ relativePath, conversationId })
  });
  const json = (await res.json()) as
    | { ok: true; data: ArtifactDescriptor }
    | { ok: false; error: { code: string; message: string } };
  if (json.ok) return { ok: true, descriptor: json.data };
  return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
}

export async function recordArtifactEvent(
  artifactId: string,
  event: ArtifactEventName,
  options: { status?: "success" | "failure" | "denied"; reason?: string } = {}
): Promise<void> {
  try {
    await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        event,
        status: options.status,
        reason: options.reason
      })
    });
  } catch {
    // Telemetry is best-effort; failures must not disrupt the viewer UX.
  }
}

// ---------------------------------------------------------------------------
// File-retention governance client functions (added 2026-07-25).
// Each returns the same discriminated-union shape as fetchArtifact so the UI
// can render deterministic states from the connector error code.
// ---------------------------------------------------------------------------

import type {
  ArtifactDeleteConfirmResult,
  ArtifactDeletePrepareResult,
  ArtifactLibraryItem,
  ArtifactLibraryListResult,
  AttachmentGetResult
} from "@/lib/protocol";

export type ApiOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string; status: number };

async function getJson<T>(url: string): Promise<ApiOutcome<T>> {
  const res = await fetch(url, { method: "GET", credentials: "same-origin" });
  const json = (await res.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
  if (json.ok) return { ok: true, data: json.data };
  return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
}

async function postJson<T>(url: string, body: unknown): Promise<ApiOutcome<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body)
  });
  const json = (await res.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
  if (json.ok) return { ok: true, data: json.data };
  return { ok: false, code: json.error.code, message: json.error.message, status: res.status };
}

export type LibraryListOutcome = ApiOutcome<ArtifactLibraryListResult>;

export async function fetchArtifactLibrary(options: { cursor?: string; limit?: number } = {}): Promise<LibraryListOutcome> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const qs = params.toString();
  return getJson<ArtifactLibraryListResult>(`/api/artifacts/library${qs ? `?${qs}` : ""}`);
}

export type AttachmentOutcome = ApiOutcome<AttachmentGetResult>;

export async function fetchAttachment(attachmentId: string): Promise<AttachmentOutcome> {
  return getJson<AttachmentGetResult>(`/api/attachments/${encodeURIComponent(attachmentId)}`);
}

export type DeletePrepareOutcome = ApiOutcome<ArtifactDeletePrepareResult>;

export async function prepareArtifactDelete(artifactId: string): Promise<DeletePrepareOutcome> {
  return postJson<ArtifactDeletePrepareResult>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/delete/prepare`,
    {}
  );
}

export type DeleteConfirmOutcome = ApiOutcome<ArtifactDeleteConfirmResult>;

export async function confirmArtifactDelete(artifactId: string, tokenId: string): Promise<DeleteConfirmOutcome> {
  return postJson<ArtifactDeleteConfirmResult>(
    `/api/artifacts/${encodeURIComponent(artifactId)}/delete/confirm`,
    { tokenId }
  );
}

export type { ArtifactLibraryItem };

export type { ChatMessageView };

/** T-199 历史回看：拉取一轮的工具调用时间线与计量摘要。 */
export async function fetchTrace(traceId: string): Promise<TraceDetailView | null> {
  const res = await fetch(`/api/trace/${encodeURIComponent(traceId)}`, { credentials: "same-origin" });
  const json = await jsonOrThrow<{ ok: boolean; data?: { trace: TraceDetailView | null }; error?: { message: string } }>(res);
  if (!json.ok) throw new Error(json.error?.message ?? "过程记录获取失败");
  return json.data?.trace ?? null;
}

/**
 * T-199 实时进度订阅（SSE）。返回取消函数；事件尽力而为，连接失败静默
 * （聊天结果走原有 POST，不依赖本订阅）。
 */
export function subscribeConversationProgress(
  conversationId: string,
  onStep: (step: WorkStepView) => void
): () => void {
  try {
    const source = new EventSource(`/api/conversations/${encodeURIComponent(conversationId)}/progress`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { kind?: string; event?: WorkStepView };
        if (payload.kind === "progress" && payload.event) onStep(payload.event);
      } catch {
        // 忽略无法解析的事件。
      }
    };
    source.onerror = () => {
      // EventSource 会自动重连；轮次结束后由调用方关闭。
    };
    return () => source.close();
  } catch {
    return () => undefined;
  }
}
