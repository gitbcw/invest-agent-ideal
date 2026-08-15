import type { Database } from "better-sqlite3";
import type {
  ConversationChannel,
  ConversationMessage,
  ConversationSummary
} from "@/lib/protocol";

/**
 * Shared-database conversation repository (2026-08-15 DB merge).
 *
 * Reads authoritative conversation data directly from the runtime's
 * `conversation_sessions` / `conversation_messages` tables. Presentation
 * state (pin/archive/label/custom title) lives in a thin
 * `portal_conversation_meta` table keyed by Portal user ID.
 *
 * Scope mapping: the Portal authenticates with usr_* IDs; the runtime uses
 * its own user IDs (mg, primary, ...). Both share `instance_id` as the join
 * key — conversation listing filters by instance_id, metadata by Portal
 * user_id.
 */

export interface ConversationMirrorRow {
  conversation_id: string;
  user_id: string;
  assistant_id: string;
  instance_id: string;
  channel: string;
  title: string;
  title_override: string | null;
  last_message_preview: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  sync_cursor: string | null;
  pinned_at: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  label_id: string | null;
  position: number;
}

export interface ConversationLabelRow {
  label_id: string;
  user_id: string;
  assistant_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationMessageMirrorRow {
  message_id: string;
  conversation_id: string;
  user_id: string;
  assistant_id: string;
  instance_id: string;
  channel: string;
  role: string;
  content: string;
  status: string;
  trace_id: string | null;
  request_id: string | null;
  created_at: string;
  metadata_json: string | null;
}

export interface ConversationScope {
  userId: string;
  assistantId: string;
  instanceId: string;
}

export interface ConversationReconciliationRow extends ConversationScope {
  conversationId: string;
  userMessageId: string | null;
  requestId: string | null;
  state: "pending";
  reason: string | null;
  attemptCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ConversationScopeMismatchError extends Error {
  constructor(message = "conversation scope mismatch") {
    super(message);
    this.name = "ConversationScopeMismatchError";
  }
}

interface ConversationMessageCursor {
  createdAt: string;
  messageId: string;
}

export class InvalidConversationMessageCursorError extends Error {
  constructor() {
    super("invalid conversation message cursor");
    this.name = "InvalidConversationMessageCursorError";
  }
}

function encodeMessageCursor(cursor: ConversationMessageCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), "utf8").toString("base64url");
}

function decodeMessageCursor(value: string): ConversationMessageCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown; createdAt?: unknown; messageId?: unknown;
    };
    if (parsed.v !== 1 || typeof parsed.createdAt !== "string" || typeof parsed.messageId !== "string") {
      throw new InvalidConversationMessageCursorError();
    }
    return { createdAt: parsed.createdAt, messageId: parsed.messageId };
  } catch (error) {
    if (error instanceof InvalidConversationMessageCursorError) throw error;
    throw new InvalidConversationMessageCursorError();
  }
}

export function mapConversationRow(row: ConversationMirrorRow): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    title: row.title_override || row.title,
    channel: row.channel as ConversationChannel,
    lastMessagePreview: row.last_message_preview ?? undefined,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinnedAt: row.pinned_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    labelId: row.label_id ?? undefined,
    position: row.position
  };
}

export function mapMessageRow(row: ConversationMessageMirrorRow): ConversationMessage {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; }
    catch { metadata = undefined; }
  }
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    instanceId: row.instance_id,
    channel: row.channel as ConversationChannel,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    status: row.status as "pending" | "sent" | "failed",
    traceId: row.trace_id ?? undefined,
    requestId: row.request_id ?? undefined,
    createdAt: row.created_at,
    metadata
  };
}

/**
 * Column list for the conversation JOIN query — runtime authoritative columns
 * plus Portal metadata. `user_id` is always the Portal user ID (from meta or
 * resolved from the session) for backwards compatibility with the UI layer.
 */
const CONVERSATION_SELECT = `
  cs.conversation_id,
  COALESCE(pcm.user_id, @portalUserId) AS user_id,
  cs.assistant_id,
  cs.instance_id,
  cs.channel,
  cs.title,
  pcm.title_override,
  (SELECT cm.content FROM conversation_messages cm
    WHERE cm.conversation_id = cs.conversation_id
    ORDER BY cm.created_at DESC LIMIT 1) AS last_message_preview,
  (SELECT COUNT(*) FROM conversation_messages cm
    WHERE cm.conversation_id = cs.conversation_id) AS message_count,
  cs.created_at,
  cs.updated_at,
  NULL AS sync_cursor,
  pcm.pinned_at,
  pcm.archived_at,
  pcm.deleted_at,
  pcm.label_id,
  COALESCE(pcm.position, 0) AS position
FROM conversation_sessions cs
LEFT JOIN portal_conversation_meta pcm
  ON cs.conversation_id = pcm.conversation_id
 AND (@portalUserId = '' OR pcm.user_id = @portalUserId)
`;

export class ConversationMirrorRepository {
  constructor(private readonly db: Database) {}

  // ─── Scope resolution ────────────────────────────────────────────────

  private resolveRuntimeUserId(portalUserId: string): string | null {
    const row = this.db.prepare(
      "SELECT pu.instance_id, ai.owner_user_id FROM portal_users pu LEFT JOIN ai_instances ai ON ai.id = pu.instance_id WHERE pu.id = ?"
    ).get(portalUserId) as { instance_id: string; owner_user_id: string | null } | undefined;
    return row?.owner_user_id ?? row?.instance_id ?? null;
  }

  // ─── Conversation CRUD ───────────────────────────────────────────────

  upsertConversation(input: {
    conversationId: string;
    userId: string;
    assistantId: string;
    instanceId: string;
    channel: ConversationChannel;
    title: string;
    lastMessagePreview?: string;
    createdAt?: string;
    updatedAt?: string;
  }): void {
    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? now;
    const runtimeUserId = this.resolveRuntimeUserId(input.userId) ?? input.userId;

    this.db.transaction(() => {
      // Runtime authoritative row
      this.db.prepare(
        `INSERT INTO conversation_sessions (
           conversation_id, user_id, project_id, instance_id, assistant_id,
           channel, title, created_at, updated_at
         ) VALUES (?, ?, 'invest-agent', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           title = excluded.title,
           updated_at = excluded.updated_at,
           channel = excluded.channel`
      ).run(
        input.conversationId, runtimeUserId, input.instanceId,
        input.assistantId, input.channel, input.title, createdAt, updatedAt
      );
      // Portal metadata row (sparse — only presentation state)
      this.db.prepare(
        `INSERT INTO portal_conversation_meta (
           conversation_id, user_id, assistant_id, instance_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET updated_at = excluded.updated_at`
      ).run(
        input.conversationId, input.userId, input.assistantId,
        input.instanceId, createdAt, updatedAt
      );
    })();
  }

  getConversation(conversationId: string, scope?: ConversationScope): ConversationMirrorRow | null {
    const params: Record<string, unknown> = {
      portalUserId: scope?.userId ?? "",
      conversationId
    };
    let where = "cs.conversation_id = @conversationId";
    if (scope) {
      where += " AND cs.instance_id = @instanceId AND cs.assistant_id = @assistantId";
      params.instanceId = scope.instanceId;
      params.assistantId = scope.assistantId;
    }
    const row = this.db.prepare(
      `SELECT ${CONVERSATION_SELECT} WHERE ${where}`
    ).get(params) as ConversationMirrorRow | undefined;
    return row ?? null;
  }

  listConversations(input: {
    userId: string;
    assistantId: string;
    instanceId: string;
    channel?: ConversationChannel;
    limit: number;
    cursor?: string;
    query?: string;
    archived?: boolean;
  }): { items: ConversationMirrorRow[]; nextCursor: string | null } {
    const where: string[] = [
      "cs.instance_id = @instanceId",
      "cs.assistant_id = @assistantId",
      "COALESCE(pcm.deleted_at, '') = ''"
    ];
    const params: Record<string, unknown> = {
      portalUserId: input.userId,
      instanceId: input.instanceId,
      assistantId: input.assistantId,
      limit: input.limit,
      offset: Number.parseInt(input.cursor ?? "0", 10) || 0
    };
    if (input.channel) { where.push("cs.channel = @channel"); params.channel = input.channel; }
    if (input.archived) { where.push("pcm.archived_at IS NOT NULL"); }
    else { where.push("COALESCE(pcm.archived_at, '') = ''"); }
    if (input.query?.trim()) {
      where.push("(COALESCE(pcm.title_override, cs.title) LIKE @query)");
      params.query = `%${input.query.trim()}%`;
    }
    const sql = `
      SELECT ${CONVERSATION_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY
        CASE WHEN pcm.label_id IS NULL THEN 0 ELSE 1 END ASC,
        pcm.label_id ASC,
        COALESCE(pcm.position, 0) ASC,
        CASE WHEN pcm.pinned_at IS NULL THEN 1 ELSE 0 END ASC,
        pcm.pinned_at DESC,
        cs.updated_at DESC
      LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all(params) as ConversationMirrorRow[];
    const nextCursor = rows.length === input.limit ? String((params.offset as number) + rows.length) : null;
    return { items: rows, nextCursor };
  }

  // ─── Metadata operations (thin Portal state) ─────────────────────────

  private upsertMeta(conversationId: string, userId: string, assistantId: string, instanceId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO portal_conversation_meta (conversation_id, user_id, assistant_id, instance_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET updated_at = excluded.updated_at`
    ).run(conversationId, userId, assistantId, instanceId, now, now);
  }

  renameConversation(input: { conversationId: string; userId: string; assistantId: string; title: string }): ConversationMirrorRow | null {
    const conv = this.getConversation(input.conversationId);
    if (!conv) return null;
    this.upsertMeta(input.conversationId, input.userId, input.assistantId, conv.instance_id);
    this.db.prepare(
      `UPDATE portal_conversation_meta SET title_override = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ?`
    ).run(input.title, new Date().toISOString(), input.conversationId, input.userId);
    return this.getConversation(input.conversationId);
  }

  setConversationPinned(input: { conversationId: string; userId: string; assistantId: string; pinned: boolean }): ConversationMirrorRow | null {
    const conv = this.getConversation(input.conversationId);
    if (!conv) return null;
    this.upsertMeta(input.conversationId, input.userId, input.assistantId, conv.instance_id);
    this.db.prepare(
      `UPDATE portal_conversation_meta SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?`
    ).run(input.pinned ? new Date().toISOString() : null, input.conversationId, input.userId);
    return this.getConversation(input.conversationId);
  }

  setConversationArchived(input: { conversationId: string; userId: string; assistantId: string; archived: boolean }): ConversationMirrorRow | null {
    const conv = this.getConversation(input.conversationId);
    if (!conv) return null;
    this.upsertMeta(input.conversationId, input.userId, input.assistantId, conv.instance_id);
    const archivedAt = input.archived ? new Date().toISOString() : null;
    this.db.prepare(
      `UPDATE portal_conversation_meta SET archived_at = ?, pinned_at = CASE WHEN ? IS NULL THEN pinned_at ELSE NULL END WHERE conversation_id = ? AND user_id = ?`
    ).run(archivedAt, archivedAt, input.conversationId, input.userId);
    return this.getConversation(input.conversationId);
  }

  softDeleteConversation(input: { conversationId: string; userId: string; assistantId: string }): void {
    const conv = this.getConversation(input.conversationId);
    if (!conv) return;
    this.upsertMeta(input.conversationId, input.userId, input.assistantId, conv.instance_id);
    this.db.prepare(
      `UPDATE portal_conversation_meta SET deleted_at = ?, archived_at = NULL, pinned_at = NULL WHERE conversation_id = ? AND user_id = ?`
    ).run(new Date().toISOString(), input.conversationId, input.userId);
  }

  touchConversationPreview(conversationId: string, _preview: string, updatedAt: string, scope?: ConversationScope): void {
    // Preview is computed on read from runtime messages; just bump the timestamp.
    this.db.prepare(
      `UPDATE conversation_sessions SET updated_at = ? WHERE conversation_id = ?${scope ? " AND instance_id = ? AND assistant_id = ?" : ""}`
    ).run(...(scope ? [updatedAt, conversationId, scope.instanceId, scope.assistantId] : [updatedAt, conversationId]));
  }

  // ─── Labels ──────────────────────────────────────────────────────────

  listLabels(input: { userId: string; assistantId: string }): ConversationLabelRow[] {
    return this.db.prepare(
      `SELECT * FROM conversation_labels WHERE user_id = ? AND assistant_id = ? ORDER BY position ASC, created_at ASC`
    ).all(input.userId, input.assistantId) as ConversationLabelRow[];
  }

  createLabel(input: { labelId: string; userId: string; assistantId: string; name: string }): ConversationLabelRow {
    const now = new Date().toISOString();
    const position = (this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) + 1 AS position FROM conversation_labels WHERE user_id = ? AND assistant_id = ?`
    ).get(input.userId, input.assistantId) as { position: number }).position;
    this.db.prepare(
      `INSERT INTO conversation_labels (label_id, user_id, assistant_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(input.labelId, input.userId, input.assistantId, input.name, position, now, now);
    return this.db.prepare(`SELECT * FROM conversation_labels WHERE label_id = ?`).get(input.labelId) as ConversationLabelRow;
  }

  updateLabel(input: { labelId: string; userId: string; assistantId: string; name?: string; position?: number }): ConversationLabelRow | null {
    const current = this.db.prepare(
      `SELECT * FROM conversation_labels WHERE label_id = ? AND user_id = ? AND assistant_id = ?`
    ).get(input.labelId, input.userId, input.assistantId) as ConversationLabelRow | undefined;
    if (!current) return null;
    if (input.position !== undefined) {
      const ordered = this.listLabels(input).filter((label) => label.label_id !== input.labelId);
      ordered.splice(Math.min(input.position, ordered.length), 0, current);
      const update = this.db.prepare(`UPDATE conversation_labels SET position = ?, updated_at = ? WHERE label_id = ?`);
      this.db.transaction(() => ordered.forEach((label, index) => update.run(index, new Date().toISOString(), label.label_id)))();
    }
    if (input.name !== undefined) {
      this.db.prepare(
        `UPDATE conversation_labels SET name = ?, updated_at = ? WHERE label_id = ? AND user_id = ? AND assistant_id = ?`
      ).run(input.name, new Date().toISOString(), input.labelId, input.userId, input.assistantId);
    }
    return this.db.prepare(`SELECT * FROM conversation_labels WHERE label_id = ?`).get(input.labelId) as ConversationLabelRow;
  }

  deleteLabel(input: { labelId: string; userId: string; assistantId: string }): boolean {
    return this.db.transaction(() => {
      this.db.prepare(
        `UPDATE portal_conversation_meta SET label_id = NULL WHERE label_id = ? AND user_id = ? AND assistant_id = ?`
      ).run(input.labelId, input.userId, input.assistantId);
      return this.db.prepare(
        `DELETE FROM conversation_labels WHERE label_id = ? AND user_id = ? AND assistant_id = ?`
      ).run(input.labelId, input.userId, input.assistantId).changes > 0;
    })();
  }

  setConversationLabel(input: { conversationId: string; userId: string; assistantId: string; labelId: string | null; position?: number }): ConversationMirrorRow | null {
    const conv = this.getConversation(input.conversationId);
    if (!conv) return null;
    this.upsertMeta(input.conversationId, input.userId, input.assistantId, conv.instance_id);
    this.db.prepare(
      `UPDATE portal_conversation_meta SET label_id = ? WHERE conversation_id = ? AND user_id = ?`
    ).run(input.labelId, input.conversationId, input.userId);
    return this.getConversation(input.conversationId);
  }

  // ─── Messages ────────────────────────────────────────────────────────

  upsertMessage(input: ConversationMessage): void {
    const conversation = this.getConversation(input.conversationId);
    if (!conversation) throw new ConversationScopeMismatchError("conversation must exist before inserting a message");
    const runtimeUserId = this.resolveRuntimeUserId(conversation.user_id) ?? conversation.user_id;
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    this.db.prepare(
      `INSERT INTO conversation_messages (
         message_id, conversation_id, user_id, project_id, instance_id, assistant_id,
         channel, role, content, status, trace_id, request_id, created_at, metadata_json
       ) VALUES (?, ?, ?, 'invest-agent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         content = excluded.content,
         status = excluded.status,
         trace_id = COALESCE(excluded.trace_id, conversation_messages.trace_id),
         request_id = COALESCE(excluded.request_id, conversation_messages.request_id),
         metadata_json = COALESCE(excluded.metadata_json, conversation_messages.metadata_json)`
    ).run(
      input.messageId, input.conversationId, runtimeUserId,
      conversation.instance_id, input.assistantId,
      input.channel, input.role, input.content, input.status,
      input.traceId ?? null, input.requestId ?? null, input.createdAt, metadataJson
    );
    this.db.prepare(
      `UPDATE conversation_sessions SET updated_at = ? WHERE conversation_id = ?`
    ).run(input.createdAt, input.conversationId);
  }

  removeMessage(input: ConversationScope & { messageId: string; conversationId: string; updatedAt: string }): void {
    this.db.prepare(
      `DELETE FROM conversation_messages WHERE message_id = ? AND conversation_id = ?`
    ).run(input.messageId, input.conversationId);
    this.db.prepare(
      `UPDATE conversation_sessions SET updated_at = ? WHERE conversation_id = ?`
    ).run(input.updatedAt, input.conversationId);
  }

  markMessageFailed(messageId: string, conversationId: string, updatedAt: string, scope?: ConversationScope): void {
    this.db.prepare(
      `UPDATE conversation_messages SET status = 'failed' WHERE message_id = ? AND conversation_id = ?`
    ).run(messageId, conversationId);
    this.db.prepare(
      `UPDATE conversation_sessions SET updated_at = ? WHERE conversation_id = ?`
    ).run(updatedAt, conversationId);
  }

  listMessages(input: {
    conversationId: string;
    limit: number;
    cursor?: string;
    userId?: string;
    assistantId?: string;
    instanceId?: string;
  }): { items: ConversationMessageMirrorRow[]; nextCursor: string | null } {
    const where: string[] = ["conversation_id = @conversationId"];
    const params: Record<string, unknown> = { conversationId: input.conversationId, limit: input.limit + 1 };
    if (input.cursor) {
      const cursor = decodeMessageCursor(input.cursor);
      where.push("(created_at > @cursorCreatedAt OR (created_at = @cursorCreatedAt AND message_id > @cursorMessageId))");
      params.cursorCreatedAt = cursor.createdAt;
      params.cursorMessageId = cursor.messageId;
    }
    const sql = `SELECT * FROM conversation_messages
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at ASC, message_id ASC
                 LIMIT @limit`;
    const rows = this.db.prepare(sql).all(params) as ConversationMessageMirrorRow[];
    const items = rows.slice(0, input.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > input.limit && last
      ? encodeMessageCursor({ createdAt: last.created_at, messageId: last.message_id })
      : null;
    return { items, nextCursor };
  }

  // ─── Processing state (computed from runtime messages) ───────────────

  isConversationProcessing(input: ConversationScope & { conversationId: string }): boolean {
    return this.getConversationProcessingStartedAt(input) !== null;
  }

  getConversationProcessingStartedAt(input: ConversationScope & { conversationId: string }): string | null {
    const row = this.db.prepare(
      `WITH candidates AS (
         SELECT created_at AS started_at
         FROM conversation_messages
         WHERE conversation_id = ? AND status = 'pending'
       )
       SELECT MIN(started_at) AS started_at FROM candidates
       WHERE NOT EXISTS (
         SELECT 1 FROM conversation_messages terminal
         WHERE terminal.conversation_id = ?
           AND terminal.role = 'assistant'
           AND terminal.status IN ('sent', 'failed')
           AND terminal.created_at >= candidates.started_at
       )`
    ).get(input.conversationId, input.conversationId) as { started_at: string | null } | undefined;
    return row?.started_at ?? null;
  }

  // ─── Reconciliation (kept for API compat; simplified) ────────────────

  markReconciliationPending(input: ConversationScope & {
    conversationId: string; userMessageId?: string; requestId?: string; reason: string;
  }): ConversationReconciliationRow {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO portal_conversation_reconciliation (
         conversation_id, user_id, assistant_id, instance_id,
         user_message_id, request_id, state, reason, attempt_count,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?)
       ON CONFLICT(user_id, assistant_id, instance_id, conversation_id) DO UPDATE SET
         user_message_id = COALESCE(excluded.user_message_id, portal_conversation_reconciliation.user_message_id),
         request_id = COALESCE(excluded.request_id, portal_conversation_reconciliation.request_id),
         state = 'pending', reason = excluded.reason, last_error = NULL, updated_at = excluded.updated_at`
    ).run(
      input.conversationId, input.userId, input.assistantId, input.instanceId,
      input.userMessageId ?? null, input.requestId ?? null, input.reason, now, now
    );
    return this.getReconciliation(input) as ConversationReconciliationRow;
  }

  getReconciliation(input: ConversationScope & { conversationId: string }): ConversationReconciliationRow | null {
    const row = this.db.prepare(
      `SELECT * FROM portal_conversation_reconciliation
       WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
    ).get(input.conversationId, input.userId, input.assistantId, input.instanceId) as {
      conversation_id: string; user_id: string; assistant_id: string; instance_id: string;
      user_message_id: string | null; request_id: string | null; state: string;
      reason: string | null; attempt_count: number; last_error: string | null;
      created_at: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversation_id, userId: row.user_id, assistantId: row.assistant_id,
      instanceId: row.instance_id, userMessageId: row.user_message_id, requestId: row.request_id,
      state: "pending", reason: row.reason, attemptCount: row.attempt_count,
      lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  listPendingReconciliations(input: { assistantId: string }): ConversationReconciliationRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM portal_conversation_reconciliation WHERE assistant_id = ? AND state = 'pending' ORDER BY updated_at ASC`
    ).all(input.assistantId) as Array<{
      conversation_id: string; user_id: string; assistant_id: string; instance_id: string;
      user_message_id: string | null; request_id: string | null; state: string;
      reason: string | null; attempt_count: number; last_error: string | null;
      created_at: string; updated_at: string;
    }>;
    return rows.map(row => ({
      conversationId: row.conversation_id, userId: row.user_id, assistantId: row.assistant_id,
      instanceId: row.instance_id, userMessageId: row.user_message_id, requestId: row.request_id,
      state: "pending" as const, reason: row.reason, attemptCount: row.attempt_count,
      lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  recordReconciliationError(input: ConversationScope & { conversationId: string; error: string }): void {
    this.db.prepare(
      `UPDATE portal_conversation_reconciliation
       SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
       WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ? AND state = 'pending'`
    ).run(input.error.slice(0, 500), new Date().toISOString(), input.conversationId, input.userId, input.assistantId, input.instanceId);
  }

  clearReconciliation(input: ConversationScope & { conversationId: string }): void {
    this.db.prepare(
      `DELETE FROM portal_conversation_reconciliation
       WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
    ).run(input.conversationId, input.userId, input.assistantId, input.instanceId);
  }
}
