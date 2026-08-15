import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sqlite } from "../db/index.js";
import { createRuntimeAgent, type RuntimeAgent } from "../runtime/agent.js";
import type { AgentMessage, AgentResponse } from "../runtime/protocol.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser, type UserContext } from "../lib/user-context.js";
import { ensureDefaultAiInstanceForUser } from "../lib/user-identity.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { resolveProjectStorageRoot } from "./project-storage-root.js";
import { mastraWorkspaceRegistry } from "../mastra/workspace-registry.js";
import { logger } from "../lib/logger.js";
import { getProjectRuntimeContext } from "../platform/project-registry.js";
import { rememberConversationTurn } from "../lib/weixin-conversation-memory.js";
import {
  storePortalAttachments,
  type IncomingPortalAttachment,
  type StoredAttachment,
} from "../lib/attachment-store.js";
import { findArtifactsForMessage, findArtifactsForTurn, type ConversationArtifactRecord } from "./conversation-artifacts.js";
import { getCurrentTurnId, markTurnStart, markTurnEnd } from "./conversation-turns.js";
import { registerAttachment, ATTACHMENT_RETENTION_MS } from "./file-retention.js";
import {
  AutomationTaskError,
  assertAutomationTaskRunLease,
  claimAutomationTaskRun,
  finishAutomationTaskRun,
  getAutomationTask,
  getAutomationTaskRun,
  readAutomationTaskAsset,
  writeAutomationTaskWorkingAsset,
  type AutomationScope,
  type AutomationTaskRecord,
} from "./automation-tasks.js";
import { writeAutomationSpreadsheetHelper } from "./automation-spreadsheet.js";
import { classifyTaskError, executeWithRetryPolicy, executionResponseError, terminalTaskError } from "./task-execution.js";

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
const conversationChatTails = new Map<string, Promise<void>>();

type ActiveConversationChat = {
  cancelRequested: boolean;
  abortController: AbortController;
};

const activeConversationChats = new Map<string, ActiveConversationChat>();

function conversationChatKey(input: {
  userId: string;
  assistantId: string;
  instanceId: string;
  projectId: string;
  conversationId: string;
}): string {
  return [input.userId, input.assistantId, input.instanceId, input.projectId, input.conversationId].join("\u0000");
}

type AutomationConversationBinding = {
  taskId: string;
  runId: string;
  origin: "automation_manual" | "automation_continue";
};

type PreparedAutomationConversation = {
  workspacePath: string;
  task: AutomationTaskRecord;
  complete(response: AgentResponse): Promise<void>;
  fail(error: unknown): Promise<void>;
  cleanup(): Promise<void>;
};

/**
 * Mastra currently allows only one active turn per conversation. Keep the
 * service entry point consistent with that invariant so the persisted active
 * turn marker cannot be overwritten by a second request.
 */
export async function withConversationChatLock<T>(
  input: { userId: string; instanceId: string; conversationId: string },
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${input.userId}\u0000${input.instanceId}\u0000${input.conversationId}`;
  const previous = conversationChatTails.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  conversationChatTails.set(key, current);
  if (previous) await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (conversationChatTails.get(key) === current) conversationChatTails.delete(key);
  }
}

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
  await ensureDefaultAiInstanceForUser(scope.userId, "mastra");
  if (ACTIVE_BACKEND === "mastra") {
    await mastraWorkspaceRegistry.bootstrap({ userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId });
  } else {
    await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId });
  }
}

function resolveConversationPersistenceScope(input: {
  scope: ConversationScope;
  conversationId: string;
  runtimeProjectId?: string;
}): ConversationScope {
  const existing = sqlite.prepare(`
    SELECT user_id AS userId, project_id AS projectId, instance_id AS instanceId, assistant_id AS assistantId
    FROM conversation_sessions WHERE conversation_id = ?
  `).get(input.conversationId) as ConversationScope | undefined;
  if (!existing) return input.scope;
  if (
    existing.userId !== input.scope.userId
    || existing.instanceId !== input.scope.instanceId
    || existing.assistantId !== input.scope.assistantId
  ) {
    throw new ConversationScopeError();
  }
  const allowedProjectIds = new Set(
    [input.scope.projectId, input.runtimeProjectId].filter((value): value is string => Boolean(value)),
  );
  if (!allowedProjectIds.has(existing.projectId)) throw new ConversationScopeError();
  return { ...input.scope, projectId: existing.projectId };
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

/** Create an empty, scope-bound Portal conversation before its first message. */
export function createConversationSession(input: {
  scope?: Partial<ConversationScope>;
  conversationId: string;
  channel?: ConversationChannel;
  title: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): ConversationSummary {
  const scope = normalizeConversationScope(input.scope);
  const createdAt = input.createdAt || nowIso();
  ensureSession({
    scope,
    conversationId: input.conversationId,
    channel: input.channel || "web",
    title: input.title.trim() || "新对话",
    metadata: input.metadata,
    now: createdAt,
  });
  const row = sqlite.prepare(`
    SELECT conversation_id AS conversationId, title, channel, last_message_preview AS lastMessagePreview,
      message_count AS messageCount, created_at AS createdAt, updated_at AS updatedAt
    FROM conversation_sessions WHERE conversation_id = ? AND user_id = ? AND instance_id = ?
  `).get(input.conversationId, scope.userId, scope.instanceId) as ConversationSummary | undefined;
  if (!row) throw new ConversationScopeError();
  return row;
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

export function getAssistantMessageByRequestId(input: {
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
  const messages = enrichArtifactWorkspacePaths({
    messages: rows.slice(0, limit).map(rowToMessage),
    conversationId: input.conversationId,
    userId: scope.userId,
    instanceId: scope.instanceId,
  });
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
  /** Per-turn model selection (D25); empty/absent = service default model. */
  model?: string;
  /** Internal/test injection point; Portal routes never accept an agent body field. */
  agent?: RuntimeAgent;
}): Promise<ConversationChatResult> {
  if (input.idempotencyKey) {
    const pending = pendingPortalChats.get(input.idempotencyKey);
    if (pending) return pending;
  }
  const scope = normalizeConversationScope(input);
  const key = conversationChatKey({ ...scope, conversationId: input.conversationId });
  const control: ActiveConversationChat = {
    cancelRequested: false,
    abortController: new AbortController(),
  };
  // Register at acceptance rather than after the conversation lock is acquired.
  // This makes cancellation cover queued turns and runtime/Workspace setup before
  // the Mastra turn starts.
  if (!activeConversationChats.has(key)) activeConversationChats.set(key, control);
  const operation = withConversationChatLock(
    { ...scope, conversationId: input.conversationId },
    async () => {
      // A second same-conversation turn may have waited behind the previous
      // turn. Publish its own controller once it becomes the active turn.
      if (activeConversationChats.get(key) !== control) activeConversationChats.set(key, control);
      try {
        return await chatViaConversationLogOnce(input, control);
      } finally {
        if (activeConversationChats.get(key) === control) activeConversationChats.delete(key);
      }
    },
  );
  if (!input.idempotencyKey) return operation;
  pendingPortalChats.set(input.idempotencyKey, operation);
  try {
    return await operation;
  } finally {
    pendingPortalChats.delete(input.idempotencyKey);
  }
}

export async function cancelConversationChat(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  conversationId: string;
}): Promise<{ conversationId: string; status: "cancelled" | "no_active" }> {
  const scope = normalizeConversationScope(input);
  const key = conversationChatKey({ ...scope, conversationId: input.conversationId });
  const control = activeConversationChats.get(key);
  if (control) {
    control.cancelRequested = true;
    control.abortController.abort(new Error("TASK_CANCELLED"));
    return { conversationId: input.conversationId, status: "cancelled" };
  }

  const existing = sqlite.prepare(`
    SELECT user_id AS userId, project_id AS projectId, instance_id AS instanceId, assistant_id AS assistantId
    FROM conversation_sessions WHERE conversation_id = ?
  `).get(input.conversationId) as ConversationScope | undefined;
  if (!existing) return { conversationId: input.conversationId, status: "no_active" };
  const runtime = await getProjectRuntimeContext(scope.instanceId).catch(() => null);
  resolveConversationPersistenceScope({
    scope,
    conversationId: input.conversationId,
    runtimeProjectId: runtime?.projectId,
  });
  const orphanedTurnId = getCurrentTurnId({
    userId: scope.userId,
    instanceId: scope.instanceId,
    conversationId: input.conversationId,
  });
  if (orphanedTurnId) {
    finalizeInterruptedConversationTurn({
      ...scope,
      conversationId: input.conversationId,
      turnId: orphanedTurnId,
      code: "TASK_CANCELLED",
      message: "这项任务已停止，没有继续产生新的结果。",
    });
    return { conversationId: input.conversationId, status: "cancelled" };
  }
  return { conversationId: input.conversationId, status: "no_active" };
}

function finalizeInterruptedConversationTurn(input: ConversationScope & {
  conversationId: string;
  turnId: string;
  code: "TASK_CANCELLED" | "TASK_RUNTIME_RESTARTED";
  message: string;
}): void {
  const existing = getAssistantMessageByRequestId({
    conversationId: input.conversationId,
    requestId: input.turnId,
  });
  if (!existing) {
    appendConversationMessage({
      scope: input,
      conversationId: input.conversationId,
      channel: "web",
      role: "assistant",
      content: input.message,
      status: "failed",
      requestId: input.turnId,
      metadata: {
        executionStatus: "failed",
        executionErrorCode: input.code,
        executionErrorCategory: "cancelled",
        executionRetryable: false,
      },
    });
  }
  markTurnEnd({
    userId: input.userId,
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });
}

export function reconcileInterruptedConversationTurnsOnStartup(): number {
  const rows = sqlite.prepare(`
    SELECT active.user_id AS userId,
           session.project_id AS projectId,
           active.instance_id AS instanceId,
           session.assistant_id AS assistantId,
           active.conversation_id AS conversationId,
           active.turn_id AS turnId
    FROM conversation_turn_active active
    JOIN conversation_sessions session
      ON session.conversation_id = active.conversation_id
     AND session.user_id = active.user_id
     AND session.instance_id = active.instance_id
  `).all() as Array<ConversationScope & { conversationId: string; turnId: string }>;
  for (const row of rows) {
    finalizeInterruptedConversationTurn({
      ...row,
      code: "TASK_RUNTIME_RESTARTED",
      message: "这项任务因服务重启而中断，未继续执行。",
    });
  }
  return rows.length;
}

function automationConversationBinding(input: {
  scope: ConversationScope;
  conversationId: string;
}): AutomationConversationBinding | null {
  const row = sqlite.prepare(`
    SELECT metadata
    FROM conversation_sessions
    WHERE conversation_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND assistant_id = ?
  `).get(
    input.conversationId,
    input.scope.userId,
    input.scope.projectId,
    input.scope.instanceId,
    input.scope.assistantId,
  ) as { metadata?: string } | undefined;
  const metadata = parseMetadata(row?.metadata);
  const taskId = typeof metadata?.taskId === "string" ? metadata.taskId : "";
  const runId = typeof metadata?.runId === "string" ? metadata.runId : "";
  const origin = metadata?.origin;
  if (!taskId || !runId || (origin !== "automation_manual" && origin !== "automation_continue")) return null;
  return { taskId, runId, origin };
}

function automationScope(scope: ConversationScope): AutomationScope {
  return { userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId };
}

function assertAutomationAgentSucceeded(response: AgentResponse) {
  if (response.data?.executionStatus !== "failed") return;
  const code = typeof response.data.executionErrorCode === "string"
    ? response.data.executionErrorCode
    : "AGENT_TURN_FAILED";
  throw new Error(code);
}

/**
 * A chat created from an automation run must not silently regain the whole
 * user Workspace. Each explicit follow-up gets a fresh two-file staging area
 * and only a validated working-file replacement can leave that area.
 */
async function prepareAutomationConversation(input: {
  scope: ConversationScope;
  binding: AutomationConversationBinding;
  conversationId: string;
  idempotencyKey: string;
}): Promise<PreparedAutomationConversation> {
  const scoped = automationScope(input.scope);
  const task = await getAutomationTask({ ...scoped, taskId: input.binding.taskId });
  if (!task?.sourceAsset || !task.workingAsset) throw new ConversationScopeError();
  const sourceRun = await getAutomationTaskRun({ ...scoped, runId: input.binding.runId });
  if (!sourceRun || sourceRun.taskId !== task.taskId) throw new ConversationScopeError();
  const claimed = await claimAutomationTaskRun({
    ...scoped,
    taskId: task.taskId,
    origin: "manual",
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!claimed.claimed) {
    throw new AutomationTaskError(
      "AUTOMATION_TASK_BUSY",
      "当前任务已有运行中的执行，请等待完成后再试。",
    );
  }
  const followUpRun = claimed.run;

  const workspaceRoot = ACTIVE_BACKEND === "mastra"
    ? await resolveProjectStorageRoot({ userId: scoped.userId, projectId: scoped.projectId, instanceId: scoped.instanceId })
    : (await ensureWorkspace({ userId: scoped.userId, tenantId: scoped.userId, projectId: scoped.projectId })).path || resolveWorkspacePath(scoped.userId);
  const stagingPath = await mkdtemp(path.join(workspaceRoot, ".automation-conversation-"));
  const sourceDirectory = path.join(stagingPath, "source");
  const workingDirectory = path.join(stagingPath, "working");
  try {
    await Promise.all([
      mkdir(sourceDirectory, { mode: 0o700 }),
      mkdir(workingDirectory, { mode: 0o700 }),
    ]);
    const [source, working] = await Promise.all([
      readAutomationTaskAsset({ ...scoped, assetId: task.sourceAsset.assetId }),
      readAutomationTaskAsset({ ...scoped, assetId: task.workingAsset.assetId }),
    ]);
    const workingPath = path.join(workingDirectory, working.fileName);
    await Promise.all([
      writeFile(path.join(sourceDirectory, source.fileName), source.bytes, { flag: "wx", mode: 0o600 }),
      writeFile(workingPath, working.bytes, { flag: "wx", mode: 0o600 }),
    ]);
    await writeAutomationSpreadsheetHelper(stagingPath);
    return {
      workspacePath: stagingPath,
      task,
      async complete(response) {
        assertAutomationAgentSucceeded(response);
        const outputStat = await lstat(workingPath).catch(() => null);
        if (!outputStat || outputStat.isSymbolicLink() || !outputStat.isFile()) {
          throw new Error("AUTOMATION_WORKING_OUTPUT_MISSING");
        }
        const bytes = await readFile(workingPath);
        await assertAutomationTaskRunLease({ ...scoped, runId: followUpRun.runId, leaseToken: followUpRun.leaseToken });
        const output = bytes.equals(working.bytes) ? task.workingAsset : await writeAutomationTaskWorkingAsset({
          ...scoped,
          taskId: task.taskId,
          revisionId: task.currentRevisionId || undefined,
          asset: { fileName: working.fileName, mimeType: working.mimeType, bytes },
        });
        await finishAutomationTaskRun({
          ...scoped,
          runId: followUpRun.runId,
          leaseToken: followUpRun.leaseToken,
          status: "succeeded",
          resultSummary: response.content.text || "自动化后续操作完成。",
          outputAssetId: output?.assetId,
          outputChecksum: output?.checksum,
          traceId: followUpRun.runId,
        });
      },
      async fail(error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await finishAutomationTaskRun({
          ...scoped,
          runId: followUpRun.runId,
          leaseToken: followUpRun.leaseToken,
          status: "failed",
          errorMessage,
          traceId: followUpRun.runId,
        }).catch(() => undefined);
      },
      cleanup: () => rm(stagingPath, { recursive: true, force: true }),
    };
  } catch (error) {
    await finishAutomationTaskRun({
      ...scoped,
      runId: followUpRun.runId,
      leaseToken: followUpRun.leaseToken,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      traceId: followUpRun.runId,
    }).catch(() => undefined);
    await rm(stagingPath, { recursive: true, force: true });
    throw error;
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
  model?: string;
  agent?: RuntimeAgent;
}, control: ActiveConversationChat): Promise<ConversationChatResult> {
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
  const persistenceScope = resolveConversationPersistenceScope({
    scope,
    conversationId: input.conversationId,
    runtimeProjectId: runtime?.projectId,
  });
  const automationBinding = automationConversationBinding({ scope: persistenceScope, conversationId: input.conversationId });
  if (automationBinding && (input.attachments?.length ?? 0) > 0) {
    throw new Error("AUTOMATION_CONVERSATION_ATTACHMENTS_UNSUPPORTED");
  }
  const workspaceRoot = ACTIVE_BACKEND === "mastra"
    ? await resolveProjectStorageRoot({ userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId })
    : (await ensureWorkspace({ userId: scope.userId, tenantId: scope.userId, projectId: scope.projectId })).path;
  const requestId = `portal-${randomUUID()}`;
  const automationConversation = automationBinding
    ? await prepareAutomationConversation({
      scope: persistenceScope,
      binding: automationBinding,
      conversationId: input.conversationId,
      idempotencyKey: `automation-chat:${input.conversationId}:${requestId}`,
    })
    : null;
  const storedAttachments = await storePortalAttachments({
    workspacePath: workspaceRoot,
    attachments: input.attachments,
  });
  const userTextForAgent = automationConversation
    ? [
      "这是一次受控自动化任务的后续互动。",
      `任务名称：${automationConversation.task.revision.name}`,
      `任务说明：${automationConversation.task.revision.description || "（未提供额外说明）"}`,
      `源文件：source/${automationConversation.task.sourceAsset?.fileName || "source"}`,
      `工作文件：working/${automationConversation.task.workingAsset?.fileName || "working"}`,
      "只能读取 source/ 与 working/ 的当前任务文件；不得修改 source/，不得访问其他文件或确定性投资状态。XLSX 使用当前目录的 automation-sheet.mjs 结构化读取/写入，不能按纯文本拼接。若用户要求修改任务的规则、时间、文件绑定或启停，说明必须回到自动化任务编辑页，而不要静默修改。",
      `用户本次要求：${String(input.text || "请说明本次运行结果")}`,
    ].join("\n")
    : buildPortalUserText(input.text, storedAttachments);
  const userMetadata = storedAttachments.length > 0
    ? { attachments: storedAttachments.map((stored) => toPublicAttachmentDescriptorWithExpiry(stored)) }
    : undefined;
  const userMessage = appendConversationMessage({
    scope: persistenceScope,
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
  // Persist each uploaded attachment in the authoritative
  // `conversation_attachments` table so the 7-day TTL is computed server-side
  // (not guessed from the date directory) and the cleanup job has a row to
  // act on. The messageId binding is back-filled once the message is saved.
  for (const stored of storedAttachments) {
    try {
      registerAttachment({
        userId: scope.userId,
        projectId: runtime?.projectId || scope.projectId,
        instanceId: runtime?.instanceId || scope.instanceId,
        conversationId: input.conversationId,
        messageId: userMessage.messageId,
        stored,
      });
    } catch (error) {
      logger.warn(`failed to register attachment row userId=${scope.userId} attachmentId=${stored.id}: ${(error as Error).message}`);
    }
  }

  const agent = input.agent ?? createRuntimeAgent();
  const agentMessage: AgentMessage = {
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
      workspacePath: automationConversation?.workspacePath || workspaceRoot,
      ...(automationConversation ? { taskType: "scheduled-automation" } : {}),
      ...(automationBinding ? { runId: automationBinding.runId, taskId: automationBinding.taskId } : {}),
      attachments: storedAttachments,
      ...(input.model ? { model: input.model } : {}),
      _cancelSignal: control.abortController.signal,
    },
  };
  // Mark the active turn so any MCP `artifacts.publish` / `reviews.save`
  // call made by the runtime records this requestId as its `turn_id`.
  // The assistant message is also stored with the same requestId, which
  // lets us bind artifacts deterministically instead of attaching every
  // unbound conversation-level artifact to whichever reply finishes next.
  const turnScope = {
    userId: scope.userId,
    instanceId: runtime?.instanceId || scope.instanceId,
    conversationId: input.conversationId,
  };
  const persistResponse = async (response: AgentResponse, automationFailure: boolean, messageId?: string): Promise<ConversationChatResult> => {
    const assistantText = response.content.text ?? "处理完成，但没有生成文本回复。";
    const inlineVisuals = Array.isArray(response.data?.inlineVisuals) ? response.data.inlineVisuals : undefined;
    const assistantMessage = appendConversationMessage({
      scope: persistenceScope,
      conversationId: input.conversationId,
      channel: "web",
      role: "assistant",
      content: assistantText,
      ...(automationFailure ? { status: "failed" as const } : {}),
      ...(messageId ? { messageId } : {}),
      requestId,
    metadata: (() => {
      const responseError = executionResponseError(response);
      return {
        ...(inlineVisuals && inlineVisuals.length > 0 ? { inlineVisuals } : {}),
        ...(responseError ? {
          executionStatus: "failed",
          executionErrorCode: responseError.code,
          executionErrorCategory: responseError.category,
          executionRetryable: responseError.retryable,
        } : {}),
      };
    })(),
    });
    const responseError = executionResponseError(response);
    const artifacts = responseError?.category === "cancelled"
      ? []
      : attachArtifactsToAssistantMessage({
        conversationId: input.conversationId,
        assistantMessageId: assistantMessage.messageId,
        userId: scope.userId,
        instanceId: runtime?.instanceId || scope.instanceId,
        turnId: requestId,
      });
    await rememberConversationTurn({
      userId: scope.userId,
      projectId: runtime?.projectId || scope.projectId,
      instanceId: runtime?.instanceId || scope.instanceId,
      instanceExpansionPath: runtime?.instanceExpansionPath,
      workspacePath: workspaceRoot,
      channel: "web",
      conversationId: input.conversationId,
    }, userTextForAgent, assistantText);
    return {
      conversationId: input.conversationId,
      userMessage,
      assistantMessage: withArtifactMetadata(assistantMessage, artifacts),
      traceId: requestId,
    };
  };

  const cleanupTurn = async () => {
    markTurnEnd({ ...turnScope, turnId: requestId });
    await automationConversation?.cleanup();
  };
  markTurnStart({ ...turnScope, turnId: requestId });
  let response: AgentResponse;
  let automationFailure = false;
  try {
    if (control.cancelRequested) throw new Error("TASK_CANCELLED");
    response = await executeWithRetryPolicy(
      () => agent.handleMessage(agentMessage),
      {
        executionBudgetMs: Number(process.env.PORTAL_EXECUTION_BUDGET_MS) || undefined,
        isRetryableResult: (candidate) => Boolean(executionResponseError(candidate)?.retryable),
      },
    );
    if (control.cancelRequested) throw new Error("TASK_CANCELLED");
    const responseError = executionResponseError(response);
    automationFailure = Boolean(responseError);
    if (responseError && !automationConversation) {
      const terminal = terminalTaskError(responseError);
      response = {
        content: { type: "text", text: terminal.userMessage },
        finished: true,
        data: {
          executionStatus: "failed",
          executionErrorCode: terminal.code,
          executionErrorCategory: terminal.category,
          executionRetryable: false,
        },
      };
    }
    if (automationConversation) await automationConversation.complete(response);
  } catch (error) {
    automationFailure = true;
    const classified = terminalTaskError(classifyTaskError(error));
    response = {
      content: {
        type: "text",
        text: automationConversation
          ? "这次自动化后续操作失败了，工作文件没有被修改。请查看运行详情后重试。"
          : classified.userMessage,
      },
      finished: true,
      data: {
        executionStatus: "failed",
        executionErrorCode: classified.code,
        executionErrorCategory: classified.category,
        executionRetryable: false,
      },
    };
  }
  try {
    return await persistResponse(response, automationFailure);
  } finally {
    await cleanupTurn();
  }
}

function withArtifactMetadata(
  message: ConversationMessageRecord,
  artifacts: ConversationArtifactRecord[] | undefined,
): ConversationMessageRecord {
  if (!artifacts || artifacts.length === 0) return message;
  const baseMetadata = (message.metadata ?? {}) as Record<string, unknown>;
  return {
    ...message,
    metadata: { ...baseMetadata, artifacts: artifacts.map(toPublicArtifactDescriptor) },
  };
}

function toPublicArtifactDescriptor(artifact: ConversationArtifactRecord) {
  return {
    artifactId: artifact.artifactId,
    title: artifact.title,
    fileName: artifact.fileName,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    kind: artifact.kind,
    previewMode: artifact.previewMode,
    createdAt: artifact.createdAt,
    checksum: artifact.checksum,
    assetId: artifact.assetId ?? null,
    versionId: artifact.versionId ?? null,
    savedToMyFiles: Boolean(artifact.assetId && artifact.versionId),
    workspacePath: browsableArtifactWorkspacePath(artifact),
  };
}

function enrichArtifactWorkspacePaths(input: {
  messages: ConversationMessageRecord[];
  conversationId: string;
  userId: string;
  instanceId: string;
}): ConversationMessageRecord[] {
  const rows = sqlite.prepare(`
    SELECT artifact_id AS artifactId, relative_path AS relativePath, preview_mode AS previewMode,
           asset_id AS assetId, version_id AS versionId
    FROM conversation_artifacts
    WHERE conversation_id = ? AND user_id = ? AND instance_id = ?
  `).all(input.conversationId, input.userId, input.instanceId) as Array<{
    artifactId: string;
    relativePath: string;
    previewMode: string;
    assetId: string | null;
    versionId: string | null;
  }>;
  const details = new Map(
    rows.map((row) => [row.artifactId, {
      workspacePath: isWorkspaceBrowsablePreviewMode(row.previewMode) ? row.relativePath : undefined,
      savedToMyFiles: Boolean(row.assetId && row.versionId),
    }] as const),
  );
  if (details.size === 0) return input.messages;
  return input.messages.map((message) => {
    const artifacts = message.metadata?.artifacts;
    if (!Array.isArray(artifacts)) return message;
    let changed = false;
    const enriched = artifacts.map((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
      const record = artifact as Record<string, unknown>;
      const detail = typeof record.artifactId === "string" ? details.get(record.artifactId) : undefined;
      if (!detail) return artifact;
      const workspacePathChanged = detail.workspacePath && record.workspacePath !== detail.workspacePath;
      const saveStateChanged = record.savedToMyFiles !== detail.savedToMyFiles;
      if (!workspacePathChanged && !saveStateChanged) return artifact;
      changed = true;
      return {
        ...record,
        ...(workspacePathChanged ? { workspacePath: detail.workspacePath } : {}),
        savedToMyFiles: detail.savedToMyFiles,
      };
    });
    return changed
      ? { ...message, metadata: { ...message.metadata, artifacts: enriched } }
      : message;
  });
}

function browsableArtifactWorkspacePath(artifact: ConversationArtifactRecord): string | undefined {
  return isWorkspaceBrowsablePreviewMode(artifact.previewMode) ? artifact.relativePath : undefined;
}

function isWorkspaceBrowsablePreviewMode(previewMode: string): boolean {
  return previewMode === "markdown" || previewMode === "html" || previewMode === "image";
}

/**
 * Attachment descriptor embedded in message metadata. Includes the
 * authoritative `expiresAt` so the Portal can render a deterministic
 * "附件已过期" card without ever guessing from the date directory. The
 * `attachmentId` is the only key the client needs to read or download bytes;
 * it never receives the raw workspace path.
 */
function toPublicAttachmentDescriptorWithExpiry(stored: StoredAttachment, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ATTACHMENT_RETENTION_MS).toISOString();
  return {
    attachmentId: stored.id,
    type: stored.type,
    mimeType: stored.mimeType,
    fileName: stored.fileName,
    sizeBytes: stored.sizeBytes,
    relativePath: stored.relativePath,
    source: stored.source,
    checksum: stored.checksum,
    expiresAt,
  };
}

function attachArtifactsToAssistantMessage(input: {
  conversationId: string;
  assistantMessageId: string;
  userId: string;
  instanceId: string;
  turnId: string;
}): ConversationArtifactRecord[] | undefined {
  // Bind artifacts by their explicit `turn_id`, not by `message_id IS NULL`.
  // The turnId was recorded on each artifact row at publish time (see
  // `publishConversationArtifact`) and is the same requestId that was
  // stored on the assistant message. This means only the artifacts that
  // were truly produced during THIS specific Mastra turn can attach to this
  // assistant message, even if another turn publishes artifacts moments
  // later or in parallel.
  const pending = findArtifactsForTurn({
    userId: input.userId,
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });
  if (pending.length === 0) return undefined;
  const now = new Date().toISOString();
  const update = sqlite.prepare(
    `UPDATE conversation_artifacts
     SET message_id = ?, updated_at = ?
     WHERE artifact_id = ? AND turn_id = ?`,
  );
  for (const row of pending) {
    update.run(input.assistantMessageId, now, row.artifactId, input.turnId);
  }
  const records = findArtifactsForMessage({
    userId: input.userId,
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    messageId: input.assistantMessageId,
  });
  const descriptors = records.map((record) => ({
    artifactId: record.artifactId,
    title: record.title,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    kind: record.kind,
    previewMode: record.previewMode,
    createdAt: record.createdAt,
    checksum: record.checksum,
    savedToMyFiles: Boolean(record.assetId && record.versionId),
    workspacePath: browsableArtifactWorkspacePath(record),
  }));
  if (descriptors.length === 0) return undefined;
  const existing = sqlite
    .prepare("SELECT metadata FROM conversation_messages WHERE message_id = ?")
    .get(input.assistantMessageId) as { metadata?: string } | undefined;
  const parsed = parseMetadata(existing?.metadata) ?? {};
  const merged = { ...parsed, artifacts: descriptors };
  sqlite.prepare("UPDATE conversation_messages SET metadata = ? WHERE message_id = ?").run(
    JSON.stringify(merged),
    input.assistantMessageId,
  );
  return records;
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

/** Test-only hooks for the automation conversation isolation boundary. */
export const __test__ = {
  automationConversationBinding,
  prepareAutomationConversation,
  resolveConversationPersistenceScope,
};
