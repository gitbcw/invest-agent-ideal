import { randomUUID } from "node:crypto";

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";

export type FileLifecycleEntityType = "artifact" | "attachment" | "asset" | "batch";

export interface FileLifecycleAuditInput {
  entityType: FileLifecycleEntityType;
  entityId: string;
  userId: string;
  instanceId?: string | null;
  event: string;
  status: "success" | "failure" | "pending" | "skipped";
  reason?: string;
  summary?: Record<string, string | number | boolean | null | undefined>;
  createdAt?: string;
}

/** Records lifecycle decisions without file content or absolute paths. */
export function recordFileLifecycleEvent(input: FileLifecycleAuditInput): void {
  try {
    sqlite.prepare(
      `INSERT INTO file_lifecycle_events (
         id, entity_type, entity_id, user_id, instance_id,
         event, status, reason, summary_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `fle_${randomUUID()}`,
      input.entityType,
      input.entityId,
      input.userId,
      input.instanceId ?? null,
      input.event,
      input.status,
      clamp(input.reason),
      JSON.stringify(sanitizeSummary(input.summary)),
      input.createdAt ?? new Date().toISOString(),
    );
  } catch (error) {
    logger.warn(`file lifecycle audit failed event=${input.event} entity=${input.entityId}: ${(error as Error).message}`);
  }
}

function sanitizeSummary(summary: FileLifecycleAuditInput["summary"]): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(summary ?? {})) {
    if (value === undefined) continue;
    if (/absolute|fullpath/i.test(key)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 300) : value;
  }
  return safe;
}

function clamp(value: string | undefined): string | null {
  const trimmed = value?.trim().slice(0, 300);
  return trimmed || null;
}
