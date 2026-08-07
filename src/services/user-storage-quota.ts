import { randomUUID } from "node:crypto";
import { sqlite } from "../db/index.js";
import type { AssetScope } from "./user-assets.js";
import { UserAssetError } from "./user-asset-error.js";

export const USER_STORAGE_LIMIT_BYTES = 200 * 1024 * 1024;
export const USER_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const USER_UPLOAD_REQUEST_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How long a storage reservation stays "active" before it is considered a
 * crashed/abandoned write and can be reclaimed. The scope storage lock
 * serializes writes, so this only needs to comfortably outlast a single
 * stage+commit; it is the recovery bound after a process death.
 */
export const STORAGE_RESERVATION_LEASE_MS = 5 * 60 * 1000;

export type StorageUsage = {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  availableBytes: number;
};

/**
 * Every public quota/mapping entrypoint funnels scope through this guard so an
 * empty userId/projectId/instanceId can never reach a SQL write or a lock key.
 */
export function requireStorageScope(scope: AssetScope): void {
  if (
    !scope
    || typeof scope.userId !== "string" || !scope.userId.trim()
    || typeof scope.projectId !== "string" || !scope.projectId.trim()
    || typeof scope.instanceId !== "string" || !scope.instanceId.trim()
  ) {
    throw new UserAssetError("ASSET_INVALID_SCOPE", "userId, projectId and instanceId are required");
  }
}

export function ensureStorageQuotaTable(): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS user_storage_quotas (
    user_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
    used_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id, instance_id)
  );
  CREATE TABLE IF NOT EXISTS report_asset_mappings (
    mapping_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, user_id TEXT NOT NULL,
    project_id TEXT NOT NULL, instance_id TEXT NOT NULL, title TEXT NOT NULL,
    file_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    backing_asset_id TEXT, backing_version_id TEXT, read_path TEXT, created_at TEXT NOT NULL,
    UNIQUE(user_id, project_id, instance_id, report_id)
  );
  CREATE TABLE IF NOT EXISTS user_storage_reservations (
    reservation_token TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
    instance_id TEXT NOT NULL, requested_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_storage_reservations_scope_status
    ON user_storage_reservations(user_id, project_id, instance_id, status, expires_at);`);
}

function nowIso(): string { return new Date().toISOString(); }

function touchQuotaRow(scope: AssetScope): void {
  sqlite.prepare(`INSERT INTO user_storage_quotas (user_id,project_id,instance_id,used_bytes,reserved_bytes,updated_at)
    VALUES (?,?,?,0,0,?) ON CONFLICT(user_id,project_id,instance_id) DO NOTHING`).run(
    scope.userId, scope.projectId, scope.instanceId, nowIso(),
  );
}

/**
 * Authoritative committed bytes for a scope: every long-lived asset version
 * plus report mappings that do not back onto an asset (so their bytes are not
 * already counted by a version row). Backed mappings are no-copy references.
 */
export function authoritativeUsedBytes(scope: AssetScope): number {
  requireStorageScope(scope);
  ensureStorageQuotaTable();
  const row = sqlite.prepare(`SELECT
    COALESCE((SELECT SUM(size_bytes) FROM user_asset_versions v
      WHERE v.user_id = ? AND v.project_id = ? AND v.instance_id = ?), 0)
    + COALESCE((SELECT SUM(size_bytes) FROM report_asset_mappings r
      WHERE r.user_id = ? AND r.project_id = ? AND r.instance_id = ? AND r.backing_asset_id IS NULL), 0) AS used
  `).get(
    scope.userId, scope.projectId, scope.instanceId,
    scope.userId, scope.projectId, scope.instanceId,
  ) as { used: number } | undefined;
  return Number(row?.used || 0);
}

/**
 * Sum of bytes held by still-active, non-expired reservations. Expired active
 * reservations are excluded from the live count even before they are reclaimed,
 * so a process that dies mid-write can never permanently inflate the number.
 */
function sumActiveReservations(scope: AssetScope, nowMs: number): number {
  const row = sqlite.prepare(`SELECT COALESCE(SUM(requested_bytes), 0) AS total
    FROM user_storage_reservations
    WHERE user_id = ? AND project_id = ? AND instance_id = ? AND status = 'active' AND expires_at > ?`)
    .get(scope.userId, scope.projectId, scope.instanceId, new Date(nowMs).toISOString()) as { total: number } | undefined;
  return Number(row?.total || 0);
}

export function getStorageUsage(scope: AssetScope): StorageUsage {
  requireStorageScope(scope);
  const usedBytes = authoritativeUsedBytes(scope);
  const reservedBytes = sumActiveReservations(scope, Date.now());
  return { usedBytes, reservedBytes, limitBytes: USER_STORAGE_LIMIT_BYTES, availableBytes: Math.max(0, USER_STORAGE_LIMIT_BYTES - usedBytes - reservedBytes) };
}

export function assertUploadRequestSize(sizes: number[]): void {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.some((size) => !Number.isFinite(size) || size < 0 || size > USER_ASSET_MAX_BYTES)) {
    throw new UserAssetError("ASSET_TOO_LARGE", "single file exceeds 10MB", { limitBytes: USER_ASSET_MAX_BYTES });
  }
  if (total > USER_UPLOAD_REQUEST_MAX_BYTES) {
    throw new UserAssetError("UPLOAD_REQUEST_TOO_LARGE", "upload request exceeds 20MB", { limitBytes: USER_UPLOAD_REQUEST_MAX_BYTES, requestedBytes: total });
  }
}

/**
 * Scope-level mutation lock key shared by every long-lived user-storage write.
 * Holding it serializes staging+commit for one (userId, projectId, instanceId)
 * across processes, so two concurrent writes cannot both pass the quota check
 * and then overshoot on commit.
 */
export function scopeStorageLockKey(scope: AssetScope): string {
  requireStorageScope(scope);
  return `user-storage-scope:${scope.projectId}:${scope.instanceId}`;
}

/**
 * Atomically reserve `requestedBytes` against the scope quota and return an
 * opaque token. The caller must already hold the scope storage mutation lock.
 * Every successful reserve is settled by exactly one of
 * {@link commitStorageReservation} (the bytes landed) or
 * {@link releaseStorageReservation} (the write failed). Both settlers are
 * idempotent per token, so a finally + catch pair cannot double-apply. Throws
 * `USER_STORAGE_QUOTA_EXCEEDED` when the scope is full; on throw no reservation
 * row is created, so nothing leaks.
 */
export function reserveStorage(scope: AssetScope, requestedBytes: number): string {
  requireStorageScope(scope);
  if (!Number.isFinite(requestedBytes) || requestedBytes < 0) {
    throw new UserAssetError("ASSET_INVALID_CONTENT", "requestedBytes must be a non-negative finite number");
  }
  ensureStorageQuotaTable();
  const token = "resv_" + randomUUID().replaceAll("-", "");
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + STORAGE_RESERVATION_LEASE_MS).toISOString();
  sqlite.transaction(() => {
    touchQuotaRow(scope);
    const usedBytes = authoritativeUsedBytes(scope);
    const reservedBytes = sumActiveReservations(scope, nowMs);
    if (usedBytes + reservedBytes + requestedBytes > USER_STORAGE_LIMIT_BYTES) {
      throw new UserAssetError("USER_STORAGE_QUOTA_EXCEEDED", "user storage quota exceeded", {
        limitBytes: USER_STORAGE_LIMIT_BYTES, usedBytes, reservedBytes, requestedBytes,
      });
    }
    sqlite.prepare(`INSERT INTO user_storage_reservations
      (reservation_token,user_id,project_id,instance_id,requested_bytes,status,created_at,expires_at,settled_at)
      VALUES (?,?,?,?,?, 'active', ?, ?, NULL)`)
      .run(token, scope.userId, scope.projectId, scope.instanceId, requestedBytes, createdAt, expiresAt);
  })();
  return token;
}

/**
 * Settle a reservation as committed. Idempotent: a token already in a terminal
 * state (committed/released) is a no-op, so committing twice or after a release
 * can never move bytes twice. Safe to call inside an outer transaction.
 */
export function commitStorageReservation(scope: AssetScope, token: string): void {
  requireStorageScope(scope);
  if (!token) return;
  ensureStorageQuotaTable();
  sqlite.prepare(`UPDATE user_storage_reservations SET status = 'committed', settled_at = ?
    WHERE reservation_token = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'active'`)
    .run(nowIso(), token, scope.userId, scope.projectId, scope.instanceId);
}

/**
 * Settle a reservation as released (the write failed, bytes never landed).
 * Idempotent by the same token guard as {@link commitStorageReservation}; a
 * stray double-release can never release another writer's reservation.
 */
export function releaseStorageReservation(scope: AssetScope, token: string): void {
  requireStorageScope(scope);
  if (!token) return;
  ensureStorageQuotaTable();
  sqlite.prepare(`UPDATE user_storage_reservations SET status = 'released', settled_at = ?
    WHERE reservation_token = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'active'`)
    .run(nowIso(), token, scope.userId, scope.projectId, scope.instanceId);
}

/**
 * Defense-in-depth re-check invoked inside the version-insert transaction,
 * after the new version row is visible. The reservation for this write is still
 * active at this point, so it is subtracted to avoid double-counting. Throws if
 * the committed bytes plus other pending reservations exceed the limit.
 */
export function assertCommittedBytesWithinQuota(scope: AssetScope, requestedBytes: number): void {
  requireStorageScope(scope);
  const usedBytes = authoritativeUsedBytes(scope);
  const reservedBytes = sumActiveReservations(scope, Date.now());
  if (usedBytes + Math.max(0, reservedBytes - requestedBytes) > USER_STORAGE_LIMIT_BYTES) {
    throw new UserAssetError("USER_STORAGE_QUOTA_EXCEEDED", "user storage quota exceeded", {
      limitBytes: USER_STORAGE_LIMIT_BYTES, usedBytes, reservedBytes, requestedBytes,
    });
  }
}

/**
 * Settle any active reservation whose lease has expired. Committed usage
 * (versions, mappings) is never touched; only abandoned in-flight writes are
 * reclaimed. Returns the number reclaimed. This is the crash/expired-lease
 * recovery path; the live reserved-bytes count already excludes these rows.
 */
export function reclaimExpiredStorageReservations(scope: AssetScope): number {
  requireStorageScope(scope);
  ensureStorageQuotaTable();
  const now = nowIso();
  const result = sqlite.prepare(`UPDATE user_storage_reservations SET status = 'released', settled_at = ?
    WHERE user_id = ? AND project_id = ? AND instance_id = ? AND status = 'active' AND expires_at <= ?`)
    .run(now, scope.userId, scope.projectId, scope.instanceId, now);
  return Number(result.changes || 0);
}

/** Keep the additive accounting row warm for operators; the version/mapping sums remain authoritative. */
export function recordStorageCommit(scope: AssetScope, committedBytes: number): void {
  requireStorageScope(scope);
  ensureStorageQuotaTable();
  sqlite.prepare(`INSERT INTO user_storage_quotas (user_id,project_id,instance_id,used_bytes,reserved_bytes,updated_at)
    VALUES (?,?,?,?,0,?) ON CONFLICT(user_id,project_id,instance_id)
    DO UPDATE SET used_bytes = used_bytes + excluded.used_bytes, updated_at = excluded.updated_at`).run(
    scope.userId, scope.projectId, scope.instanceId, committedBytes, new Date().toISOString(),
  );
}

/**
 * Operator recovery helper: transient reservations only exist while a write is
 * staging. This reclaims any reservation whose lease has already expired
 * (preserving committed usage); the authoritative used bytes are always
 * recomputed from version/mapping rows, and the live reserved count already
 * ignores expired rows.
 */
export function resetStorageReservations(scope: AssetScope): void {
  reclaimExpiredStorageReservations(scope);
}
