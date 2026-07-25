import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { logger } from "../lib/logger.js";
import { recordFileLifecycleEvent } from "./file-lifecycle-audit.js";
import {
  ARTIFACT_SELECT_COLUMNS,
  CURATED_LIBRARY_DIRECTORIES,
  DURABLE_LIBRARY_MAX_BYTES,
  DURABLE_LIBRARY_MIME_TYPES,
  classifyArtifactRetention,
  type ArtifactOrigin,
  type ArtifactRetentionClass,
  type ArtifactVisibility,
  type ConversationArtifactRecord,
  type ConversationArtifactScope,
} from "./conversation-artifacts.js";

/**
 * Idempotent backfill for the file-retention governance rollout. Three
 * independent passes, each safe to re-run:
 *
 *  1. `backfillArtifactRetentionClassification` — tags every existing
 *     `conversation_artifacts` row with `origin`/`retention_class`/`visibility`/
 *     `expires_at` using the same deterministic rules as the publish path.
 *
 *  2. `backfillCuratedWorkspaceReports` — scans the fixed curated directories
 *     (§4.1) for each production user/instance and registers any admissible
 *     file as a new `workspace_backfill` artifact. Idempotent on
 *     `(userId, instanceId, relativePath, checksum)`.
 *
 *  3. `backfillAttachmentIndex` — rebuilds `conversation_attachments` rows from
 *     `conversation_messages.metadata.attachments` so the cleanup job has
 *     something authoritative to act on. Historical rows past the 7-day window
 *     are tagged `cleanup_candidate` and left untouched on the first pass.
 *
 * None of these passes move, modify, or delete files. They only write index
 * rows. See work package §7.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_MS = 7 * DAY_MS;

const EXT_MIME_MAP: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

const KIND_BY_MIME: Record<string, ConversationArtifactRecord["kind"]> = {
  "image/svg+xml": "chart",
  "image/png": "chart",
  "image/jpeg": "chart",
  "image/webp": "chart",
  "application/pdf": "document",
  "text/plain": "data",
  "text/markdown": "report",
  "text/html": "report",
  "application/json": "data",
  "text/csv": "data",
};
const MIME_PREVIEW_MODE: Record<string, ConversationArtifactRecord["previewMode"]> = {
  "image/svg+xml": "image",
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/html": "html",
  "application/json": "text",
  "text/csv": "table",
};

export interface BackfillArtifactClassificationSummary {
  scanned: number;
  classified: number;
  durableLibrary: number;
  transientGenerated: number;
  referenceOnly: number;
  alreadyClassified: number;
  oversizedFormal: number;
}

export async function backfillArtifactRetentionClassification(input: {
  now?: Date;
  limit?: number;
  dryRun?: boolean;
} = {}): Promise<BackfillArtifactClassificationSummary> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), 50000);
  const rows = sqlite
    .prepare(
      `SELECT ${ARTIFACT_SELECT_COLUMNS}, source
       FROM conversation_artifacts
       WHERE retention_class IS NULL OR visibility IS NULL OR origin IS NULL
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as Array<ConversationArtifactRecord & { source: string }>;
  const summary: BackfillArtifactClassificationSummary = {
    scanned: rows.length,
    classified: 0,
    durableLibrary: 0,
    transientGenerated: 0,
    referenceOnly: 0,
    alreadyClassified: 0,
    oversizedFormal: 0,
  };
  const update = sqlite.prepare(
    `UPDATE conversation_artifacts
     SET origin = ?, retention_class = ?, visibility = ?, expires_at = COALESCE(?, expires_at), updated_at = ?
     WHERE artifact_id = ?`,
  );
  const nowIso = now.toISOString();
  for (const row of rows) {
    // Re-validate size against the actual file when possible: a row whose
    // stored size disagrees with disk cannot be promoted to durable.
    let sizeBytes = row.sizeBytes;
    try {
      const workspacePath = resolveWorkspacePath(row.userId);
      const target = path.resolve(workspacePath, row.relativePath);
      const real = await realpath(target);
      const fileStat = await stat(real);
      if (fileStat.isFile()) sizeBytes = fileStat.size;
    } catch {
      // File missing — keep the stored size, classification will still tag the
      // row (transient/reference) so it does not silently appear in the tree.
    }
    const source = row.source as ConversationArtifactScope["source"];
    const classification = classifyArtifactRetention({
      source,
      relativePath: row.relativePath,
      sizeBytes,
      mimeType: row.mimeType,
      now,
    });
    if (!classification) {
      summary.alreadyClassified += 1;
      continue;
    }
    if (!input.dryRun) {
      update.run(
        classification.origin,
        classification.retentionClass,
        classification.visibility,
        classification.expiresAt,
        nowIso,
        row.artifactId,
      );
      recordFileLifecycleEvent({
        entityType: "artifact",
        entityId: row.artifactId,
        userId: row.userId,
        instanceId: row.instanceId,
        event: "artifact.backfill.classified",
        status: "success",
        summary: {
          source,
          retentionClass: classification.retentionClass,
          visibility: classification.visibility,
          sizeBytes,
          expiresAt: classification.expiresAt,
        },
      });
    }
    summary.classified += 1;
    if (classification.retentionClass === "durable_library") summary.durableLibrary += 1;
    else if (classification.retentionClass === "transient_generated") summary.transientGenerated += 1;
    else if (classification.retentionClass === "reference_only") summary.referenceOnly += 1;
    const isFormalSource = source === "reviews.save" || source === "artifacts.publish";
    if (classification.retentionClass === "transient_generated" && isFormalSource && sizeBytes > DURABLE_LIBRARY_MAX_BYTES) {
      summary.oversizedFormal += 1;
    }
  }
  return summary;
}

export interface BackfillWorkspaceReportSummary {
  scannedUsers: number;
  scannedFiles: number;
  registered: number;
  alreadyIndexed: number;
  excludedOversize: number;
  excludedMime: number;
  excludedPath: number;
  errors: number;
}

/**
 * Scans the fixed curated library directories for each known user/instance and
 * registers any admissible file as a `workspace_backfill` artifact. Idempotent
 * on `(userId, instanceId, relativePath, checksum)`. Never moves or modifies
 * the underlying file.
 */
export async function backfillCuratedWorkspaceReports(input: {
  now?: Date;
  dryRun?: boolean;
} = {}): Promise<BackfillWorkspaceReportSummary> {
  const now = input.now ?? new Date();
  const summary: BackfillWorkspaceReportSummary = {
    scannedUsers: 0,
    scannedFiles: 0,
    registered: 0,
    alreadyIndexed: 0,
    excludedOversize: 0,
    excludedMime: 0,
    excludedPath: 0,
    errors: 0,
  };
  const scopes = listProductionScopes();
  summary.scannedUsers = scopes.length;
  for (const scope of scopes) {
    const workspacePath = resolveWorkspacePath(scope.userId);
    let reportsRoot: string;
    try {
      reportsRoot = await realpath(path.join(workspacePath, "reports"));
    } catch {
      continue;
    }
    for (const dir of CURATED_LIBRARY_DIRECTORIES) {
      const dirPath = path.join(workspacePath, dir);
      let realDirPath: string;
      try {
        realDirPath = await realpath(dirPath);
      } catch {
        continue;
      }
      let files: string[] = [];
      try {
        files = await listFilesRecursive(realDirPath, reportsRoot);
      } catch {
        continue;
      }
      for (const file of files) {
        summary.scannedFiles += 1;
        const relativePath = path.posix.join("reports", path.relative(reportsRoot, file).split(path.sep).join("/"));
        if (!isCuratedLibraryPath(relativePath)) {
          summary.excludedPath += 1;
          continue;
        }
        const ext = path.extname(file).toLowerCase();
        const mimeType = EXT_MIME_MAP[ext];
        if (!mimeType || !DURABLE_LIBRARY_MIME_TYPES.has(mimeType)) {
          summary.excludedMime += 1;
          continue;
        }
        let fileStat;
        try {
          fileStat = await lstat(file);
        } catch {
          summary.errors += 1;
          continue;
        }
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
          summary.excludedPath += 1;
          continue;
        }
        if (fileStat.size > DURABLE_LIBRARY_MAX_BYTES) {
          summary.excludedOversize += 1;
          continue;
        }
        let checksum: string;
        try {
          const { readFile } = await import("node:fs/promises");
          const bytes = await readFile(file);
          checksum = createHash("sha256").update(bytes).digest("hex");
        } catch {
          summary.errors += 1;
          continue;
        }
        // Idempotency: same path + checksum already indexed -> skip.
        const existing = sqlite
          .prepare(
            `SELECT 1 FROM conversation_artifacts
             WHERE user_id = ? AND instance_id = ? AND relative_path = ? AND checksum = ?
             LIMIT 1`
          )
          .get(scope.userId, scope.instanceId, relativePath, checksum);
        if (existing) {
          summary.alreadyIndexed += 1;
          continue;
        }
        if (input.dryRun) {
          summary.registered += 1;
          continue;
        }
        try {
          const artifactId = registerWorkspaceBackfillArtifact({
            userId: scope.userId,
            instanceId: scope.instanceId,
            relativePath,
            mimeType,
            sizeBytes: fileStat.size,
            checksum,
            now,
          });
          recordFileLifecycleEvent({
            entityType: "artifact",
            entityId: artifactId,
            userId: scope.userId,
            instanceId: scope.instanceId,
            event: "artifact.backfill.registered",
            status: "success",
            summary: { retentionClass: "durable_library", sizeBytes: fileStat.size, mimeType },
          });
          summary.registered += 1;
        } catch (error) {
          summary.errors += 1;
          logger.warn(`workspace backfill register failed userId=${scope.userId} relativePath=${relativePath}: ${(error as Error).message}`);
        }
      }
    }
  }
  return summary;
}

function registerWorkspaceBackfillArtifact(input: {
  userId: string;
  instanceId: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  now: Date;
}): string {
  // Derive a stable, collision-resistant id from the full scope+path+checksum.
  // A plain base64url prefix would collide once the scope prefix is long
  // enough, so hash the whole binding instead.
  const idSeed = createHash("sha256")
    .update(`${input.userId}:${input.instanceId}:${input.relativePath}:${input.checksum}`)
    .digest("base64url")
    .slice(0, 22);
  const artifactId = `art_${idSeed}`;
  const nowIso = input.now.toISOString();
  const fileName = path.posix.basename(input.relativePath);
  const kind = KIND_BY_MIME[input.mimeType] ?? "document";
  const previewMode = MIME_PREVIEW_MODE[input.mimeType] ?? "unsupported";
  const title = fileName;
  sqlite
    .prepare(
      `INSERT INTO conversation_artifacts (
         artifact_id, user_id, instance_id, project_id, assistant_id,
         conversation_id, message_id, turn_id, source, kind, preview_mode,
         title, file_name, mime_type, relative_path, size_bytes, checksum,
         created_at, updated_at,
         origin, retention_class, visibility, expires_at
       ) VALUES (
         @artifactId, @userId, @instanceId, 'invest-agent', @instanceId,
         NULL, NULL, NULL, 'workspace_backfill', @kind, @previewMode,
         @title, @fileName, @mimeType, @relativePath, @sizeBytes, @checksum,
         @now, @now,
         'workspace_backfill', 'durable_library', 'library', NULL
       )
       ON CONFLICT(artifact_id) DO NOTHING`
    )
    .run({
      artifactId,
      userId: input.userId,
      instanceId: input.instanceId,
      kind,
      previewMode,
      title,
      fileName,
      mimeType: input.mimeType,
      relativePath: input.relativePath,
      sizeBytes: input.sizeBytes,
      checksum: input.checksum,
      now: nowIso,
    });
  return artifactId;
}

export interface BackfillAttachmentIndexSummary {
  scannedMessages: number;
  registered: number;
  alreadyIndexed: number;
  cleanupCandidates: number;
  unattributable: number;
  errors: number;
}

interface ScopeRow {
  userId: string;
  instanceId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  metadata: string;
}

/**
 * Rebuilds `conversation_attachments` rows from message metadata. Uses the
 * message timestamp as `storedAt` when available; rows already past the 7-day
 * window are tagged via `deleteReason='cleanup_candidate'` (NOT deleted) so the
 * first confirmed cleanup pass can pick them up deliberately. Idempotent on
 * `attachmentId`.
 */
export async function backfillAttachmentIndex(input: {
  now?: Date;
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<BackfillAttachmentIndexSummary> {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), 50000);
  const rows = sqlite
    .prepare(
      `SELECT message_id AS messageId,
              user_id AS userId,
              instance_id AS instanceId,
              conversation_id AS conversationId,
              created_at AS createdAt,
              metadata
       FROM conversation_messages
       WHERE metadata LIKE '%attachments%'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as ScopeRow[];
  const summary: BackfillAttachmentIndexSummary = {
    scannedMessages: rows.length,
    registered: 0,
    alreadyIndexed: 0,
    cleanupCandidates: 0,
    unattributable: 0,
    errors: 0,
  };
  const existingIds = new Set<string>(
    (sqlite.prepare(`SELECT attachment_id AS id FROM conversation_attachments`).all() as Array<{ id: string }>).map((row) => row.id),
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.metadata || "{}");
    } catch {
      summary.errors += 1;
      continue;
    }
    const attachments = (parsed && typeof parsed === "object" && Array.isArray((parsed as { attachments?: unknown }).attachments))
      ? ((parsed as { attachments: Array<Record<string, unknown>> }).attachments)
      : [];
    for (const attachment of attachments) {
      const attachmentId = typeof attachment.id === "string" ? attachment.id : typeof attachment.attachmentId === "string" ? attachment.attachmentId : null;
      const relativePath = typeof attachment.relativePath === "string" ? attachment.relativePath : null;
      const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType : null;
      const fileName = typeof attachment.fileName === "string" ? attachment.fileName : null;
      const sizeBytes = typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : null;
      const source = typeof attachment.source === "string" ? (attachment.source === "weixin" ? "weixin" : "portal") : null;
      const type = typeof attachment.type === "string" && (attachment.type === "image" || attachment.type === "document") ? attachment.type : null;
      if (!attachmentId || !relativePath || !mimeType || !fileName || sizeBytes === null || !source || !type) {
        summary.unattributable += 1;
        continue;
      }
      if (existingIds.has(attachmentId)) {
        summary.alreadyIndexed += 1;
        continue;
      }
      const storedAt = row.createdAt || now.toISOString();
      const expiresAt = new Date(new Date(storedAt).getTime() + TRANSIENT_MS).toISOString();
      const pastWindow = new Date(expiresAt).getTime() <= nowMs;
      if (input.dryRun) {
        if (pastWindow) summary.cleanupCandidates += 1;
        else summary.registered += 1;
        existingIds.add(attachmentId);
        continue;
      }
      try {
        sqlite
          .prepare(
            `INSERT INTO conversation_attachments (
               attachment_id, user_id, instance_id, conversation_id, message_id,
               source, kind, mime_type, file_name, relative_path, size_bytes,
               checksum, retention_class, stored_at, expires_at, delete_reason, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'transient_upload', ?, ?, ?, ?)
             ON CONFLICT(attachment_id) DO NOTHING`
          )
          .run(
            attachmentId,
            row.userId,
            row.instanceId,
            row.conversationId,
            row.messageId,
            source,
            type,
            mimeType,
            fileName,
            relativePath,
            sizeBytes,
            storedAt,
            expiresAt,
            pastWindow ? "cleanup_candidate" : null,
            storedAt,
          );
        existingIds.add(attachmentId);
        if (pastWindow) summary.cleanupCandidates += 1;
        else summary.registered += 1;
        recordFileLifecycleEvent({
          entityType: "attachment",
          entityId: attachmentId,
          userId: row.userId,
          instanceId: row.instanceId,
          event: "attachment.backfill.indexed",
          status: pastWindow ? "pending" : "success",
          reason: pastWindow ? "cleanup_candidate" : undefined,
          summary: { expiresAt, sizeBytes },
        });
      } catch (error) {
        summary.errors += 1;
        logger.warn(`attachment backfill failed attachmentId=${attachmentId}: ${(error as Error).message}`);
      }
    }
  }
  return summary;
}

function listProductionScopes(): Array<{ userId: string; instanceId: string }> {
  // Union of (a) conversation_messages scopes and (b) any user that already
  // owns artifacts. We intentionally do NOT walk the workspace filesystem
  // blindly — backfill only runs for users the Runtime already knows about.
  const rows = sqlite
    .prepare(
      `SELECT DISTINCT user_id AS userId, instance_id AS instanceId FROM (
         SELECT user_id, instance_id FROM conversation_messages
         UNION SELECT user_id, instance_id FROM conversation_artifacts
         UNION SELECT user_id, instance_id FROM conversation_sessions
       )
       WHERE user_id IS NOT NULL AND instance_id IS NOT NULL`
    )
    .all() as Array<{ userId: string; instanceId: string }>;
  return rows;
}

async function listFilesRecursive(dirPath: string, rootPath: string): Promise<string[]> {
  const collected: string[] = [];
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return collected;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collected.push(...await listFilesRecursive(full, rootPath));
      continue;
    }
    if (!entry.isFile()) continue;
    collected.push(full);
  }
  return collected;
}

function isCuratedLibraryPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, "");
  for (const dir of CURATED_LIBRARY_DIRECTORIES) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) {
      const segments = normalized.split("/");
      if (segments.some((segment) => segment.startsWith("."))) return false;
      const fileName = segments[segments.length - 1];
      if (fileName.startsWith(".#")) return false;
      const lower = fileName.toLowerCase();
      if (["~", ".tmp", ".temp", ".bak", ".swp"].some((suffix) => lower.endsWith(suffix))) return false;
      return true;
    }
  }
  return false;
}

// Re-export the types the connector / CLI may want to share.
export type { ArtifactOrigin, ArtifactRetentionClass, ArtifactVisibility };
