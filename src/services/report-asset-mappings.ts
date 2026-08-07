import { randomUUID } from "node:crypto";
import { sqlite } from "../db/index.js";
import type { AssetScope } from "./user-assets.js";
import { UserAssetError } from "./user-asset-error.js";
import {
  commitStorageReservation,
  releaseStorageReservation,
  requireStorageScope,
  reserveStorage,
  scopeStorageLockKey,
} from "./user-storage-quota.js";
import { withResourceMutationLock } from "./resource-mutation-lock.js";

export type ReportAssetMapping = { mappingId: string; reportId: string; title: string; fileName: string; mimeType: string; sizeBytes: number; backingAssetId: string | null; backingVersionId: string | null; createdAt: string };

/**
 * Internal record used only server-side to resolve a mapping to its backing
 * bytes. `readPath` is a workspace-relative path and must never be serialized
 * to the Portal client (the client opens entries by `mappingId` only).
 */
export type ReportAssetMappingRecord = ReportAssetMapping & { readPath: string | null };

type ReportMappingInput = AssetScope & Omit<ReportAssetMapping, "mappingId" | "createdAt"> & { readPath?: string | null };

export function ensureReportAssetMappingTable(): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS report_asset_mappings (
    mapping_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, user_id TEXT NOT NULL,
    project_id TEXT NOT NULL, instance_id TEXT NOT NULL, title TEXT NOT NULL,
    file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    backing_asset_id TEXT, backing_version_id TEXT, read_path TEXT, created_at TEXT NOT NULL,
    UNIQUE(user_id, project_id, instance_id, report_id)
  );`);
}

function requireReportMappingInput(input: ReportMappingInput): void {
  requireStorageScope(input);
  if (typeof input.reportId !== "string" || !input.reportId.trim()) {
    throw new UserAssetError("ASSET_INVALID_SCOPE", "reportId is required");
  }
  if (typeof input.title !== "string" || !input.title.trim()) {
    throw new UserAssetError("ASSET_INVALID_NAME", "title is required");
  }
  if (typeof input.fileName !== "string" || !input.fileName.trim()) {
    throw new UserAssetError("ASSET_INVALID_NAME", "fileName is required");
  }
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes < 0) {
    throw new UserAssetError("ASSET_INVALID_CONTENT", "sizeBytes must be a non-negative finite number");
  }
}

/**
 * Assert a declared backing asset (and optional version) belongs to the same
 * three-field scope. A mapping may only reference bytes the caller already
 * owns; a cross-scope backing id is rejected as a scope mismatch so it is
 * indistinguishable from a missing asset.
 */
function assertBackingInScope(input: ReportMappingInput): void {
  if (!input.backingAssetId) return;
  const asset = sqlite.prepare(
    `SELECT 1 FROM user_assets WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`,
  ).get(input.backingAssetId, input.userId, input.projectId, input.instanceId);
  if (!asset) throw new UserAssetError("ASSET_SCOPE_MISMATCH", "backing asset does not belong to the requested scope");
  if (input.backingVersionId) {
    const version = sqlite.prepare(
      `SELECT 1 FROM user_asset_versions WHERE version_id = ? AND asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`,
    ).get(input.backingVersionId, input.backingAssetId, input.userId, input.projectId, input.instanceId);
    if (!version) throw new UserAssetError("ASSET_SCOPE_MISMATCH", "backing version does not belong to the requested scope");
  }
}

/**
 * Register (or refresh) a scope-bound report mapping. The registration is
 * serialized under the same scope storage lock as asset writes, scope/size
 * validated, and quota enforced. Only unbacked bytes are charged: a backed
 * mapping is a no-copy reference whose bytes are already counted by its
 * version row. Refreshing an existing mapping charges only the signed delta of
 * unbacked bytes, and re-registering the same backing/version never charges.
 * The same backing/version is never double-charged because a backed mapping's
 * chargeable bytes are always zero. On any failure the mapping and any
 * reservation are rolled back atomically, leaving neither behind.
 */
export async function registerReportAssetMapping(input: ReportMappingInput): Promise<ReportAssetMapping> {
  requireReportMappingInput(input);
  const scope = { userId: input.userId, projectId: input.projectId, instanceId: input.instanceId };
  return withResourceMutationLock(scope, scopeStorageLockKey(scope), async () => {
    return registerReportAssetMappingUnderScopeLock(input);
  });
}

/** Internal transaction helper for callers already holding scopeStorageLockKey. */
export function registerReportAssetMappingUnderScopeLock(input: ReportMappingInput): ReportAssetMapping {
  requireReportMappingInput(input);
  const scope = { userId: input.userId, projectId: input.projectId, instanceId: input.instanceId };
  const chargeable = input.backingAssetId ? 0 : input.sizeBytes;
  const createdAt = new Date().toISOString();
  ensureReportAssetMappingTable();
  assertBackingInScope(input);
  const existing = sqlite.prepare(
    `SELECT size_bytes AS sizeBytes, backing_asset_id AS backingAssetId
     FROM report_asset_mappings
     WHERE user_id = ? AND project_id = ? AND instance_id = ? AND report_id = ?`,
  ).get(scope.userId, scope.projectId, scope.instanceId, input.reportId) as { sizeBytes: number; backingAssetId: string | null } | undefined;
  const oldChargeable = existing && existing.backingAssetId === null ? Number(existing.sizeBytes || 0) : 0;
  const delta = chargeable - oldChargeable;
  const token = delta > 0 ? reserveStorage(scope, delta) : null;
  try {
    sqlite.transaction(() => {
      sqlite.prepare(
        `INSERT INTO report_asset_mappings
         (mapping_id,report_id,user_id,project_id,instance_id,title,file_name,mime_type,size_bytes,backing_asset_id,backing_version_id,read_path,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id,project_id,instance_id,report_id) DO UPDATE SET
           title=excluded.title,file_name=excluded.file_name,mime_type=excluded.mime_type,
           size_bytes=excluded.size_bytes,backing_asset_id=excluded.backing_asset_id,
           backing_version_id=excluded.backing_version_id,
           read_path=COALESCE(excluded.read_path,report_asset_mappings.read_path)`,
      ).run(
        "report_map_" + randomUUID().replaceAll("-", ""),
        input.reportId, scope.userId, scope.projectId, scope.instanceId, input.title, input.fileName,
        input.mimeType, input.sizeBytes, input.backingAssetId, input.backingVersionId, input.readPath ?? null, createdAt,
      );
      if (token) commitStorageReservation(scope, token);
    })();
  } catch (error) {
    if (token) releaseStorageReservation(scope, token);
    throw error;
  }
  const row = sqlite.prepare(
    `SELECT mapping_id AS mappingId, created_at AS createdAt FROM report_asset_mappings
     WHERE user_id = ? AND project_id = ? AND instance_id = ? AND report_id = ?`,
  ).get(scope.userId, scope.projectId, scope.instanceId, input.reportId) as { mappingId: string; createdAt: string };
  return {
    mappingId: row.mappingId, reportId: input.reportId, title: input.title, fileName: input.fileName,
    mimeType: input.mimeType, sizeBytes: input.sizeBytes, backingAssetId: input.backingAssetId,
    backingVersionId: input.backingVersionId, createdAt: row.createdAt,
  };
}

export function listReportAssetMappings(scope: AssetScope): ReportAssetMapping[] {
  requireStorageScope(scope);
  ensureReportAssetMappingTable();
  return sqlite.prepare(`SELECT mapping_id AS mappingId,report_id AS reportId,title,file_name AS fileName,mime_type AS mimeType,size_bytes AS sizeBytes,backing_asset_id AS backingAssetId,backing_version_id AS backingVersionId,created_at AS createdAt FROM report_asset_mappings WHERE user_id=? AND project_id=? AND instance_id=? ORDER BY created_at DESC`).all(scope.userId, scope.projectId, scope.instanceId) as ReportAssetMapping[];
}

/**
 * Older `reviews.save` publications already have a durable backing asset but
 * predate the report catalog mapping. Add the no-copy mapping lazily when the
 * owning user opens their library. The INSERT is idempotent and never changes
 * bytes, asset versions, or quota usage.
 */
export function backfillFormalReportAssetMappings(scope: AssetScope): number {
  requireStorageScope(scope);
  ensureReportAssetMappingTable();
  const result = sqlite.prepare(
    `INSERT OR IGNORE INTO report_asset_mappings
     (mapping_id,report_id,user_id,project_id,instance_id,title,file_name,mime_type,size_bytes,backing_asset_id,backing_version_id,read_path,created_at)
     SELECT
       'report_map_backfill_' || artifact_id, artifact_id, user_id, project_id, instance_id,
       title, file_name, mime_type, size_bytes, asset_id, version_id, relative_path, created_at
     FROM conversation_artifacts artifact
     WHERE artifact.user_id = ? AND artifact.project_id = ? AND artifact.instance_id = ?
       AND artifact.source IN ('reviews.save', 'artifacts.publish')
       AND artifact.relative_path LIKE 'reports/%'
       AND artifact.asset_id IS NOT NULL AND artifact.version_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM report_asset_mappings mapping
         WHERE mapping.user_id = artifact.user_id AND mapping.project_id = artifact.project_id
           AND mapping.instance_id = artifact.instance_id AND mapping.report_id = artifact.artifact_id
       )`,
  ).run(scope.userId, scope.projectId, scope.instanceId);
  return Number(result.changes || 0);
}

/**
 * Look up a single mapping with its server-side `readPath`, enforcing the full
 * three-field scope. Returns null when the mapping does not belong to the
 * caller, so a cross-scope open is indistinguishable from a missing entry.
 */
export function getReportAssetMappingForRead(scope: AssetScope, mappingId: string): ReportAssetMappingRecord | null {
  requireStorageScope(scope);
  ensureReportAssetMappingTable();
  const row = sqlite.prepare(`SELECT mapping_id AS mappingId,report_id AS reportId,title,file_name AS fileName,mime_type AS mimeType,size_bytes AS sizeBytes,backing_asset_id AS backingAssetId,backing_version_id AS backingVersionId,read_path AS readPath,created_at AS createdAt FROM report_asset_mappings WHERE mapping_id=? AND user_id=? AND project_id=? AND instance_id=?`).get(mappingId, scope.userId, scope.projectId, scope.instanceId) as ReportAssetMappingRecord | undefined;
  return row ?? null;
}
