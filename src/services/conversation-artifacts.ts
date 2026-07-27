import { createHash, randomBytes } from "node:crypto";
import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { scanForUnsafeContent } from "./svg-sanitizer.js";
import { recordArtifactEvent, recordArtifactLibraryListEvent } from "./artifact-events.js";
import { withArtifactPathLock } from "./artifact-path-lock.js";
import { getCurrentTurnId } from "./conversation-turns.js";
import { recordFileLifecycleEvent } from "./file-lifecycle-audit.js";

export const ARTIFACT_PREVIEWABLE_MIME_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "text/csv",
] as const;

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

const MIME_PREVIEW_MODE: Record<string, ConversationArtifact["previewMode"]> = {
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

const KIND_BY_MIME: Record<string, ConversationArtifact["kind"]> = {
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

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "text/csv",
  "image/svg+xml",
]);

const MAX_PUBLISH_BYTES = 15 * 1024 * 1024;
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
// HTML renders inside a sandboxed Portal iframe, so it gets a much tighter
// cap than binary media: it is meant for static document previews, not for
// shipping large applications or embedded datasets.
const MAX_HTML_BYTES = 1 * 1024 * 1024;
const REPORT_ROOT = "reports";

/**
 * Boundary for the durable library. A file at most this many bytes can be
 * promoted to `retention_class = durable_library` (kept forever until the user
 * deletes it). Anything larger is admitted only as `transient_generated` with
 * a 7-day TTL. The threshold is a hard service-layer rule — never let the
 * model decide "this one is important enough to keep". See
 * `docs/portal-file-retention-and-library-governance-work-package.md` §3.2.
 */
export const DURABLE_LIBRARY_MAX_BYTES = 1 * 1024 * 1024; // 1,048,576

/**
 * TTL applied to transient AI-generated artifacts (oversized or non-curated).
 * Same 7-day window as user uploads; re-reading does not extend it.
 */
export const TRANSIENT_ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Curated library directories that backfill scans for existing workspace
 * reports. Anything outside this set is never auto-promoted to the durable
 * library, even if it appears under `reports/`. See work package §4.1.
 */
export const CURATED_LIBRARY_DIRECTORIES = [
  "reports/daily",
  "reports/weekly",
  "reports/monthly",
  "reports/company",
  "reports/html",
  "reports/metrics",
  "reports/memory",
] as const;

/**
 * MIME types admissible to the durable library. The Portal viewer only renders
 * Markdown/HTML inline; image/PDF/text/json/csv are listed here so the file
 * tree can show them with download/Lightbox affordances.
 */
export const DURABLE_LIBRARY_MIME_TYPES = new Set([
  "text/markdown",
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/json",
  "text/csv",
]);

/** MIME types that the Portal file tree shows but only offers download for. */
const DOWNLOAD_ONLY_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "application/json",
  "text/csv",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export type ArtifactRetentionClass = "durable_library" | "transient_generated" | "reference_only" | "trashed";
export type ArtifactVisibility = "library" | "conversation_only" | "hidden";
export type ArtifactOrigin = "assistant" | "system" | "workspace_backfill" | "legacy";

export interface ArtifactRetentionClassification {
  origin: ArtifactOrigin;
  retentionClass: ArtifactRetentionClass;
  visibility: ArtifactVisibility;
  expiresAt: string | null;
}

/**
 * Determines retention for a freshly published artifact from deterministic
 * service-layer signals only: source, relative path, size, MIME and the
 * curated directory list. Never asks the model. Returns `null` when the row
 * should keep its pre-migration behaviour (e.g. legacy_path records).
 */
export function classifyArtifactRetention(input: {
  source: ConversationArtifactScope["source"];
  relativePath: string;
  sizeBytes: number;
  mimeType: string;
  now?: Date;
}): ArtifactRetentionClassification | null {
  const now = input.now ?? new Date();
  if (input.source === "legacy_path") {
    return {
      origin: "legacy",
      retentionClass: "reference_only",
      visibility: "conversation_only",
      expiresAt: null,
    };
  }
  const origin: ArtifactOrigin = input.source === "reviews.save" || input.source === "artifacts.publish" ? "assistant" : "system";
  const withinCuratedDir = isWithinCuratedLibraryDirectory(input.relativePath);
  const mimeAllowed = DURABLE_LIBRARY_MIME_TYPES.has(input.mimeType);
  const withinDurableSize = input.sizeBytes <= DURABLE_LIBRARY_MAX_BYTES;
  if (withinCuratedDir && mimeAllowed && withinDurableSize) {
    return {
      origin,
      retentionClass: "durable_library",
      visibility: "library",
      expiresAt: null,
    };
  }
  // Oversized or non-curated formal artifacts fall through to transient: the
  // file stays readable in the original conversation for 7 days but never
  // enters the permanent file tree.
  const expiresAt = new Date(now.getTime() + TRANSIENT_ARTIFACT_RETENTION_MS).toISOString();
  return {
    origin,
    retentionClass: "transient_generated",
    visibility: "conversation_only",
    expiresAt,
  };
}

function isWithinCuratedLibraryDirectory(relativePath: string): boolean {
  const normalized = relativePath.replace(/^\/+/, "");
  for (const dir of CURATED_LIBRARY_DIRECTORIES) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) return true;
  }
  return false;
}

export interface ConversationArtifact {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "report" | "chart" | "data" | "document";
  previewMode: "markdown" | "html" | "image" | "pdf" | "text" | "table" | "unsupported";
  createdAt: string;
  checksum?: string;
}

export interface ConversationArtifactRecord extends ConversationArtifact {
  userId: string;
  instanceId: string;
  relativePath: string;
  scope: ConversationArtifactScope;
  turnId?: string | null;
  origin?: ArtifactOrigin | null;
  retentionClass?: ArtifactRetentionClass | null;
  visibility?: ArtifactVisibility | null;
  expiresAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deleteReason?: string | null;
  trashRelativePath?: string | null;
  purgeAt?: string | null;
}

export interface ConversationArtifactScope {
  projectId: string;
  assistantId: string;
  conversationId?: string | null;
  messageId?: string | null;
  source: "reviews.save" | "artifacts.publish" | "legacy_path" | "workspace_backfill";
}

export class ConversationArtifactError extends Error {
  constructor(
    public readonly code:
      | "ARTIFACT_INVALID_PATH"
      | "ARTIFACT_NOT_FOUND"
      | "ARTIFACT_UNSUPPORTED"
      | "ARTIFACT_TOO_LARGE"
      | "ARTIFACT_UNSAFE"
      | "ARTIFACT_SCOPE_MISMATCH"
      | "ARTIFACT_INVALID_CURSOR"
      | "ARTIFACT_EXPIRED"
      | "ARTIFACT_DELETED"
      | "ARTIFACT_NOT_DELETABLE"
      | "ARTIFACT_DELETE_CONFIRMATION_REQUIRED"
      | "ARTIFACT_DELETE_CONFIRMATION_EXPIRED"
      | "ARTIFACT_DELETE_CONFLICT",
    message: string,
  ) {
    super(`${code}:${message}`);
    this.name = "ConversationArtifactError";
  }
}

export interface PublishArtifactInput {
  userId: string;
  instanceId: string;
  relativePath: string;
  kind?: ConversationArtifact["kind"];
  title?: string;
  scope: Omit<ConversationArtifactScope, "source"> & { source?: ConversationArtifactScope["source"] };
}

/**
 * Shared SELECT column list so the publish/read/list/turn-binding queries all
 * agree on the retention lifecycle fields. Aliases match
 * `ConversationArtifactRecord`. Exported so the deletion service can reuse
 * the exact same projection.
 */
export const ARTIFACT_SELECT_COLUMNS = [
  "artifact_id AS artifactId",
  "user_id AS userId",
  "instance_id AS instanceId",
  "project_id AS projectId",
  "assistant_id AS assistantId",
  "conversation_id AS conversationId",
  "message_id AS messageId",
  "turn_id AS turnId",
  "source",
  "kind",
  "preview_mode AS previewMode",
  "title",
  "file_name AS fileName",
  "mime_type AS mimeType",
  "relative_path AS relativePath",
  "size_bytes AS sizeBytes",
  "checksum",
  "created_at AS createdAt",
  "origin",
  "retention_class AS retentionClass",
  "visibility",
  "expires_at AS expiresAt",
  "deleted_at AS deletedAt",
  "deleted_by AS deletedBy",
  "delete_reason AS deleteReason",
  "trash_relative_path AS trashRelativePath",
  "purge_at AS purgeAt",
].join(",\n           ");

/**
 * Registers a workspace file as a first-class artifact. The file must already
 * live under the user's `reports/` directory; this function never accepts
 * absolute paths and does not write to the workspace.
 */
export async function publishConversationArtifact(input: PublishArtifactInput): Promise<ConversationArtifactRecord> {
  const relativePath = normalizeReportPath(input.relativePath);
  const workspacePath = resolveWorkspacePath(input.userId);
  const reportsPath = path.join(workspacePath, REPORT_ROOT);
  const targetPath = path.resolve(workspacePath, relativePath);

  let realReportsPath: string;
  let realTargetPath: string;
  try {
    [realReportsPath, realTargetPath] = await Promise.all([realpath(reportsPath), realpath(targetPath)]);
  } catch {
    throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", relativePath);
  }
  if (!isWithin(realReportsPath, realTargetPath)) {
    throw new ConversationArtifactError("ARTIFACT_INVALID_PATH", relativePath);
  }

  const extension = path.extname(realTargetPath).toLowerCase();
  const inferredMime = EXT_MIME_MAP[extension];
  if (!inferredMime) {
    throw new ConversationArtifactError("ARTIFACT_UNSUPPORTED", extension || "no extension");
  }

  const fileStat = await stat(realTargetPath);
  if (!fileStat.isFile()) {
    throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", relativePath);
  }
  const maxPublishBytes = inferredMime === "text/html" ? MAX_HTML_BYTES : MAX_PUBLISH_BYTES;
  if (fileStat.size > maxPublishBytes) {
    throw new ConversationArtifactError("ARTIFACT_TOO_LARGE", String(fileStat.size));
  }

  const raw = await readFile(realTargetPath);
  const checksum = sha256Hex(raw);
  const { mimeType, sanitizedBase64 } = await prepareArtifactPayload(inferredMime, raw);
  const sizeBytes = sanitizedBase64 ? Buffer.from(sanitizedBase64, "base64").length : raw.length;
  if (sizeBytes > maxPublishBytes) {
    throw new ConversationArtifactError("ARTIFACT_TOO_LARGE", String(sizeBytes));
  }

  const artifactId = await nextArtifactId();
  const now = new Date().toISOString();
  const fileName = path.basename(realTargetPath);
  const kind = input.kind ?? KIND_BY_MIME[mimeType] ?? "document";
  const previewMode = MIME_PREVIEW_MODE[mimeType] ?? "unsupported";
  const title = (input.title ?? fileName).trim().slice(0, 200) || fileName;
  const scopeConversationId = input.scope.conversationId ?? null;
  // Look up the active turnId at publish time. The MCP service-tools server
  // runs in a different process from the conversation-log service, so we
  // read the marker from SQLite. When this publish fires inside an ACP turn
  // (the normal case), this returns the user-message requestId that
  // `chatViaConversationLog` recorded via `markTurnStart`. When fired
  // outside of a turn (e.g. a legacy path publish from the Portal), it
  // returns null and the artifact stays unbound to any specific message
  // until the next turn — which is the safe default.
  const turnId = scopeConversationId
    ? getCurrentTurnId({
        userId: input.userId,
        instanceId: input.instanceId,
        conversationId: scopeConversationId,
      })
    : null;
  const scope: ConversationArtifactScope = {
    projectId: input.scope.projectId,
    assistantId: input.scope.assistantId,
    conversationId: scopeConversationId,
    messageId: input.scope.messageId ?? null,
    source: input.scope.source ?? "artifacts.publish",
  };

  // Compute retention once at write time. The library list and the read path
  // consult these columns directly rather than re-inferring from source/size
  // on every call, so backfill only has to populate the columns once.
  const classification = classifyArtifactRetention({
    source: scope.source,
    relativePath: normalizeReportPath(relativePath),
    sizeBytes,
    mimeType,
  });

  const record: ConversationArtifactRecord = {
    artifactId,
    title,
    fileName,
    mimeType,
    sizeBytes,
    kind,
    previewMode,
    createdAt: now,
    checksum,
    userId: input.userId,
    instanceId: input.instanceId,
    relativePath: normalizeReportPath(relativePath),
    scope,
    turnId,
    origin: classification?.origin ?? null,
    retentionClass: classification?.retentionClass ?? null,
    visibility: classification?.visibility ?? null,
    expiresAt: classification?.expiresAt ?? null,
  };

  sqlite
    .prepare(
      `INSERT INTO conversation_artifacts (
         artifact_id, user_id, instance_id, project_id, assistant_id,
         conversation_id, message_id, turn_id, source, kind, preview_mode,
         title, file_name, mime_type, relative_path, size_bytes, checksum,
         created_at, updated_at,
         origin, retention_class, visibility, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         title = excluded.title,
         file_name = excluded.file_name,
         mime_type = excluded.mime_type,
         relative_path = excluded.relative_path,
         size_bytes = excluded.size_bytes,
         checksum = excluded.checksum,
         turn_id = COALESCE(excluded.turn_id, conversation_artifacts.turn_id),
         origin = COALESCE(excluded.origin, conversation_artifacts.origin),
         retention_class = COALESCE(excluded.retention_class, conversation_artifacts.retention_class),
         visibility = COALESCE(excluded.visibility, conversation_artifacts.visibility),
         expires_at = COALESCE(excluded.expires_at, conversation_artifacts.expires_at)`
    )
    .run(
      artifactId,
      input.userId,
      input.instanceId,
      scope.projectId,
      scope.assistantId,
      scope.conversationId ?? null,
      scope.messageId ?? null,
      turnId,
      scope.source,
      kind,
      previewMode,
      title,
      fileName,
      mimeType,
      record.relativePath,
      sizeBytes,
      checksum,
      now,
      now,
      classification?.origin ?? null,
      classification?.retentionClass ?? null,
      classification?.visibility ?? null,
      classification?.expiresAt ?? null,
    );

  if (classification) {
    recordFileLifecycleEvent({
      entityType: "artifact",
      entityId: artifactId,
      userId: input.userId,
      instanceId: input.instanceId,
      event: "artifact.classified",
      status: "success",
      summary: {
        source: scope.source,
        retentionClass: classification.retentionClass,
        visibility: classification.visibility,
        sizeBytes,
        expiresAt: classification.expiresAt,
      },
    });
  }

  return record;
}

export interface ReadArtifactPayload {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
  checksum?: string;
  sanitized: boolean;
}

/**
 * Looks up an artifact by id under the caller's user/instance scope, reads the
 * underlying workspace file with symlink/path-escape protection, and returns a
 * base64 payload. SVG content is always returned sanitized so it is safe for
 * inline Portal rendering; the caller is still expected to isolate the preview
 * surface (sandbox iframe).
 */
export async function readConversationArtifactPayload(input: {
  artifactId: string;
  userId: string;
  instanceId?: string;
}): Promise<{ descriptor: ConversationArtifactRecord; payload: ReadArtifactPayload }> {
  const initialRecord = requireRecord(
    sqlite
      .prepare(
        `SELECT ${ARTIFACT_SELECT_COLUMNS}
         FROM conversation_artifacts
         WHERE artifact_id = ?`
      )
      .get(input.artifactId) as ConversationArtifactRecord | undefined,
  );
  if (initialRecord.userId !== input.userId) {
    throw new ConversationArtifactError("ARTIFACT_SCOPE_MISMATCH", input.artifactId);
  }
  if (input.instanceId && initialRecord.instanceId !== input.instanceId) {
    throw new ConversationArtifactError("ARTIFACT_SCOPE_MISMATCH", input.artifactId);
  }
  return withArtifactPathLock(initialRecord.userId, initialRecord.relativePath, async () => {
    // Re-read after acquiring the lock so a delete that won the race cannot
    // leave this read using stale lifecycle fields.
    const record = requireRecord(
      sqlite
        .prepare(`SELECT ${ARTIFACT_SELECT_COLUMNS} FROM conversation_artifacts WHERE artifact_id = ?`)
        .get(input.artifactId) as ConversationArtifactRecord | undefined,
    );
    if (record.deletedAt) throw new ConversationArtifactError("ARTIFACT_DELETED", input.artifactId);
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new ConversationArtifactError("ARTIFACT_EXPIRED", input.artifactId);
    }

    const workspacePath = resolveWorkspacePath(record.userId);
    const reportsPath = path.join(workspacePath, REPORT_ROOT);
    const targetPath = path.resolve(workspacePath, record.relativePath);
    let realReportsPath: string;
    let realTargetPath: string;
    try {
      [realReportsPath, realTargetPath] = await Promise.all([realpath(reportsPath), realpath(targetPath)]);
    } catch {
      throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", record.relativePath);
    }
    if (!isWithin(realReportsPath, realTargetPath)) {
      throw new ConversationArtifactError("ARTIFACT_INVALID_PATH", record.relativePath);
    }
    const fileStat = await stat(realTargetPath);
    if (!fileStat.isFile()) throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", record.relativePath);
    const maxInlineBytes = record.mimeType === "text/html" ? MAX_HTML_BYTES : MAX_INLINE_BYTES;
    if (fileStat.size > maxInlineBytes) {
      throw new ConversationArtifactError("ARTIFACT_TOO_LARGE", String(fileStat.size));
    }
    const raw = await readFile(realTargetPath);
    if (record.checksum && sha256Hex(raw) !== record.checksum) {
      throw new ConversationArtifactError("ARTIFACT_UNSAFE", "checksum mismatch");
    }
    const { mimeType, sanitizedBase64, sanitized } = await prepareArtifactPayload(record.mimeType, raw);
    const bytes = sanitizedBase64 ? Buffer.from(sanitizedBase64, "base64") : raw;
    return {
      descriptor: record,
      payload: {
        fileName: record.fileName,
        mimeType,
        sizeBytes: bytes.length,
        base64: bytes.toString("base64"),
        checksum: record.checksum ?? undefined,
        sanitized,
      },
    };
  });
}

/**
 * Resolves a legacy `/home/claude/.../reports/...` or relative `reports/...`
 * path to a stable descriptor for the current scope. The relative path is
 * validated but not registered for cross-scope reuse; only the current caller's
 * scope can re-open the same legacy URL within the same session.
 */
export async function publishLegacyPathArtifact(input: {
  userId: string;
  instanceId: string;
  projectId: string;
  assistantId: string;
  conversationId?: string | null;
  relativePath: string;
}): Promise<ConversationArtifactRecord> {
  return publishConversationArtifact({
    userId: input.userId,
    instanceId: input.instanceId,
    relativePath: input.relativePath,
    scope: {
      projectId: input.projectId,
      assistantId: input.assistantId,
      conversationId: input.conversationId ?? null,
      source: "legacy_path",
    },
  });
}

export function findArtifactsForMessage(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
  messageId: string;
}): ConversationArtifactRecord[] {
  const rows = sqlite
    .prepare(
      `SELECT ${ARTIFACT_SELECT_COLUMNS}
       FROM conversation_artifacts
       WHERE user_id = ? AND instance_id = ? AND conversation_id = ? AND message_id = ?
       ORDER BY created_at ASC, artifact_id ASC`
    )
    .all(input.userId, input.instanceId, input.conversationId, input.messageId) as ConversationArtifactRecord[];
  return rows;
}

/**
 * Finds artifacts bound to a specific turn. Used by the conversation-log
 * service to attach artifacts deterministically to the assistant reply
 * that owns the turn. Selection is keyed on the explicit `turn_id` rather
 * than `message_id IS NULL` so concurrent or interleaved turns cannot
 * cross-attach.
 */
export function findArtifactsForTurn(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
  turnId: string;
}): ConversationArtifactRecord[] {
  const rows = sqlite
    .prepare(
      `SELECT ${ARTIFACT_SELECT_COLUMNS}
       FROM conversation_artifacts
       WHERE user_id = ? AND instance_id = ? AND conversation_id = ? AND turn_id = ?
       ORDER BY created_at ASC, artifact_id ASC`
    )
    .all(input.userId, input.instanceId, input.conversationId, input.turnId) as ConversationArtifactRecord[];
  return rows;
}

export interface ArtifactLibraryItem {
  artifactId: string;
  title: string;
  fileName: string;
  /** Safe display path under `reports/`, without the `reports/` prefix. */
  displayPath: string;
  directorySegments: string[];
  mimeType: string;
  previewMode: "markdown" | "html" | "image" | "pdf" | "text" | "table";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  checksum?: string;
  /**
   * Curated category derived from the curated directory the file lives in.
   * Lets the Portal file tree group items without re-deriving the mapping.
   * `other` covers formal `artifacts.publish` files outside the fixed dirs.
   */
  category: ArtifactLibraryCategory;
  /** True when the Portal should show a download affordance instead of a preview. */
  downloadable: boolean;
  /**
   * Routing hint for the Portal: `document` opens a tab, `image` opens the
   * Lightbox, `download` is download-only.
   */
  openRoute: "document" | "image" | "download";
}

export type ArtifactLibraryCategory =
  | "daily"
  | "weekly"
  | "monthly"
  | "company"
  | "html"
  | "metrics"
  | "memory"
  | "other";

export interface ArtifactLibraryListResult {
  items: ArtifactLibraryItem[];
  nextCursor?: string;
}

const LIBRARY_DEFAULT_LIMIT = 200;
const LIBRARY_MAX_LIMIT = 500;
const LIBRARY_TEMP_BACKUP_SUFFIXES = ["~", ".tmp", ".temp", ".bak", ".swp"];
const LIBRARY_PREVIEW_MODES = new Set(["markdown", "html", "image", "pdf", "text", "table"]);

interface LibraryRow {
  artifactId: string;
  source: string;
  previewMode: string;
  title: string;
  fileName: string;
  mimeType: string;
  relativePath: string;
  sizeBytes: number;
  checksum: string | null;
  createdAt: string;
  updatedAt: string;
  origin: string | null;
  retentionClass: string | null;
  visibility: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
}

interface LibraryCursor {
  u: string;
  a: string;
}

/**
 * Lists the curated, read-only artifact library for one user + instance. The
 * library is a virtual document tree built from the authoritative artifact
 * index — it is NOT a workspace directory listing. A record qualifies only
 * when ALL of the following hold:
 *
 * 1. Exact `user_id + instance_id` match (scope is injected by the caller).
 * 2. `source` is `artifacts.publish`, `reviews.save`, or `workspace_backfill`
 *    (never `legacy_path`).
 * 3. After backfill: `visibility='library'` AND `retention_class='durable_library'`
 *    AND `deleted_at IS NULL`. Pre-backfill rows (NULL columns) are still
 *    admitted under the legacy rules so the rollout window does not blank the
 *    tree.
 * 4. `preview_mode` is one of markdown/html/image/pdf/text/table. Markdown/HTML
 *    open as document tabs; images open in the Lightbox; the rest are
 *    download-only.
 * 5. `relative_path` passes the same `normalizeReportPath` validation as
 *    publish/read and round-trips unchanged, and lives under one of the
 *    curated directories (or is a formal `artifacts.publish` outside them).
 * 6. No path segment starts with `.`, and the file name does not match the
 *    fixed temp/backup patterns (`.#` prefix; `~`/`.tmp`/`.temp`/`.bak`/`.swp`
 *    suffix, case-insensitive).
 * 7. The file still exists, is a regular file, stays within the real reports
 *    root after `realpath` (no symlink escape), and is within the durable size
 *    cap (1 MiB) — oversize files are not promoted to the library.
 *
 * When one `relative_path` has several publish records, versions are walked
 * newest-first and the first version passing every rule wins. Tombstoned
 * (deleted) versions never win, and a path whose versions are all deleted is
 * omitted entirely.
 *
 * Pagination is keyset-based on `(updated_at DESC, artifact_id DESC)` with an
 * opaque base64url(JSON) cursor. `limit` defaults to 200 and is clamped to
 * [1, 500]. An undecodable or malformed cursor throws
 * `ARTIFACT_INVALID_CURSOR`. The list never reads file contents — it returns
 * whitelisted descriptors only (no absolute paths, userId, instanceId,
 * conversationId, projectId, scope or source). Each call records one
 * aggregate `library.list` audit event, never one event per item.
 */
export async function listCuratedArtifactLibrary(input: {
  userId: string;
  instanceId: string;
  cursor?: string;
  limit?: number;
}): Promise<ArtifactLibraryListResult> {
  const cursor = input.cursor && input.cursor.trim() ? decodeLibraryCursor(input.cursor.trim()) : undefined;
  const limit = normalizeLibraryLimit(input.limit);

  const workspacePath = resolveWorkspacePath(input.userId);
  const reportsPath = path.join(workspacePath, REPORT_ROOT);
  let realReportsPath: string;
  try {
    realReportsPath = await realpath(reportsPath);
  } catch {
    recordArtifactLibraryListEvent({
      userId: input.userId,
      instanceId: input.instanceId,
      itemCount: 0,
      limit,
      hasCursor: Boolean(cursor),
      hasNextCursor: false,
    });
    return { items: [] };
  }

  const rows = sqlite
    .prepare(
      `SELECT
         artifact_id AS artifactId,
         source,
         preview_mode AS previewMode,
         title,
         file_name AS fileName,
         mime_type AS mimeType,
         relative_path AS relativePath,
         size_bytes AS sizeBytes,
         checksum,
         created_at AS createdAt,
         updated_at AS updatedAt,
         origin,
         retention_class AS retentionClass,
         visibility,
         expires_at AS expiresAt,
         deleted_at AS deletedAt
       FROM conversation_artifacts
       WHERE user_id = ? AND instance_id = ?
       ORDER BY updated_at DESC, artifact_id DESC`
    )
    .all(input.userId, input.instanceId) as LibraryRow[];

  // Rows arrive newest-first, so grouping in iteration order keeps each
  // path's versions sorted newest -> oldest for the fallback walk below.
  const versionsByPath = new Map<string, LibraryRow[]>();
  for (const row of rows) {
    const versions = versionsByPath.get(row.relativePath);
    if (versions) versions.push(row);
    else versionsByPath.set(row.relativePath, [row]);
  }

  const curated: ArtifactLibraryItem[] = [];
  for (const versions of versionsByPath.values()) {
    for (const version of versions) {
      if (version.deletedAt) continue;
      if (version.expiresAt && new Date(version.expiresAt).getTime() <= Date.now()) continue;
      if (version.source !== "artifacts.publish" && version.source !== "reviews.save" && version.source !== "workspace_backfill") continue;
      // Retention gate. After backfill every durable library row is tagged
      // `visibility='library' AND retention_class='durable_library'`. While
      // backfill is still running, NULL columns are admitted so the tree does
      // not go dark; once tagged, a row must carry the durable library tag to
      // remain visible.
      if (version.retentionClass !== null && version.retentionClass !== "durable_library") continue;
      if (version.visibility !== null && version.visibility !== "library") continue;
      if (!LIBRARY_PREVIEW_MODES.has(version.previewMode)) continue;
      if (!isCuratedLibraryPath(version.relativePath)) continue;
      if (!(await isLibraryFileValid(realReportsPath, workspacePath, version.relativePath, version.mimeType))) continue;
      curated.push(toLibraryItem(version));
      break;
    }
  }

  curated.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    if (a.artifactId !== b.artifactId) return a.artifactId < b.artifactId ? 1 : -1;
    return 0;
  });

  const afterCursor = cursor
    ? curated.filter(
        (item) => item.updatedAt < cursor.u || (item.updatedAt === cursor.u && item.artifactId < cursor.a),
      )
    : curated;
  const items = afterCursor.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    afterCursor.length > items.length && last
      ? encodeLibraryCursor({ u: last.updatedAt, a: last.artifactId })
      : undefined;

  recordArtifactLibraryListEvent({
    userId: input.userId,
    instanceId: input.instanceId,
    itemCount: items.length,
    limit,
    hasCursor: Boolean(cursor),
    hasNextCursor: Boolean(nextCursor),
  });

  return nextCursor ? { items, nextCursor } : { items };
}

function toLibraryItem(row: LibraryRow): ArtifactLibraryItem {
  const displayPath = row.relativePath.slice(REPORT_ROOT.length + 1);
  const category = categoryForPath(row.relativePath);
  const downloadable = DOWNLOAD_ONLY_MIME_TYPES.has(row.mimeType);
  const openRoute: ArtifactLibraryItem["openRoute"] = IMAGE_MIME_TYPES.has(row.mimeType)
    ? "image"
    : downloadable
      ? "download"
      : "document";
  return {
    artifactId: row.artifactId,
    title: row.title,
    fileName: row.fileName,
    displayPath,
    directorySegments: displayPath.split("/").slice(0, -1),
    mimeType: row.mimeType,
    previewMode: row.previewMode as ArtifactLibraryItem["previewMode"],
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    checksum: row.checksum ?? undefined,
    category,
    downloadable,
    openRoute,
  };
}

function categoryForPath(relativePath: string): ArtifactLibraryCategory {
  const normalized = relativePath.replace(/^\/+/, "");
  for (const dir of CURATED_LIBRARY_DIRECTORIES) {
    if (normalized === dir || normalized.startsWith(`${dir}/`)) {
      const segment = dir.split("/")[1] as ArtifactLibraryCategory;
      return segment;
    }
  }
  return "other";
}

function isCuratedLibraryPath(relativePath: string): boolean {
  let normalized: string;
  try {
    normalized = normalizeReportPath(relativePath);
  } catch {
    return false;
  }
  if (normalized !== relativePath) return false;
  const segments = normalized.split("/").slice(1); // drop the "reports" root
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment.startsWith(".")) return false;
  }
  const fileName = segments[segments.length - 1];
  if (fileName.startsWith(".#")) return false;
  const lowerFileName = fileName.toLowerCase();
  if (LIBRARY_TEMP_BACKUP_SUFFIXES.some((suffix) => lowerFileName.endsWith(suffix))) return false;
  return true;
}

async function isLibraryFileValid(
  realReportsPath: string,
  workspacePath: string,
  relativePath: string,
  mimeType: string,
): Promise<boolean> {
  const targetPath = path.resolve(workspacePath, relativePath);
  let realTargetPath: string;
  try {
    realTargetPath = await realpath(targetPath);
  } catch {
    return false;
  }
  if (!isWithin(realReportsPath, realTargetPath)) return false;
  try {
    const fileStat = await stat(realTargetPath);
    if (!fileStat.isFile()) return false;
    // HTML still has its own tighter preview cap; everything else in the
    // library is bounded by the durable 1 MiB threshold so the file tree only
    // shows files the retention layer would actually promote.
    const maxBytes = mimeType === "text/html" ? MAX_HTML_BYTES : DURABLE_LIBRARY_MAX_BYTES;
    if (fileStat.size > maxBytes) return false;
  } catch {
    return false;
  }
  return true;
}

function normalizeLibraryLimit(value: unknown): number {
  if (value === undefined || value === null) return LIBRARY_DEFAULT_LIMIT;
  const num = Number(value);
  if (!Number.isFinite(num)) return LIBRARY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(num), 1), LIBRARY_MAX_LIMIT);
}

function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLibraryCursor(raw: string): LibraryCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ConversationArtifactError("ARTIFACT_INVALID_CURSOR", "cursor is not decodable");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as LibraryCursor).u !== "string" ||
    typeof (parsed as LibraryCursor).a !== "string"
  ) {
    throw new ConversationArtifactError("ARTIFACT_INVALID_CURSOR", "cursor has an unexpected shape");
  }
  return parsed as LibraryCursor;
}

/**
 * Test-only helper that mirrors what `conversation-log.ts` does when an
 * assistant message lands: stamp the artifacts that belong to a given
 * turn with the assistant message id. Exposed so the artifact module can
 * be tested in isolation without depending on the ACP message pipeline.
 */
export function bindArtifactsToAssistantMessageForTest(input: {
  userId: string;
  instanceId: string;
  conversationId: string;
  assistantMessageId: string;
  turnId: string;
}): { attached: number } {
  const pending = findArtifactsForTurn({
    userId: input.userId,
    instanceId: input.instanceId,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });
  if (pending.length === 0) return { attached: 0 };
  const now = new Date().toISOString();
  const update = sqlite.prepare(
    `UPDATE conversation_artifacts
     SET message_id = ?, updated_at = ?
     WHERE artifact_id = ? AND turn_id = ?`,
  );
  let attached = 0;
  for (const row of pending) {
    const result = update.run(input.assistantMessageId, now, row.artifactId, input.turnId);
    attached += result.changes;
  }
  return { attached };
}

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
 */
export function logArtifactEvent(input: ArtifactEventInput): void {
  recordArtifactEvent(input);
}

function requireRecord(row: ConversationArtifactRecord | undefined): ConversationArtifactRecord {
  if (!row) throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", "artifact not registered");
  return row;
}

function normalizeReportPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || !normalized.startsWith(`${REPORT_ROOT}/`)) {
    throw new ConversationArtifactError("ARTIFACT_INVALID_PATH", value || "empty");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ConversationArtifactError("ARTIFACT_INVALID_PATH", value);
  }
  return normalized;
}

function isWithin(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function nextArtifactId(): Promise<string> {
  const id = randomBytes(18).toString("base64url");
  return `art_${id}`;
}

async function prepareArtifactPayload(declaredMime: string, raw: Buffer): Promise<{
  mimeType: string;
  sanitizedBase64?: string;
  sanitized: boolean;
}> {
  // Reject extension/MIME masquerading. The declared MIME comes from the file
  // extension on publish; on read it comes from the artifact record. We always
  // re-validate the actual bytes against the declared MIME so a `.png` that
  // contains HTML cannot leak through as an inline image.
  validateContentMatchesMime(declaredMime, raw);

  if (declaredMime === "image/svg+xml") {
    const text = raw.toString("utf8");
    const scanResult = scanForUnsafeContent(text);
    if (!scanResult.safe) {
      throw new ConversationArtifactError("ARTIFACT_UNSAFE", scanResult.reason || "svg contains unsafe content");
    }
    // Once the conservative scan has accepted the payload, the bytes are
    // returned untouched. Trimming, attribute re-writing or any other
    // mutation would break the workspace checksum contract that
    // `payload.checksum === record.checksum` relies on. The Portal viewer
    // still isolates SVG renders inside a sandbox iframe / blob image so
    // the safety boundary is preserved.
    return { mimeType: "image/svg+xml", sanitized: false };
  }
  return { mimeType: declaredMime, sanitized: false };
}

/**
 * Cross-checks the declared MIME against the actual bytes. Rejects files whose
 * extension claims one format but whose bytes match another (e.g. an `.svg`
 * that is actually a PNG, or a `.png` that starts with `<html>`).
 */
function validateContentMatchesMime(declaredMime: string, raw: Buffer): void {
  if (TEXT_MIME_TYPES.has(declaredMime)) {
    if (!isValidUtf8(raw)) {
      throw new ConversationArtifactError("ARTIFACT_UNSAFE", `${declaredMime} must be valid UTF-8 text`);
    }
    // Reject text that begins with a binary file signature even though it
    // decodes as UTF-8 (e.g. a base64 PNG body smuggled into a .md file is
    // fine, but a leading `%PDF-` or `<svg` payload in a `.csv` is suspicious
    // when it would be interpreted as text by the viewer).
    const textStart = raw.toString("utf8", 0, Math.min(raw.length, 16)).trim().toLowerCase();
    if (declaredMime !== "image/svg+xml" && declaredMime !== "text/markdown" && declaredMime !== "text/plain") {
      // Application/json + csv: still allow leading alphanumerics, but block
      // obvious binary file headers that would confuse the browser.
      if (textStart.startsWith("%pdf") || textStart.startsWith("png")) {
        throw new ConversationArtifactError("ARTIFACT_UNSAFE", `${declaredMime} cannot contain binary file signature`);
      }
    }
    if (declaredMime === "image/svg+xml" && !raw.toString("utf8").trim().startsWith("<")) {
      throw new ConversationArtifactError("ARTIFACT_UNSAFE", "svg payload must be xml text");
    }
    return;
  }
  const signature = detectBinaryMime(raw);
  if (!signature) {
    throw new ConversationArtifactError("ARTIFACT_UNSAFE", `expected ${declaredMime} but found no recognised binary header`);
  }
  if (signature !== declaredMime) {
    throw new ConversationArtifactError(
      "ARTIFACT_UNSAFE",
      `declared ${declaredMime} but bytes match ${signature}`,
    );
  }
}

/** Returns the canonical MIME for known binary headers, or undefined. */
function detectBinaryMime(raw: Buffer): string | undefined {
  if (raw.length >= 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47 && raw[4] === 0x0d && raw[5] === 0x0a && raw[6] === 0x1a && raw[7] === 0x0a) {
    return "image/png";
  }
  if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return "image/jpeg";
  }
  if (raw.length >= 12 && raw.slice(0, 4).toString("ascii") === "RIFF" && raw.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (raw.length >= 4 && raw.slice(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  return undefined;
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    // Buffer.toString("utf8") is forgiving and replaces invalid sequences with
    // the replacement character. Detect that explicitly by comparing a
    // round-trip: encode the decoded text back to UTF-8 and require identity.
    const decoded = buf.toString("utf8");
    if (!decoded) return buf.length === 0;
    if (Buffer.from(decoded, "utf8").length !== buf.length) return false;
    // Reject strings containing NULs — text artifacts should never need them,
    // and a stray NUL is usually a sign of binary content mislabelled as text.
    if (decoded.includes("\0")) return false;
    return true;
  } catch {
    return false;
  }
}
