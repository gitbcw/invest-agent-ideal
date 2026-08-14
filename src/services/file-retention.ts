import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { resolveProjectStorageRoot } from "./project-storage-root.js";
import { logger } from "../lib/logger.js";
import { ATTACHMENT_RETENTION_DAYS, type StoredAttachment } from "../lib/attachment-store.js";
import { recordFileLifecycleEvent } from "./file-lifecycle-audit.js";

/**
 * Portal file-retention service. Owns the authoritative
 * `conversation_attachments` table and the deterministic cleanup loop. The
 * table — not the `attachments/YYYY-MM-DD/` directory layout — is the single
 * source of truth for upload TTL; the date directory is just an organisational
 * aid. See
 * `docs/portal-file-retention-and-library-governance-work-package.md` §5.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_RETENTION_MS = ATTACHMENT_RETENTION_DAYS * DAY_MS;

/** Batch size cap so one bad file cannot block the whole cleanup run. */
const CLEANUP_BATCH_LIMIT = Number(process.env.FILE_RETENTION_CLEANUP_BATCH) || 200;

export type AttachmentDeletionReason = "expired" | "user_deleted" | "missing" | "cleanup_error";

export interface RegisteredAttachmentRecord {
  attachmentId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId: string;
  messageId?: string | null;
  source: "portal" | "weixin";
  kind: "image" | "document";
  mimeType: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  checksum?: string;
  retentionClass: "transient_upload";
  storedAt: string;
  expiresAt: string;
  deletedAt?: string | null;
  deleteReason?: string | null;
  updatedAt: string;
}

/**
 * Registers a freshly stored upload in the authoritative attachment table.
 * `expiresAt` is computed server-side from `storedAt` and is the only value
 * the cleanup job consults; reading or downloading the file never extends it.
 */
export function registerAttachment(input: {
  userId: string;
  projectId?: string;
  instanceId: string;
  conversationId: string;
  messageId?: string | null;
  stored: StoredAttachment;
  storedAt?: string;
}): RegisteredAttachmentRecord {
  const now = (input.storedAt ?? new Date().toISOString());
  const expiresAt = new Date(new Date(now).getTime() + ATTACHMENT_RETENTION_MS).toISOString();
  sqlite
    .prepare(
      `INSERT INTO conversation_attachments (
         attachment_id, user_id, project_id, instance_id, conversation_id, message_id,
         source, kind, mime_type, file_name, relative_path, size_bytes,
         checksum, retention_class, stored_at, expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transient_upload', ?, ?, ?)
       ON CONFLICT(attachment_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         message_id = COALESCE(excluded.message_id, conversation_attachments.message_id),
         source = excluded.source,
         kind = excluded.kind,
         mime_type = excluded.mime_type,
         file_name = excluded.file_name,
         relative_path = excluded.relative_path,
         size_bytes = excluded.size_bytes,
         checksum = excluded.checksum,
         stored_at = excluded.stored_at,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    )
    .run(
      input.stored.id,
      input.userId,
      input.projectId ?? "invest-agent",
      input.instanceId,
      input.conversationId,
      input.messageId ?? null,
      input.stored.source,
      input.stored.type,
      input.stored.mimeType,
      input.stored.fileName,
      input.stored.relativePath,
      input.stored.sizeBytes,
      input.stored.checksum,
      now,
      expiresAt,
      now,
    );
  return {
    attachmentId: input.stored.id,
    userId: input.userId,
    projectId: input.projectId ?? "invest-agent",
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    messageId: input.messageId ?? null,
    source: input.stored.source,
    kind: input.stored.type,
    mimeType: input.stored.mimeType,
    fileName: input.stored.fileName,
    relativePath: input.stored.relativePath,
    sizeBytes: input.stored.sizeBytes,
    checksum: input.stored.checksum,
    retentionClass: "transient_upload",
    storedAt: now,
    expiresAt,
    deletedAt: null,
    deleteReason: null,
    updatedAt: now,
  };
}

/** Binds an attachment row to the message that ultimately carried it. */
export function bindAttachmentMessage(input: {
  attachmentId: string;
  messageId: string;
}): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(`UPDATE conversation_attachments SET message_id = ?, updated_at = ? WHERE attachment_id = ?`)
    .run(input.messageId, now, input.attachmentId);
}

export interface AttachmentReadResult {
  attachmentId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId: string;
  source: "portal" | "weixin";
  kind: "image" | "document";
  mimeType: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  checksum?: string;
  storedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "deleted";
}

export function findAttachmentRecord(input: {
  attachmentId: string;
  userId: string;
  projectId?: string;
  instanceId: string;
}): AttachmentReadResult | undefined {
  const row = sqlite
    .prepare(
      `SELECT
         attachment_id AS attachmentId,
         user_id AS userId,
         project_id AS projectId,
         instance_id AS instanceId,
         conversation_id AS conversationId,
         source,
         kind,
         mime_type AS mimeType,
         file_name AS fileName,
         relative_path AS relativePath,
         size_bytes AS sizeBytes,
         checksum,
         stored_at AS storedAt,
         expires_at AS expiresAt,
         deleted_at AS deletedAt,
         delete_reason AS deleteReason
       FROM conversation_attachments
       WHERE attachment_id = ?`
    )
    .get(input.attachmentId) as
    | (Omit<AttachmentReadResult, "status"> & { deletedAt: string | null; deleteReason: string | null })
    | undefined;
  if (!row) return undefined;
  if (row.userId !== input.userId || row.projectId !== (input.projectId ?? "invest-agent") || row.instanceId !== input.instanceId) return undefined;
  let status: AttachmentReadResult["status"] = "active";
  if (row.deletedAt) status = row.deleteReason === "expired" ? "expired" : "deleted";
  else if (new Date(row.expiresAt).getTime() <= Date.now()) status = "expired";
  const { deletedAt: _d, deleteReason: _r, ...rest } = row;
  return { ...rest, status };
}

export async function readAttachmentBytes(input: {
  attachmentId: string;
  userId: string;
  projectId?: string;
  instanceId: string;
}): Promise<{ bytes: Buffer; record: AttachmentReadResult }> {
  const record = findAttachmentRecord(input);
  if (!record) throw new AttachmentRetentionError("ATTACHMENT_NOT_FOUND", input.attachmentId);
  if (record.status === "deleted") throw new AttachmentRetentionError("ATTACHMENT_DELETED", input.attachmentId);
  if (record.status === "expired") throw new AttachmentRetentionError("ATTACHMENT_EXPIRED", input.attachmentId);
  const workspacePath = await resolveProjectStorageRoot({ userId: record.userId, projectId: record.projectId, instanceId: record.instanceId });
  const attachmentsRoot = path.join(workspacePath, "attachments");
  const targetPath = path.resolve(workspacePath, record.relativePath);
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(attachmentsRoot), realpath(targetPath)]);
  } catch {
    throw new AttachmentRetentionError("ATTACHMENT_NOT_FOUND", record.relativePath);
  }
  if (!isWithin(realRoot, realTarget)) throw new AttachmentRetentionError("ATTACHMENT_NOT_FOUND", record.relativePath);
  const fileStat = await stat(realTarget);
  if (!fileStat.isFile()) throw new AttachmentRetentionError("ATTACHMENT_NOT_FOUND", record.relativePath);
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(realTarget);
  if (record.checksum && createHash("sha256").update(bytes).digest("hex") !== record.checksum) {
    throw new AttachmentRetentionError("ATTACHMENT_NOT_FOUND", "checksum mismatch");
  }
  return { bytes, record };
}

export class AttachmentRetentionError extends Error {
  constructor(
    public readonly code: "ATTACHMENT_NOT_FOUND" | "ATTACHMENT_EXPIRED" | "ATTACHMENT_DELETED" | "ATTACHMENT_SCOPE_MISMATCH",
    message: string,
  ) {
    super(`${code}:${message}`);
    this.name = "AttachmentRetentionError";
  }
}

export interface CleanupSummary {
  scanned: number;
  deletedFiles: number;
  deletedBytes: number;
  missing: number;
  errors: number;
  byUser: Record<string, { scanned: number; deletedFiles: number; deletedBytes: number; missing: number; errors: number }>;
}

/**
 * Idempotent attachment cleanup. Selects rows whose `expires_at` has passed
 * and that have not been deleted yet, re-validates workspace containment +
 * realpath for each row, and unlinks only the precise file. A missing file is
 * treated as success (`missing`) so a repeated run cannot wedge on a row whose
 * bytes were already removed out-of-band. Pass `dryRun: true` to compute the
 * same plan without touching disk or writing destructive state.
 */
export async function cleanupExpiredAttachments(input: {
  now?: Date;
  dryRun?: boolean;
  limit?: number;
}): Promise<CleanupSummary> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(Math.max(input.limit ?? CLEANUP_BATCH_LIMIT, 1), CLEANUP_BATCH_LIMIT);
  const rows = sqlite
    .prepare(
      `SELECT
         attachment_id AS attachmentId,
         user_id AS userId,
         project_id AS projectId,
         instance_id AS instanceId,
         relative_path AS relativePath,
         size_bytes AS sizeBytes,
         checksum
       FROM conversation_attachments
       WHERE expires_at <= ? AND deleted_at IS NULL
       ORDER BY expires_at ASC
       LIMIT ?`
    )
    .all(nowIso, limit) as Array<{
      attachmentId: string;
      userId: string;
      projectId: string;
      instanceId: string;
      relativePath: string;
      sizeBytes: number;
      checksum: string | null;
    }>;
  const summary: CleanupSummary = {
    scanned: rows.length,
    deletedFiles: 0,
    deletedBytes: 0,
    missing: 0,
    errors: 0,
    byUser: {},
  };
  for (const row of rows) {
    const bucket = summary.byUser[row.userId] ??= { scanned: 0, deletedFiles: 0, deletedBytes: 0, missing: 0, errors: 0 };
    bucket.scanned += 1;
    const outcome = await deleteAttachmentBytes({
      userId: row.userId,
      projectId: row.projectId,
      instanceId: row.instanceId,
      relativePath: row.relativePath,
      dryRun: input.dryRun,
    });
    if (outcome === "deleted") {
      summary.deletedFiles += 1;
      summary.deletedBytes += row.sizeBytes;
      bucket.deletedFiles += 1;
      bucket.deletedBytes += row.sizeBytes;
    } else if (outcome === "missing") {
      summary.missing += 1;
      bucket.missing += 1;
    } else {
      summary.errors += 1;
      bucket.errors += 1;
    }
    if (!input.dryRun && outcome !== "error") {
      const reason = outcome === "missing" ? "missing" : outcome === "deleted" ? "expired" : "cleanup_error";
      markAttachmentDeleted({ attachmentId: row.attachmentId, reason });
      recordFileLifecycleEvent({
        entityType: "attachment",
        entityId: row.attachmentId,
        userId: row.userId,
        instanceId: row.instanceId,
        event: "attachment.expiry",
        status: "success",
        reason,
        summary: { sizeBytes: row.sizeBytes, outcome },
      });
    } else if (!input.dryRun) {
      recordFileLifecycleEvent({
        entityType: "attachment",
        entityId: row.attachmentId,
        userId: row.userId,
        instanceId: row.instanceId,
        event: "attachment.expiry",
        status: "failure",
        reason: "cleanup_error",
        summary: { sizeBytes: row.sizeBytes, outcome },
      });
    }
  }
  return summary;
}

async function deleteAttachmentBytes(input: {
  userId: string;
  projectId?: string;
  instanceId?: string;
  relativePath: string;
  dryRun?: boolean;
}): Promise<"deleted" | "missing" | "error"> {
  const workspacePath = await resolveProjectStorageRoot({ userId: input.userId, projectId: input.projectId, instanceId: input.instanceId });
  const attachmentsRoot = path.join(workspacePath, "attachments");
  const targetPath = path.resolve(workspacePath, input.relativePath);
  let realRoot: string;
  let realTarget: string;
  try {
    [realRoot, realTarget] = await Promise.all([realpath(attachmentsRoot), realpath(targetPath)]);
  } catch {
    // realpath failure means the file is already gone — treat as idempotent success.
    return "missing";
  }
  if (!isWithin(realRoot, realTarget)) {
    logger.warn(`attachment cleanup refused path escape userId=${input.userId} relativePath=${input.relativePath}`);
    return "error";
  }
  let fileStat;
  try {
    fileStat = await lstat(realTarget);
  } catch {
    return "missing";
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    logger.warn(`attachment cleanup skipped non-file userId=${input.userId} relativePath=${input.relativePath}`);
    return "error";
  }
  if (input.dryRun) return "deleted";
  try {
    await rm(realTarget, { force: true });
    return "deleted";
  } catch (error) {
    logger.warn(`attachment cleanup unlink failed userId=${input.userId} relativePath=${input.relativePath}: ${(error as Error).message}`);
    return "error";
  }
}

function markAttachmentDeleted(input: { attachmentId: string; reason: AttachmentDeletionReason }) {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE conversation_attachments
       SET deleted_at = ?, delete_reason = ?, updated_at = ?
       WHERE attachment_id = ? AND deleted_at IS NULL`
    )
    .run(now, input.reason, now, input.attachmentId);
}

/**
 * Idempotently removes now-empty `attachments/YYYY-MM-DD/` directories. Empty
 * directory removal is best-effort and is NOT a completion gate for the
 * retention job; never deletes a directory that still contains an indexed
 * attachment.
 */
export async function pruneEmptyAttachmentDateDirs(input: { now?: Date } = {}): Promise<{ removed: number }> {
  const now = input.now ?? new Date();
  const indexedRelative = new Set<string>();
  const rows = sqlite
    .prepare(`SELECT DISTINCT relative_path AS relativePath FROM conversation_attachments`)
    .all() as Array<{ relativePath: string }>;
  for (const row of rows) {
    let dir = path.posix.dirname(row.relativePath);
    while (dir.startsWith("attachments/") || dir === "attachments") {
      indexedRelative.add(dir);
      const parent = path.posix.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  void now;
  let removed = 0;
  const workspaces = await listWorkspaceRoots();
  for (const workspacePath of workspaces) {
    const attachmentsRoot = path.join(workspacePath, "attachments");
    let dateDirs;
    try {
      dateDirs = await readdir(attachmentsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dateDirs) {
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const dirPath = path.join(attachmentsRoot, dir.name);
      const relativeDir = path.posix.join("attachments", dir.name);
      if (indexedRelative.has(relativeDir)) continue;
      try {
        const nested = await readdir(dirPath, { withFileTypes: true });
        if (nested.length === 0) {
          await rm(dirPath, { force: true });
          removed += 1;
        }
      } catch {
        // ignore — directory removal is purely cosmetic
      }
    }
  }
  return { removed };
}

async function listWorkspaceRoots(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { config } = await import("../lib/config.js");
  let entries;
  try {
    entries = await readdir(config.workspace.root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(config.workspace.root, entry.name));
}

function isWithin(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/**
 * Generates the deterministic key the daily retention cleanup claims under in
 * `scheduled_task_runs` so that two Runtime processes cannot run the same
 * batch concurrently. Kept here so the retention job and its tests agree on
 * the exact shape.
 */
export function attachmentCleanupTaskKey(input: { dateKey: string; slot?: string }) {
  return `file-retention:attachments:${input.dateKey}:${input.slot ?? "default"}`;
}

/** Generates a random opaque token id for delete-confirmation flows. */
export function newConfirmationTokenId(): string {
  return `del_${randomUUID()}`;
}
