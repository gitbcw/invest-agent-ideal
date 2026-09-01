/**
 * Single write path for mastra_review_memory_records.
 *
 * Every backend that persists into the review-memory ledger used to carry its
 * own verbatim copy of the 12-column INSERT. This module is the shared,
 * idempotent replacement: the (user, project, instance, record_type,
 * business_key) tuple is backed by a unique index, so the ON CONFLICT branch
 * makes retries and same-key rewrites safe without a SELECT-then-branch race.
 *
 * Callers that own a set of records for one review (reviews.save decisions and
 * source events, review viewpoints) additionally delete their key prefix
 * first so a resave with fewer records cannot leave stale rows behind.
 */
import { sqlite } from "../db/index.js";

export interface ReviewMemoryRecordInput {
  userId: string;
  projectId: string;
  instanceId: string;
  recordType: string;
  businessKey: string;
  payload: unknown;
  sourcePath: string;
  /** Stable id for the first insert; kept unchanged on conflict updates. */
  recordId: string;
}

export function upsertReviewMemoryRecord(record: ReviewMemoryRecordInput): string {
  const now = new Date().toISOString();
  const payloadJson = typeof record.payload === "string" ? record.payload : JSON.stringify(record.payload);
  sqlite.prepare(
    `INSERT INTO mastra_review_memory_records
       (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_line,source_checksum,migration_batch_id,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, project_id, instance_id, record_type, business_key)
     DO UPDATE SET
       payload_json = excluded.payload_json,
       source_path = excluded.source_path,
       source_checksum = excluded.source_checksum,
       migration_batch_id = excluded.migration_batch_id,
       created_at = excluded.created_at`
  ).run(
    record.recordId,
    record.userId,
    record.projectId,
    record.instanceId,
    record.recordType,
    record.businessKey,
    payloadJson,
    record.sourcePath,
    null,
    `service:${now}`,
    "service-owned",
    now,
  );
  return record.recordId;
}

/**
 * Drop every record under one business_key prefix (the caller's date/report
 * scope). Prefixes come from server-generated date/report keys, never raw user
 * input, matching the existing viewpoint-backend delete pattern.
 */
export function deleteReviewMemoryRecordsByPrefix(scope: {
  userId: string;
  projectId: string;
  instanceId: string;
}, recordType: string, businessKeyPrefix: string): void {
  sqlite.prepare(
    "DELETE FROM mastra_review_memory_records WHERE user_id=? AND project_id=? AND instance_id=? AND record_type=? AND business_key LIKE ?"
  ).run(scope.userId, scope.projectId, scope.instanceId, recordType, `${businessKeyPrefix}%`);
}
