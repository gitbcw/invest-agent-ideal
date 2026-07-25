import { sqlite } from "../db/index.js";

/**
 * Per-conversation "current turn" registry.
 *
 * The MCP service-tools server runs in a separate process from the
 * conversation-log service, so an in-memory current-turn variable would not
 * survive across processes. This module persists the active turnId for a
 * given (userId, instanceId, conversationId) in SQLite so that artifact
 * publish calls during an ACP turn can be bound deterministically to the
 * turn that produced them.
 *
 * Lifecycle:
 *   1. `markTurnStart` is called just before the ACP backend is invoked.
 *   2. The MCP `artifacts.publish` and `reviews.save` tools call
 *      `getCurrentTurnId` to record `turn_id` on the freshly-inserted
 *      artifact row.
 *   3. The conversation-log service attaches the assistant message by
 *      matching `turn_id`, never by `message_id IS NULL`.
 *   4. `markTurnEnd` clears the row when the turn finishes (success or
 *      failure), so a later artifact publish outside of a turn (for
 *      example a legacy path publish from the Portal) stays unbound
 *      rather than stealing a stale turnId.
 */

export function markTurnStart(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
  turnId: string;
}): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO conversation_turn_active (user_id, instance_id, conversation_id, turn_id, started_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, instance_id, conversation_id)
       DO UPDATE SET turn_id = excluded.turn_id, started_at = excluded.started_at`
    )
    .run(input.userId, input.instanceId, input.conversationId, input.turnId, now);
}

export function markTurnEnd(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
  turnId: string;
}): void {
  sqlite
    .prepare(
      `DELETE FROM conversation_turn_active
       WHERE user_id = ? AND instance_id = ? AND conversation_id = ? AND turn_id = ?`
    )
    .run(input.userId, input.instanceId, input.conversationId, input.turnId);
}

export function getCurrentTurnId(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
}): string | null {
  const row = sqlite
    .prepare(
      `SELECT turn_id AS turnId FROM conversation_turn_active
       WHERE user_id = ? AND instance_id = ? AND conversation_id = ?`
    )
    .get(input.userId, input.instanceId, input.conversationId) as { turnId?: string } | undefined;
  return row?.turnId ?? null;
}
