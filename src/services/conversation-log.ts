import { randomUUID } from "node:crypto";
import { sqlite } from "../db/index.js";
import { createAgent } from "../acp/agent.js";
import type { AcpMessage } from "../acp/protocol.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser, type UserContext } from "../lib/user-context.js";
import { ensureDefaultAiInstanceForUser } from "../lib/user-identity.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { getProjectRuntimeContext } from "../platform/project-registry.js";
import { rememberConversationTurn } from "../lib/weixin-conversation-memory.js";
import {
  storePortalAttachments,
  toPublicAttachmentMetadata,
  type IncomingPortalAttachment,
  type StoredAttachment,
} from "../lib/attachment-store.js";

export type ConversationChannel = "web" | "weixin-mobile";
export type ConversationRole = "user" | "assistant" | "system";
export type ConversationStatus = "pending" | "sent" | "failed";

export interface ConversationScope {
  userId: string;
  assistantId: string;
  instanceId: string;
  projectId: string;
}

export interface ConversationSummary {
  conversationId: string;
  title: string;
  channel: ConversationChannel;
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageRecord {
  messageId: string;
  conversationId: string;
  userId: string;
  assistantId: string;
  instanceId: string;
  channel: ConversationChannel;
  role: ConversationRole;
  content: string;
  status: ConversationStatus;
  traceId?: string;
  requestId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationChatResult {
  conversationId: string;
  userMessage: ConversationMessageRecord;
  assistantMessage: ConversationMessageRecord;
  traceId?: string;
}

export class ConversationScopeError extends Error {
  constructor() {
    super("CONVERSATION_SCOPE_MISMATCH");
    this.name = "ConversationScopeError";
  }
}

const pendingPortalChats = new Map<string, Promise<ConversationChatResult>>();

function nowIso() {
  return new Date().toISOString();
}

function clipPreview(text: string, limit = 120) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function titleFromText(text: string) {
  const normalized = clipPreview(text, 32);
  return normalized || "新对话";
}

function metadataJson(value?: Record<string, unknown>) {
  return JSON.stringify(value || {});
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeConversationScope(input: Partial<ConversationScope> = {}): ConversationScope {
  const userId = input.userId?.trim() || DEFAULT_USER_ID;
  const instanceId = input.instanceId?.trim() || defaultInstanceIdForUser(userId);
  return {
    userId,
    projectId: input.projectId?.trim() || DEFAULT_PROJECT_ID,
    instanceId,
    assistantId: input.assistantId?.trim() || instanceId || DEFAULT_INSTANCE_ID,
  };
}

export async function ensureConversationRuntime(scope: ConversationScope) {
  await ensureDefaultAiInstanceForUser(scope.userId, "codex");
  await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
}

function ensureSession(input: {
  scope: ConversationScope;
  conversationId: string;
  channel: ConversationChannel;
  title?: string;
  now: string;
  metadata?: Record<string, unknown>;
}) {
  sqlite.prepare(`
    INSERT INTO conversation_sessions (
      conversation_id, user_id, project_id, instance_id, assistant_id, channel, title,
      last_message_preview, message_count, status, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'active', ?, ?, ?)
    ON CONFLICT(conversation_id) DO NOTHING
  `).run(
    input.conversationId,
    input.scope.userId,
    input.scope.projectId,
    input.scope.instanceId,
    input.scope.assistantId,
    input.channel,
    input.title || "新对话",
    metadataJson(input.metadata),
    input.now,
    input.now
  );
  const existing = sqlite.prepare(`
    SELECT user_id AS userId, project_id AS projectId, instance_id AS instanceId, assistant_id AS assistantId
    FROM conversation_sessions WHERE conversation_id = ?
  `).get(input.conversationId) as ConversationScope | undefined;
  if (!existing || existing.userId !== input.scope.userId || existing.projectId !== input.scope.projectId || existing.instanceId !== input.scope.instanceId || existing.assistantId !== input.scope.assistantId) {
    throw new ConversationScopeError();
  }
}

function refreshSession(input: {
  conversationId: string;
  preview: string;
  now: string;
  fallbackTitle?: string;
}) {
  const row = sqlite.prepare(`
    SELECT title, message_count AS messageCount FROM conversation_sessions WHERE conversation_id = ?
  `).get(input.conversationId) as { title?: string; messageCount?: number } | undefined;
  const shouldRetitle = !row?.title || row.title === "新对话";
  sqlite.prepare(`
    UPDATE conversation_sessions
    SET
      title = CASE WHEN ? THEN ? ELSE title END,
      last_message_preview = ?,
      message_count = (
        SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?
      ),
      updated_at = ?
    WHERE conversation_id = ?
  `).run(
    shouldRetitle ? 1 : 0,
    input.fallbackTitle || "新对话",
    input.preview,
    input.conversationId,
    input.now,
    input.conversationId
  );
}

function rowToMessage(row: any): ConversationMessageRecord {
  return {
    messageId: row.messageId,
    conversationId: row.conversationId,
    userId: row.userId,
    assistantId: row.assistantId,
    instanceId: row.instanceId,
    channel: row.channel,
    role: row.role,
    content: row.content,
    status: row.status,
    traceId: row.traceId ?? undefined,
    requestId: row.requestId ?? undefined,
    createdAt: row.createdAt,
    metadata: parseMetadata(row.metadata),
  };
}

export function appendConversationMessage(input: {
  scope?: Partial<ConversationScope>;
  conversationId: string;
  channel: ConversationChannel;
  role: ConversationRole;
  content: string;
  status?: ConversationStatus;
  messageId?: string;
  requestId?: string;
  traceId?: string;
  idempotencyKey?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}): ConversationMessageRecord {
  const scope = normalizeConversationScope(input.scope);
  if (input.idempotencyKey) {
    const existing = sqlite.prepare(`
      SELECT message_id AS messageId
      FROM conversation_messages
      WHERE idempotency_key = ?
      LIMIT 1
    `).get(input.idempotencyKey) as { messageId: string } | undefined;
    if (existing?.messageId) {
      return getConversationMessage(existing.messageId)!;
    }
  }
  const createdAt = input.createdAt || nowIso();
  const messageId = input.messageId || `${input.channel}-${input.role}-${randomUUID()}`;
  const content = input.content || "";
  const title = input.role === "user" ? titleFromText(content) : undefined;
  const transaction = sqlite.transaction(() => {
    ensureSession({
      scope,
      conversationId: input.conversationId,
      channel: input.channel,
      title,
      now: createdAt,
    });
    sqlite.prepare(`
      INSERT INTO conversation_messages (
        message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel,
        role, content, status, trace_id, request_id, idempotency_key, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        content = excluded.content,
        status = excluded.status,
        trace_id = COALESCE(excluded.trace_id, conversation_messages.trace_id),
        request_id = COALESCE(excluded.request_id, conversation_messages.request_id),
        metadata = excluded.metadata
    `).run(
      messageId,
      input.conversationId,
      scope.userId,
      scope.projectId,
      scope.instanceId,
      scope.assistantId,
      input.channel,
      input.role,
      content,
      input.status || "sent",
      input.traceId ?? null,
      input.requestId ?? null,
      input.idempotencyKey ?? null,
      metadataJson(input.metadata),
      createdAt
    );
    refreshSession({
      conversationId: input.conversationId,
      preview: clipPreview(content),
      fallbackTitle: title,
      now: createdAt,
    });
    if (input.role === "assistant") {
      // Release a queued onboarding commit only after this response is durable.
      // This is intentionally structural, never a parse of customer wording.
      sqlite.prepare(`
        UPDATE onboarding_drafts
        SET handoff_message_id = ?, updated_at = ?
        WHERE user_id = ? AND instance_id = ? AND conversation_id = ?
          AND status = 'queued' AND handoff_message_id IS NULL AND queued_at <= ?
      `).run(messageId, createdAt, scope.userId, scope.instanceId, input.conversationId, createdAt);
    }
  });
  transaction();
  return getConversationMessage(messageId) ?? {
    messageId,
    conversationId: input.conversationId,
    userId: scope.userId,
    assistantId: scope.assistantId,
    instanceId: scope.instanceId,
    channel: input.channel,
    role: input.role,
    content,
    status: input.status || "sent",
    traceId: input.traceId,
    requestId: input.requestId,
    createdAt,
    metadata: input.metadata,
  };
}

export function getConversationMessage(messageId: string): ConversationMessageRecord | null {
  const row = sqlite.prepare(`
    SELECT
      message_id AS messageId,
      conversation_id AS conversationId,
      user_id AS userId,
      assistant_id AS assistantId,
      instance_id AS instanceId,
      channel,
      role,
      content,
      status,
      trace_id AS traceId,
      request_id AS requestId,
      metadata,
      created_at AS createdAt
    FROM conversation_messages
    WHERE message_id = ?
  `).get(messageId);
  return row ? rowToMessage(row) : null;
}

export function getConversationMessageByIdempotencyKey(input: { idempotencyKey: string; scope: ConversationScope; conversationId: string }): ConversationMessageRecord | null {
  const row = sqlite.prepare(`
    SELECT
      message_id AS messageId,
      conversation_id AS conversationId,
      user_id AS userId,
      assistant_id AS assistantId,
      instance_id AS instanceId,
      channel,
      role,
      content,
      status,
      trace_id AS traceId,
      request_id AS requestId,
      metadata,
      created_at AS createdAt
    FROM conversation_messages
    WHERE idempotency_key = ? AND conversation_id = ? AND user_id = ? AND instance_id = ?
    LIMIT 1
  `).get(input.idempotencyKey, input.conversationId, input.scope.userId, input.scope.instanceId);
  return row ? rowToMessage(row) : null;
}

function getAssistantMessageByRequestId(input: {
  conversationId: string;
  requestId: string;
}): ConversationMessageRecord | null {
  const row = sqlite.prepare(`
    SELECT
      message_id AS messageId,
      conversation_id AS conversationId,
      user_id AS userId,
      assistant_id AS assistantId,
      instance_id AS instanceId,
      channel,
      role,
      content,
      status,
      trace_id AS traceId,
      request_id AS requestId,
      metadata,
      created_at AS createdAt
    FROM conversation_messages
    WHERE conversation_id = ? AND request_id = ? AND role = 'assistant'
    ORDER BY created_at ASC, rowid ASC
    LIMIT 1
  `).get(input.conversationId, input.requestId);
  return row ? rowToMessage(row) : null;
}

export function listConversations(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  channel?: ConversationChannel;
  cursor?: string;
  limit?: number;
}) {
  const scope = normalizeConversationScope(input);
  const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
  const offset = Math.max(Number(input.cursor || 0) || 0, 0);
  const params: unknown[] = [scope.userId, scope.instanceId];
  let channelSql = "";
  if (input.channel) {
    channelSql = " AND channel = ?";
    params.push(input.channel);
  }
  params.push(limit + 1, offset);
  const rows = sqlite.prepare(`
    SELECT
      conversation_id AS conversationId,
      title,
      channel,
      last_message_preview AS lastMessagePreview,
      message_count AS messageCount,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM conversation_sessions
    WHERE user_id = ? AND instance_id = ?${channelSql}
    ORDER BY updated_at DESC, conversation_id DESC
    LIMIT ? OFFSET ?
  `).all(...params) as ConversationSummary[];
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? String(offset + limit) : undefined,
  };
}

export function getConversation(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  conversationId: string;
  cursor?: string;
  limit?: number;
}) {
  const scope = normalizeConversationScope(input);
  const limit = Math.min(Math.max(Number(input.limit || 100), 1), 200);
  const offset = Math.max(Number(input.cursor || 0) || 0, 0);
  const session = sqlite.prepare(`
    SELECT conversation_id AS conversationId, title
    FROM conversation_sessions
    WHERE conversation_id = ? AND user_id = ? AND instance_id = ?
  `).get(input.conversationId, scope.userId, scope.instanceId) as { conversationId: string; title: string } | undefined;
  if (!session) {
    return {
      conversationId: input.conversationId,
      title: "新对话",
      messages: [] as ConversationMessageRecord[],
      nextCursor: undefined as string | undefined,
    };
  }
  const rows = sqlite.prepare(`
    SELECT
      message_id AS messageId,
      conversation_id AS conversationId,
      user_id AS userId,
      assistant_id AS assistantId,
      instance_id AS instanceId,
      channel,
      role,
      content,
      status,
      trace_id AS traceId,
      request_id AS requestId,
      metadata,
      created_at AS createdAt
    FROM conversation_messages
    WHERE conversation_id = ? AND user_id = ? AND instance_id = ?
    ORDER BY created_at ASC, rowid ASC
    LIMIT ? OFFSET ?
  `).all(input.conversationId, scope.userId, scope.instanceId, limit + 1, offset) as any[];
  const messages = rows.slice(0, limit).map(rowToMessage);
  return {
    conversationId: session.conversationId,
    title: session.title,
    messages,
    nextCursor: rows.length > limit ? String(offset + limit) : undefined,
  };
}

export async function chatViaConversationLog(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  conversationId: string;
  userMessageId?: string;
  text?: string;
  attachments?: IncomingPortalAttachment[];
  idempotencyKey?: string;
  clientSentAt?: string;
}): Promise<ConversationChatResult> {
  if (input.idempotencyKey) {
    const pending = pendingPortalChats.get(input.idempotencyKey);
    if (pending) return pending;
  }
  const operation = chatViaConversationLogOnce(input);
  if (!input.idempotencyKey) return operation;
  pendingPortalChats.set(input.idempotencyKey, operation);
  try {
    return await operation;
  } finally {
    pendingPortalChats.delete(input.idempotencyKey);
  }
}

async function chatViaConversationLogOnce(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  conversationId: string;
  userMessageId?: string;
  text?: string;
  attachments?: IncomingPortalAttachment[];
  idempotencyKey?: string;
  clientSentAt?: string;
}): Promise<ConversationChatResult> {
  const scope = normalizeConversationScope(input);
  if (input.idempotencyKey) {
    const existingUserMessage = getConversationMessageByIdempotencyKey({
      idempotencyKey: input.idempotencyKey,
      scope,
      conversationId: input.conversationId,
    });
    if (existingUserMessage?.requestId) {
      const existingAssistantMessage = getAssistantMessageByRequestId({
        conversationId: input.conversationId,
        requestId: existingUserMessage.requestId,
      });
      if (existingAssistantMessage) {
        return {
          conversationId: input.conversationId,
          userMessage: existingUserMessage,
          assistantMessage: existingAssistantMessage,
          traceId: existingUserMessage.requestId,
        };
      }
    }
  }

  await ensureConversationRuntime(scope);
  const runtime = await getProjectRuntimeContext(scope.instanceId).catch(() => null);
  const workspace = await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  const storedAttachments = await storePortalAttachments({
    workspacePath: workspace.path || resolveWorkspacePath(scope.userId),
    attachments: input.attachments,
  });
  const userTextForAgent = buildPortalUserText(input.text, storedAttachments);
  const userMetadata = storedAttachments.length > 0
    ? { attachments: storedAttachments.map(toPublicAttachmentMetadata) }
    : undefined;
  const requestId = `portal-${randomUUID()}`;
  const userMessage = appendConversationMessage({
    scope,
    conversationId: input.conversationId,
    channel: "web",
    role: "user",
    content: userTextForAgent,
    messageId: input.userMessageId,
    idempotencyKey: input.idempotencyKey,
    requestId,
    createdAt: input.clientSentAt,
    metadata: userMetadata,
  });

  const agent = createAgent();
  const acpMessage: AcpMessage = {
    id: requestId,
    from: input.conversationId,
    timestamp: Date.now(),
    content: { type: "text", text: userTextForAgent },
    context: {
      channel: "web",
      conversationId: input.conversationId,
      userId: scope.userId,
      projectId: runtime?.projectId || scope.projectId,
      instanceId: runtime?.instanceId || scope.instanceId,
      instanceExpansionPath: runtime?.instanceExpansionPath,
      workspacePath: workspace.path || resolveWorkspacePath(scope.userId),
      attachments: storedAttachments,
    },
  };
  const response = await agent.handleMessage(acpMessage);
  const assistantText = response.content.text ?? "处理完成，但没有生成文本回复。";
  const assistantMessage = appendConversationMessage({
    scope: {
      ...scope,
      projectId: runtime?.projectId || scope.projectId,
      instanceId: runtime?.instanceId || scope.instanceId,
      assistantId: runtime?.instanceId || scope.assistantId,
    },
    conversationId: input.conversationId,
    channel: "web",
    role: "assistant",
    content: assistantText,
    requestId,
  });
  await rememberConversationTurn({
    userId: scope.userId,
    projectId: runtime?.projectId || scope.projectId,
    instanceId: runtime?.instanceId || scope.instanceId,
    instanceExpansionPath: runtime?.instanceExpansionPath,
    workspacePath: workspace.path || resolveWorkspacePath(scope.userId),
    channel: "web",
    conversationId: input.conversationId,
  }, userTextForAgent, assistantText);
  return {
    conversationId: input.conversationId,
    userMessage,
    assistantMessage,
    traceId: requestId,
  };
}

function buildPortalUserText(text: string | undefined, attachments: StoredAttachment[]) {
  const trimmed = text?.trim();
  if (trimmed) return trimmed;
  const hasDocument = attachments.some((item) => item.type === "document");
  const hasImage = attachments.some((item) => item.type === "image");
  if (hasDocument && !hasImage) {
    return "用户上传了一份文档，请先概括内容并说明可提取的信息。";
  }
  if (hasImage && !hasDocument) {
    return "用户上传了一张图片，请识别其中可能的持仓、观察仓、交易记录或投资相关信息。";
  }
  if (attachments.length > 0) {
    return "用户上传了图片和文档，请先识别附件内容，并说明其中可提取的投资相关信息。";
  }
  return "";
}
