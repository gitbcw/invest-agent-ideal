import type { Database } from "better-sqlite3";
import type {
  ConversationChannel,
  ConversationMessage,
  ConversationSummary
} from "@/lib/protocol";

interface ConversationMirrorRow {
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

function scopeMatches(
  row: Pick<ConversationMirrorRow, "user_id" | "assistant_id" | "instance_id">,
  scope: ConversationScope
): boolean {
  return row.user_id === scope.userId && row.assistant_id === scope.assistantId && row.instance_id === scope.instanceId;
}

function messageScopeMatches(
  row: Pick<ConversationMessageMirrorRow, "conversation_id" | "assistant_id" | "instance_id">,
  conversationId: string,
  scope: ConversationScope
): boolean {
  return row.conversation_id === conversationId && row.assistant_id === scope.assistantId && row.instance_id === scope.instanceId;
}

function mapReconciliationRow(row: {
  conversation_id: string;
  user_id: string;
  assistant_id: string;
  instance_id: string;
  user_message_id: string | null;
  request_id: string | null;
  state: string;
  reason: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): ConversationReconciliationRow {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    assistantId: row.assistant_id,
    instanceId: row.instance_id,
    userMessageId: row.user_message_id,
    requestId: row.request_id,
    state: "pending",
    reason: row.reason,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
      v?: unknown;
      createdAt?: unknown;
      messageId?: unknown;
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
    archivedAt: row.archived_at ?? undefined
    ,labelId: row.label_id ?? undefined
    ,position: row.position
  };
}

export function mapMessageRow(row: ConversationMessageMirrorRow): ConversationMessage {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
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

export class ConversationMirrorRepository {
  constructor(private readonly db: Database) {}

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
    const existing = this.getConversation(input.conversationId);
    if (existing && !scopeMatches(existing, input)) {
      throw new ConversationScopeMismatchError();
    }
    this.db
      .prepare(
        `INSERT INTO conversation_mirror (
           conversation_id, user_id, assistant_id, instance_id, channel,
         title, last_message_preview, message_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           title = excluded.title,
           last_message_preview = COALESCE(excluded.last_message_preview, conversation_mirror.last_message_preview),
           updated_at = excluded.updated_at,
           channel = excluded.channel`
      )
      .run(
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId,
        input.channel,
        input.title,
        input.lastMessagePreview ?? null,
        createdAt,
        updatedAt
      );
  }

  listLabels(input: { userId: string; assistantId: string }): ConversationLabelRow[] {
    return this.db.prepare(`SELECT * FROM conversation_labels WHERE user_id = ? AND assistant_id = ? ORDER BY position ASC, created_at ASC`).all(input.userId, input.assistantId) as ConversationLabelRow[];
  }

  createLabel(input: { labelId: string; userId: string; assistantId: string; name: string }): ConversationLabelRow {
    const now = new Date().toISOString();
    const position = (this.db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS position FROM conversation_labels WHERE user_id = ? AND assistant_id = ?`).get(input.userId, input.assistantId) as { position: number }).position;
    this.db.prepare(`INSERT INTO conversation_labels (label_id, user_id, assistant_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.labelId, input.userId, input.assistantId, input.name, position, now, now);
    return this.db.prepare(`SELECT * FROM conversation_labels WHERE label_id = ?`).get(input.labelId) as ConversationLabelRow;
  }

  updateLabel(input: { labelId: string; userId: string; assistantId: string; name?: string; position?: number }): ConversationLabelRow | null {
    const current = this.db.prepare(`SELECT * FROM conversation_labels WHERE label_id = ? AND user_id = ? AND assistant_id = ?`).get(input.labelId, input.userId, input.assistantId) as ConversationLabelRow | undefined;
    if (!current) return null;
    if (input.position !== undefined && input.position !== current.position) {
      const ordered = this.listLabels(input).filter((label) => label.label_id !== input.labelId);
      ordered.splice(Math.min(input.position, ordered.length), 0, current);
      const updatePosition = this.db.prepare(`UPDATE conversation_labels SET position = ?, updated_at = ? WHERE label_id = ?`);
      this.db.transaction(() => ordered.forEach((label, index) => updatePosition.run(index, new Date().toISOString(), label.label_id)))();
    }
    if (input.name !== undefined) {
      this.db.prepare(`UPDATE conversation_labels SET name = ?, updated_at = ? WHERE label_id = ? AND user_id = ? AND assistant_id = ?`).run(input.name, new Date().toISOString(), input.labelId, input.userId, input.assistantId);
    }
    return this.db.prepare(`SELECT * FROM conversation_labels WHERE label_id = ?`).get(input.labelId) as ConversationLabelRow;
  }

  deleteLabel(input: { labelId: string; userId: string; assistantId: string }): boolean {
    const result = this.db.transaction(() => {
      this.db.prepare(`UPDATE conversation_mirror SET label_id = NULL WHERE label_id = ? AND user_id = ? AND assistant_id = ?`).run(input.labelId, input.userId, input.assistantId);
      return this.db.prepare(`DELETE FROM conversation_labels WHERE label_id = ? AND user_id = ? AND assistant_id = ?`).run(input.labelId, input.userId, input.assistantId).changes > 0;
    })();
    return result;
  }

  setConversationLabel(input: { conversationId: string; userId: string; assistantId: string; labelId: string | null; position?: number }): ConversationMirrorRow | null {
    const current = this.getConversation(input.conversationId);
    if (!current) return null;
    const targetLabelId = input.labelId;
    const rows = this.db.prepare(`SELECT conversation_id, position FROM conversation_mirror WHERE user_id = ? AND assistant_id = ? AND deleted_at IS NULL AND label_id IS ? ORDER BY position ASC, updated_at DESC`).all(input.userId, input.assistantId, targetLabelId) as Array<{ conversation_id: string; position: number }>;
    const ordered = rows.filter((row) => row.conversation_id !== input.conversationId);
    const targetPosition = Math.min(input.position ?? ordered.length, ordered.length);
    ordered.splice(targetPosition, 0, { conversation_id: input.conversationId, position: targetPosition });
    const update = this.db.prepare(`UPDATE conversation_mirror SET label_id = ?, position = ?, updated_at = ? WHERE conversation_id = ? AND user_id = ? AND assistant_id = ?`);
    this.db.transaction(() => ordered.forEach((row, index) => update.run(targetLabelId, index, new Date().toISOString(), row.conversation_id, input.userId, input.assistantId)))();
    return this.getConversation(input.conversationId);
  }

  touchConversationPreview(
    conversationId: string,
    preview: string,
    updatedAt: string,
    scope?: ConversationScope
  ): void {
    const whereScope = scope ? " AND user_id = ? AND assistant_id = ? AND instance_id = ?" : "";
    const params = scope
      ? [preview, updatedAt, conversationId, scope.userId, scope.assistantId, scope.instanceId]
      : [preview, updatedAt, conversationId];
    this.db
      .prepare(
        `UPDATE conversation_mirror SET last_message_preview = ?, updated_at = ? WHERE conversation_id = ?${whereScope}`
      )
      .run(...params);
  }

  upsertMessage(input: ConversationMessage): void {
    const conversation = this.getConversation(input.conversationId);
    if (!conversation) {
      throw new ConversationScopeMismatchError("conversation must exist before inserting a message");
    }
    const scope: ConversationScope = {
      userId: conversation.user_id,
      assistantId: conversation.assistant_id,
      instanceId: conversation.instance_id
    };
    if (input.assistantId !== scope.assistantId || input.instanceId !== scope.instanceId) {
      throw new ConversationScopeMismatchError();
    }
    const existing = this.db
      .prepare("SELECT * FROM conversation_message_mirror WHERE message_id = ?")
      .get(input.messageId) as ConversationMessageMirrorRow | undefined;
    if (existing && !messageScopeMatches(existing, input.conversationId, scope)) {
      throw new ConversationScopeMismatchError();
    }
    const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
    this.db
      .prepare(
        `INSERT INTO conversation_message_mirror (
           message_id, conversation_id, user_id, assistant_id, instance_id, channel,
           role, content, status, trace_id, request_id, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           conversation_id = excluded.conversation_id,
           user_id = excluded.user_id,
           assistant_id = excluded.assistant_id,
           instance_id = excluded.instance_id,
           channel = excluded.channel,
           role = excluded.role,
           content = excluded.content,
           status = excluded.status,
           trace_id = COALESCE(excluded.trace_id, conversation_message_mirror.trace_id),
           request_id = COALESCE(excluded.request_id, conversation_message_mirror.request_id),
           metadata_json = COALESCE(excluded.metadata_json, conversation_message_mirror.metadata_json)`
      )
      .run(
        input.messageId,
        input.conversationId,
        // Portal and Runtime deployments may use different opaque user IDs;
        // the authenticated mirror conversation remains the scope authority.
        scope.userId,
        input.assistantId,
        input.instanceId,
        input.channel,
        input.role,
        input.content,
        input.status,
        input.traceId ?? null,
        input.requestId ?? null,
        input.createdAt,
        metadataJson
      );
    this.db
      .prepare(
        `UPDATE conversation_mirror SET
           message_count = (
             SELECT COUNT(*) FROM conversation_message_mirror
             WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?
           ),
           updated_at = ?
         WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
      )
      .run(
        input.conversationId,
        scope.userId,
        scope.assistantId,
        scope.instanceId,
        input.createdAt,
        input.conversationId,
        scope.userId,
        scope.assistantId,
        scope.instanceId
      );
  }

  removeMessage(input: ConversationScope & { messageId: string; conversationId: string; updatedAt: string }): void {
    const result = this.db
      .prepare(
        `DELETE FROM conversation_message_mirror
         WHERE message_id = ? AND conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
      )
      .run(input.messageId, input.conversationId, input.userId, input.assistantId, input.instanceId);
    if (result.changes === 0) return;
    this.db
      .prepare(
        `UPDATE conversation_mirror SET
           message_count = (
             SELECT COUNT(*) FROM conversation_message_mirror
             WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?
           ),
           updated_at = ?
         WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
      )
      .run(
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId,
        input.updatedAt,
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId,
      );
  }

  markMessageFailed(messageId: string, conversationId: string, updatedAt: string, scope?: ConversationScope): void {
    const whereScope = scope
      ? " AND conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?"
      : "";
    const params = scope
      ? [messageId, conversationId, scope.userId, scope.assistantId, scope.instanceId]
      : [messageId];
    this.db
      .prepare(
        `UPDATE conversation_message_mirror SET status = 'failed' WHERE message_id = ?${whereScope}`
      )
      .run(...params);
    const conversationParams = scope
      ? [updatedAt, conversationId, scope.userId, scope.assistantId, scope.instanceId]
      : [updatedAt, conversationId];
    this.db
      .prepare(
        `UPDATE conversation_mirror SET updated_at = ? WHERE conversation_id = ?${scope ? " AND user_id = ? AND assistant_id = ? AND instance_id = ?" : ""}`
      )
      .run(...conversationParams);
  }

  getConversation(conversationId: string, scope?: ConversationScope): ConversationMirrorRow | null {
    const whereScope = scope ? " AND user_id = ? AND assistant_id = ? AND instance_id = ?" : "";
    const params = scope
      ? [conversationId, scope.userId, scope.assistantId, scope.instanceId]
      : [conversationId];
    const row = this.db
      .prepare(`SELECT * FROM conversation_mirror WHERE conversation_id = ?${whereScope}`)
      .get(...params) as ConversationMirrorRow | undefined;
    return row ?? null;
  }

  renameConversation(input: {
    conversationId: string;
    userId: string;
    assistantId: string;
    title: string;
  }): ConversationMirrorRow | null {
    this.db
      .prepare(
        `UPDATE conversation_mirror
         SET title_override = @title, updated_at = @updatedAt
         WHERE conversation_id = @conversationId
           AND user_id = @userId
           AND assistant_id = @assistantId
           AND deleted_at IS NULL`
      )
      .run({
        conversationId: input.conversationId,
        userId: input.userId,
        assistantId: input.assistantId,
        title: input.title,
        updatedAt: new Date().toISOString()
      });
    return this.getConversation(input.conversationId);
  }

  setConversationPinned(input: {
    conversationId: string;
    userId: string;
    assistantId: string;
    pinned: boolean;
  }): ConversationMirrorRow | null {
    this.db
      .prepare(
        `UPDATE conversation_mirror
         SET pinned_at = @pinnedAt
         WHERE conversation_id = @conversationId
           AND user_id = @userId
           AND assistant_id = @assistantId
           AND deleted_at IS NULL`
      )
      .run({
        conversationId: input.conversationId,
        userId: input.userId,
        assistantId: input.assistantId,
        pinnedAt: input.pinned ? new Date().toISOString() : null
      });
    return this.getConversation(input.conversationId);
  }

  setConversationArchived(input: {
    conversationId: string;
    userId: string;
    assistantId: string;
    archived: boolean;
  }): ConversationMirrorRow | null {
    this.db
      .prepare(
        `UPDATE conversation_mirror
         SET archived_at = @archivedAt, pinned_at = CASE WHEN @archivedAt IS NULL THEN pinned_at ELSE NULL END
         WHERE conversation_id = @conversationId
           AND user_id = @userId
           AND assistant_id = @assistantId
           AND deleted_at IS NULL`
      )
      .run({
        conversationId: input.conversationId,
        userId: input.userId,
        assistantId: input.assistantId,
        archivedAt: input.archived ? new Date().toISOString() : null
      });
    return this.getConversation(input.conversationId);
  }

  softDeleteConversation(input: {
    conversationId: string;
    userId: string;
    assistantId: string;
  }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE conversation_mirror
           SET deleted_at = @deletedAt, archived_at = NULL, pinned_at = NULL
           WHERE conversation_id = @conversationId
             AND user_id = @userId
             AND assistant_id = @assistantId`
        )
        .run({
          conversationId: input.conversationId,
          userId: input.userId,
          assistantId: input.assistantId,
          deletedAt: now
        });
      this.db
        .prepare(
          `UPDATE conversation_message_mirror
           SET status = status
           WHERE conversation_id = @conversationId
             AND user_id = @userId
             AND assistant_id = @assistantId`
        )
        .run(input);
    })();
  }

  markReconciliationPending(input: ConversationScope & {
    conversationId: string;
    userMessageId?: string;
    requestId?: string;
    reason: string;
  }): ConversationReconciliationRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversation_reconciliation (
           conversation_id, user_id, assistant_id, instance_id,
           user_message_id, request_id, state, reason, attempt_count,
           last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?)
         ON CONFLICT(user_id, assistant_id, instance_id, conversation_id) DO UPDATE SET
           user_message_id = COALESCE(excluded.user_message_id, conversation_reconciliation.user_message_id),
           request_id = COALESCE(excluded.request_id, conversation_reconciliation.request_id),
           state = 'pending',
           reason = excluded.reason,
           last_error = NULL,
           updated_at = excluded.updated_at`
      )
      .run(
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId,
        input.userMessageId ?? null,
        input.requestId ?? null,
        input.reason,
        now,
        now
      );
    return this.getReconciliation(input) as ConversationReconciliationRow;
  }

  getReconciliation(input: ConversationScope & { conversationId: string }): ConversationReconciliationRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM conversation_reconciliation
         WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
      )
      .get(input.conversationId, input.userId, input.assistantId, input.instanceId) as {
        conversation_id: string;
        user_id: string;
        assistant_id: string;
        instance_id: string;
        user_message_id: string | null;
        request_id: string | null;
        state: string;
        reason: string | null;
        attempt_count: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      } | undefined;
    return row ? mapReconciliationRow(row) : null;
  }

  isConversationProcessing(input: ConversationScope & { conversationId: string }): boolean {
    return this.getConversationProcessingStartedAt(input) !== null;
  }

  getConversationProcessingStartedAt(input: ConversationScope & { conversationId: string }): string | null {
    const row = this.db
      .prepare(
        `WITH candidates AS (
           SELECT conversation_id, user_id, assistant_id, instance_id, created_at AS started_at
           FROM conversation_message_mirror
           WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?
             AND status = 'pending'
           UNION ALL
           SELECT reconciliation.conversation_id,
                  reconciliation.user_id,
                  reconciliation.assistant_id,
                  reconciliation.instance_id,
                  COALESCE(message.created_at, reconciliation.created_at) AS started_at
           FROM conversation_reconciliation reconciliation
           LEFT JOIN conversation_message_mirror message
             ON message.message_id = reconciliation.user_message_id
            AND message.conversation_id = reconciliation.conversation_id
            AND message.user_id = reconciliation.user_id
            AND message.assistant_id = reconciliation.assistant_id
            AND message.instance_id = reconciliation.instance_id
           WHERE reconciliation.conversation_id = ?
             AND reconciliation.user_id = ?
             AND reconciliation.assistant_id = ?
             AND reconciliation.instance_id = ?
             AND reconciliation.state = 'pending'
         )
         SELECT MIN(candidate.started_at) AS started_at
         FROM candidates candidate
         WHERE NOT EXISTS (
           SELECT 1
           FROM conversation_message_mirror terminal
           WHERE terminal.conversation_id = candidate.conversation_id
             AND terminal.assistant_id = candidate.assistant_id
             AND terminal.instance_id = candidate.instance_id
             AND terminal.role = 'assistant'
             AND terminal.status IN ('sent', 'failed')
             AND terminal.created_at >= candidate.started_at
         )`
      )
      .get(
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId,
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId
      ) as { started_at: string | null } | undefined;
    return row?.started_at ?? null;
  }

  listPendingReconciliations(input: { assistantId: string }): ConversationReconciliationRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversation_reconciliation
         WHERE assistant_id = ? AND state = 'pending'
         ORDER BY updated_at ASC`
      )
      .all(input.assistantId) as Array<{
        conversation_id: string;
        user_id: string;
        assistant_id: string;
        instance_id: string;
        user_message_id: string | null;
        request_id: string | null;
        state: string;
        reason: string | null;
        attempt_count: number;
        last_error: string | null;
        created_at: string;
        updated_at: string;
      }>;
    return rows.map(mapReconciliationRow);
  }

  recordReconciliationError(
    input: ConversationScope & { conversationId: string; error: string }
  ): void {
    this.db
      .prepare(
        `UPDATE conversation_reconciliation
         SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
         WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ? AND state = 'pending'`
      )
      .run(
        input.error.slice(0, 500),
        new Date().toISOString(),
        input.conversationId,
        input.userId,
        input.assistantId,
        input.instanceId
      );
  }

  clearReconciliation(input: ConversationScope & { conversationId: string }): void {
    this.db
      .prepare(
        `DELETE FROM conversation_reconciliation
         WHERE conversation_id = ? AND user_id = ? AND assistant_id = ? AND instance_id = ?`
      )
      .run(input.conversationId, input.userId, input.assistantId, input.instanceId);
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
      "user_id = @userId",
      "assistant_id = @assistantId",
      "instance_id = @instanceId",
      "deleted_at IS NULL"
    ];
    const params: Record<string, unknown> = {
      userId: input.userId,
      assistantId: input.assistantId,
      instanceId: input.instanceId,
      limit: input.limit,
      offset: Number.parseInt(input.cursor ?? "0", 10) || 0
    };
    if (input.channel) {
      where.push("channel = @channel");
      params.channel = input.channel;
    }
    if (input.archived) {
      where.push("archived_at IS NOT NULL");
    } else {
      where.push("archived_at IS NULL");
    }
    if (input.query?.trim()) {
      where.push("(COALESCE(title_override, title) LIKE @query OR last_message_preview LIKE @query)");
      params.query = `%${input.query.trim()}%`;
    }
    const sql = `SELECT * FROM conversation_mirror
                 WHERE ${where.join(" AND ")}
                 ORDER BY
                   CASE WHEN label_id IS NULL THEN 0 ELSE 1 END ASC,
                   label_id ASC,
                   position ASC,
                   CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END ASC,
                   pinned_at DESC,
                   updated_at DESC
                 LIMIT @limit OFFSET @offset`;
    const rows = this.db.prepare(sql).all(params) as ConversationMirrorRow[];
    const nextCursor = rows.length === input.limit ? String((params.offset as number) + rows.length) : null;
    return { items: rows, nextCursor };
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
    const params: Record<string, unknown> = {
      conversationId: input.conversationId,
      limit: input.limit + 1
    };
    if (input.userId !== undefined && input.assistantId !== undefined && input.instanceId !== undefined) {
      where.push("user_id = @userId", "assistant_id = @assistantId", "instance_id = @instanceId");
      params.userId = input.userId;
      params.assistantId = input.assistantId;
      params.instanceId = input.instanceId;
    }
    if (input.cursor) {
      const cursor = decodeMessageCursor(input.cursor);
      where.push("(created_at > @cursorCreatedAt OR (created_at = @cursorCreatedAt AND message_id > @cursorMessageId))");
      params.cursorCreatedAt = cursor.createdAt;
      params.cursorMessageId = cursor.messageId;
    }
    const sql = `SELECT * FROM conversation_message_mirror
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
}
