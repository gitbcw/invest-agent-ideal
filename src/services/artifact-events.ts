import { randomBytes } from "node:crypto";

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";

export type ArtifactEventName = "open" | "success" | "failure" | "download";

export interface ArtifactEventInput {
  artifactId: string;
  userId: string;
  instanceId?: string;
  event: ArtifactEventName;
  status?: "success" | "failure" | "denied";
  reason?: string;
}

/**
 * Records a lightweight artifact telemetry event. Used by the connector to
 * track preview open / success / failure / download interactions without
 * persisting content or absolute paths.
 *
 * The table is created additively in `src/db/index.ts`; if for any reason the
 * insert fails, we log and continue rather than breaking the read path.
 */
export function recordArtifactEvent(input: ArtifactEventInput): void {
  try {
    const eventId = `ae_${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    const reason = clampReason(input.reason);
    sqlite
      .prepare(
        `INSERT INTO conversation_artifact_events (
           id, artifact_id, user_id, instance_id, event, status, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        input.artifactId,
        input.userId,
        input.instanceId ?? null,
        input.event,
        input.status ?? null,
        reason,
        now,
      );
  } catch (error) {
    logger.warn(`recordArtifactEvent failed event=${input.event} artifact=${input.artifactId}: ${(error as Error).message}`);
  }
}

function clampReason(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().slice(0, 200);
  return trimmed || null;
}
