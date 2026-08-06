import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sqlite } from "../db/index.js";
import { config } from "../lib/config.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { withResourceMutationLock } from "./resource-mutation-lock.js";
import { validateAutomationSpreadsheet } from "./automation-spreadsheet.js";
import { recordFileLifecycleEvent } from "./file-lifecycle-audit.js";

export type AssetFormat = "markdown" | "html" | "csv" | "xlsx" | "pdf" | "png" | "jpeg" | "webp" | "svg";
export type UserAssetStatus = "active" | "archived";
export type UserAssetSource = "upload" | "conversation" | "automation" | "restore" | "system";
export type AssetScope = { userId: string; projectId: string; instanceId: string };

export type UserAssetVersionDescriptor = {
  versionId: string;
  assetId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  versionNumber: number;
  fileName: string;
  format: AssetFormat;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  storagePath: string;
  source: UserAssetSource;
  conversationId: string | null;
  taskId: string | null;
  runId: string | null;
  parentVersionId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
};

export type UserAssetDescriptor = {
  assetId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  name: string;
  status: UserAssetStatus;
  currentVersionId: string | null;
  currentVersion: UserAssetVersionDescriptor | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type UserAssetBytes = { descriptor: UserAssetVersionDescriptor; bytes: Buffer };
export type UserAssetMutationSource = {
  source?: UserAssetSource;
  conversationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  leaseToken?: string | null;
  idempotencyKey?: string | null;
  parentVersionId?: string | null;
  finalizeRun?: FinalizeAutomationRun;
};

export class UserAssetError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code + ":" + message);
    this.name = "UserAssetError";
    this.code = code;
    this.details = details;
  }
}

type AssetRow = {
  assetId: string; userId: string; projectId: string; instanceId: string; name: string;
  status: string; currentVersionId: string | null; archivedAt: string | null;
  createdAt: string; updatedAt: string;
};
type VersionRow = {
  versionId: string; assetId: string; userId: string; projectId: string; instanceId: string;
  versionNumber: number;
  fileName: string; format: string; mimeType: string; sizeBytes: number; checksum: string;
  storagePath: string; source: string; conversationId: string | null; taskId: string | null;
  runId: string | null; parentVersionId: string | null; idempotencyKey: string | null;
  idempotencyFingerprint: string | null; createdAt: string;
};
type NormalizedInput = { fileName: string; format: AssetFormat; mimeType: string; bytes: Buffer; checksum: string };

export type FinalizeAutomationRun = (input: {
  assetId: string;
  versionId: string;
  checksum: string;
  resultSummary?: string | null;
  traceId?: string | null;
}) => void;

const ASSET_COLUMNS = [
  "asset_id AS assetId", "user_id AS userId", "project_id AS projectId", "instance_id AS instanceId",
  "name", "status", "current_version_id AS currentVersionId", "archived_at AS archivedAt",
  "created_at AS createdAt", "updated_at AS updatedAt",
].join(", ");
const VERSION_COLUMNS = [
  "version_id AS versionId", "asset_id AS assetId", "user_id AS userId", "project_id AS projectId",
  "instance_id AS instanceId", "file_name AS fileName", "format", "mime_type AS mimeType",
  "version_number AS versionNumber",
  "size_bytes AS sizeBytes", "checksum", "storage_path AS storagePath", "source",
  "conversation_id AS conversationId", "task_id AS taskId", "run_id AS runId",
  "parent_version_id AS parentVersionId", "idempotency_key AS idempotencyKey",
  "idempotency_fingerprint AS idempotencyFingerprint", "created_at AS createdAt",
].join(", ");
const MAX_BYTES: Record<AssetFormat, number> = {
  markdown: 15 * 1024 * 1024, html: 1 * 1024 * 1024, csv: 25 * 1024 * 1024,
  xlsx: 25 * 1024 * 1024, pdf: 15 * 1024 * 1024, png: 15 * 1024 * 1024,
  jpeg: 15 * 1024 * 1024, webp: 15 * 1024 * 1024, svg: 15 * 1024 * 1024,
};
const MIME_BY_FORMAT: Record<AssetFormat, string[]> = {
  markdown: ["text/markdown", "text/plain"], html: ["text/html"],
  csv: ["text/csv", "text/plain", "application/csv"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  pdf: ["application/pdf"], png: ["image/png"], jpeg: ["image/jpeg", "image/jpg"],
  webp: ["image/webp"], svg: ["image/svg+xml"],
};
const CANONICAL_MIME: Record<AssetFormat, string> = {
  markdown: "text/markdown", html: "text/html", csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf", png: "image/png", jpeg: "image/jpeg",
  webp: "image/webp", svg: "image/svg+xml",
};
const EXTENSION_FORMAT: Record<string, AssetFormat> = {
  ".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html",
  ".csv": "csv", ".xlsx": "xlsx", ".pdf": "pdf", ".png": "png",
  ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp", ".svg": "svg",
};
const SOURCES = new Set<UserAssetSource>(["upload", "conversation", "automation", "restore", "system"]);

export async function createUserAsset(input: AssetScope & {
  name?: string; fileName: string; mimeType?: string; bytes: Uint8Array;
} & UserAssetMutationSource): Promise<UserAssetDescriptor> {
  const scope = normalizeScope(input);
  const normalized = await normalizeInput(input.fileName, input.mimeType, input.bytes);
  const source = normalizeSource(input.source);
  const idempotencyKey = normalizeKey(input.idempotencyKey);
  const name = normalizeName(input.name || defaultName(normalized.fileName));
  const idempotencyFingerprint = fingerprint("asset.create", {
    name, fileName: normalized.fileName, mimeType: normalized.mimeType, checksum: normalized.checksum, source,
  });
  if (idempotencyKey) {
    const old = sqlite.prepare(
      "SELECT asset_id AS assetId, checksum, source, file_name AS fileName, idempotency_fingerprint AS idempotencyFingerprint FROM user_asset_versions " +
      "WHERE user_id = ? AND project_id = ? AND instance_id = ? AND idempotency_key = ?",
    ).get(scope.userId, scope.projectId, scope.instanceId, idempotencyKey) as { assetId?: string; checksum?: string; source?: string; fileName?: string; idempotencyFingerprint?: string | null } | undefined;
    if (old?.assetId) {
      if ((old.idempotencyFingerprint && old.idempotencyFingerprint !== idempotencyFingerprint)
        || (!old.idempotencyFingerprint && (old.checksum !== normalized.checksum || old.source !== source || old.fileName !== normalized.fileName))) {
        throw new UserAssetError("ASSET_IDEMPOTENCY_CONFLICT", "idempotency key conflict");
      }
      return hydrate(requireAsset({ ...scope, assetId: old.assetId }), scope);
    }
  }
  const assetId = "asset_" + randomUUID().replaceAll("-", "");
  return withResourceMutationLock(scope, "user-asset:" + assetId, async () => {
    const now = nowIso();
    const versionId = "version_" + randomUUID().replaceAll("-", "");
    const storagePath = assetStoragePath(assetId, versionId, normalized.fileName);
    const absolute = await stageAndCommit(scope, storagePath, normalized.bytes);
    try {
      sqlite.transaction(() => {
        assertAutomationMutationLease(scope, source, input);
        sqlite.prepare(
          "INSERT INTO user_assets " +
          "(asset_id,user_id,project_id,instance_id,name,status,current_version_id,archived_at,created_at,updated_at) " +
          "VALUES (?,?,?,?,?,'active',?,NULL,?,?)",
        ).run(assetId, scope.userId, scope.projectId, scope.instanceId, name, versionId, now, now);
        insertVersion({ versionId, versionNumber: 1, assetId, scope, normalized, storagePath, source, input, idempotencyKey, idempotencyFingerprint, createdAt: now });
        input.finalizeRun?.({ assetId, versionId, checksum: normalized.checksum });
      })();
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => undefined);
      if (error instanceof UserAssetError) throw error;
      throw new UserAssetError("ASSET_COMMIT_FAILED", "asset creation failed", { cause: errorMessage(error) });
    }
    const result = await hydrate(requireAsset({ ...scope, assetId }), scope);
    recordAssetLifecycle(scope, assetId, "asset.created", "success", { versionId, source, sizeBytes: normalized.bytes.length });
    return result;
  });
}

export async function uploadUserAssetVersion(input: AssetScope & {
  assetId: string; fileName: string; mimeType?: string; bytes: Uint8Array; expectedVersionId?: string | null;
} & UserAssetMutationSource): Promise<UserAssetDescriptor> {
  const scope = normalizeScope(input);
  const assetId = normalizeOpaqueId(input.assetId, "assetId");
  const normalized = await normalizeInput(input.fileName, input.mimeType, input.bytes);
  const source = normalizeSource(input.source);
  const idempotencyKey = normalizeKey(input.idempotencyKey);
  const idempotencyFingerprint = fingerprint("asset.version.commit", {
    assetId, fileName: normalized.fileName, mimeType: normalized.mimeType, checksum: normalized.checksum,
    source, expectedVersionId: input.expectedVersionId ?? null, parentVersionId: input.parentVersionId ?? null,
  });
  return withResourceMutationLock(scope, "user-asset:" + assetId, async () => {
    const asset = requireAsset({ ...scope, assetId });
    if (asset.status !== "active") throw new UserAssetError("ASSET_ARCHIVED", assetId);
    if (idempotencyKey) {
      const old = sqlite.prepare(
        "SELECT " + VERSION_COLUMNS + " FROM user_asset_versions " +
        "WHERE user_id = ? AND project_id = ? AND instance_id = ? AND idempotency_key = ?",
      ).get(scope.userId, scope.projectId, scope.instanceId, idempotencyKey) as VersionRow | undefined;
      if (old) {
        if (old.assetId !== assetId || (old.idempotencyFingerprint && old.idempotencyFingerprint !== idempotencyFingerprint)
          || (!old.idempotencyFingerprint && (old.checksum !== normalized.checksum || old.source !== source))) {
          throw new UserAssetError("ASSET_IDEMPOTENCY_CONFLICT", "idempotency key conflict");
        }
        const replay = await hydrate(requireAsset({ ...scope, assetId }), scope);
        recordAssetLifecycle(scope, assetId, "asset.version_replayed", "success", { idempotent: true, versionId: old.versionId });
        return replay;
      }
    }
    if (input.expectedVersionId !== undefined && input.expectedVersionId !== asset.currentVersionId) {
      throw new UserAssetError("ASSET_VERSION_CONFLICT", "asset head is stale");
    }
    const now = nowIso();
    const nextVersionNumber = Number((sqlite.prepare(
      "SELECT COALESCE(MAX(version_number), 0) AS maxVersion FROM user_asset_versions WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?",
    ).get(assetId, scope.userId, scope.projectId, scope.instanceId) as { maxVersion?: number }).maxVersion || 0) + 1;
    const versionId = "version_" + randomUUID().replaceAll("-", "");
    const storagePath = assetStoragePath(assetId, versionId, normalized.fileName);
    const absolute = await stageAndCommit(scope, storagePath, normalized.bytes);
    try {
      sqlite.transaction(() => {
        const current = requireAsset({ ...scope, assetId });
        if (current.status !== "active") throw new UserAssetError("ASSET_ARCHIVED", assetId);
        if (input.expectedVersionId !== undefined && input.expectedVersionId !== current.currentVersionId) {
          throw new UserAssetError("ASSET_VERSION_CONFLICT", "asset head changed while committing");
        }
        assertAutomationMutationLease(scope, source, input);
        insertVersion({ versionId, versionNumber: nextVersionNumber, assetId, scope, normalized, storagePath, source, input, idempotencyKey, idempotencyFingerprint, createdAt: now });
        const result = sqlite.prepare(
          "UPDATE user_assets SET current_version_id = ?, updated_at = ? " +
          "WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?",
        ).run(versionId, now, assetId, scope.userId, scope.projectId, scope.instanceId);
        if (result.changes !== 1) throw new UserAssetError("ASSET_COMMIT_FAILED", "asset head update failed");
        input.finalizeRun?.({ assetId, versionId, checksum: normalized.checksum });
      })();
    } catch (error) {
      await rm(absolute, { force: true }).catch(() => undefined);
      if (error instanceof UserAssetError) throw error;
      throw new UserAssetError("ASSET_COMMIT_FAILED", "asset version commit failed", { cause: errorMessage(error) });
    }
    const result = await hydrate(requireAsset({ ...scope, assetId }), scope);
    recordAssetLifecycle(scope, assetId, source === "restore" ? "asset.version_restored" : "asset.version_committed", "success", {
      versionId, parentVersionId: input.parentVersionId ?? null, source, sizeBytes: normalized.bytes.length,
    });
    return result;
  });
}

export async function restoreUserAssetVersion(input: AssetScope & {
  assetId: string; versionId: string; expectedVersionId?: string | null;
} & UserAssetMutationSource): Promise<UserAssetDescriptor> {
  const scope = normalizeScope(input);
  const asset = requireAsset({ ...scope, assetId: input.assetId });
  if (asset.status !== "active") throw new UserAssetError("ASSET_ARCHIVED", asset.assetId);
  const old = await readUserAssetVersion({ ...scope, assetId: input.assetId, versionId: input.versionId });
  return uploadUserAssetVersion({
    ...scope, assetId: input.assetId, fileName: old.descriptor.fileName,
    mimeType: old.descriptor.mimeType, bytes: old.bytes, expectedVersionId: input.expectedVersionId,
    source: "restore", conversationId: input.conversationId, taskId: input.taskId, runId: input.runId,
    leaseToken: input.leaseToken,
    parentVersionId: old.descriptor.versionId,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function saveConversationArtifactAsUserAsset(input: AssetScope & {
  name?: string;
  fileName: string;
  mimeType?: string;
  bytes: Uint8Array;
  assetId?: string | null;
  confirmedByUser?: boolean;
  conversationId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  leaseToken?: string | null;
  idempotencyKey?: string | null;
}): Promise<UserAssetDescriptor> {
  const isAutomationSave = Boolean(input.taskId && input.runId);
  if (!input.confirmedByUser && !isAutomationSave) {
    throw new UserAssetError("ASSET_CONFIRMATION_REQUIRED", "saving a conversation artifact requires explicit confirmation");
  }
  const source: UserAssetSource = isAutomationSave ? "automation" : "conversation";
  if (input.assetId) {
    return uploadUserAssetVersion({
      ...input,
      assetId: input.assetId,
      source,
    });
  }
  return createUserAsset({
    ...input,
    source,
  });
}

export async function listUserAssets(input: AssetScope & {
  status?: UserAssetStatus | "all"; search?: string; format?: AssetFormat; limit?: number;
}): Promise<UserAssetDescriptor[]> {
  const scope = normalizeScope(input);
  const limit = clampLimit(input.limit);
  const clauses = ["user_id = ?", "project_id = ?", "instance_id = ?"];
  const params: unknown[] = [scope.userId, scope.projectId, scope.instanceId];
  if (input.status && input.status !== "all") {
    if (input.status !== "active" && input.status !== "archived") throw new UserAssetError("ASSET_INVALID_SCOPE", "invalid status");
    clauses.push("status = ?"); params.push(input.status);
  }
  if (input.search?.trim()) {
    clauses.push("LOWER(name) LIKE ?"); params.push("%" + input.search.trim().toLowerCase().replaceAll("%", "\\%") + "%");
  }
  if (input.format) {
    if (!Object.prototype.hasOwnProperty.call(MAX_BYTES, input.format)) throw new UserAssetError("ASSET_UNSUPPORTED_FORMAT", String(input.format));
    clauses.push("current_version_id IN (SELECT version_id FROM user_asset_versions WHERE format = ?)");
    params.push(input.format);
  }
  const rows = sqlite.prepare(
    "SELECT " + ASSET_COLUMNS + " FROM user_assets WHERE " + clauses.join(" AND ") +
    " ORDER BY updated_at DESC, asset_id DESC LIMIT ?",
  ).all(...params, limit) as AssetRow[];
  return Promise.all(rows.map((row) => hydrate(row, scope)));
}

export async function getUserAsset(input: AssetScope & { assetId: string }): Promise<UserAssetDescriptor | null> {
  const scope = normalizeScope(input);
  const row = sqlite.prepare("SELECT " + ASSET_COLUMNS + " FROM user_assets WHERE asset_id = ?")
    .get(normalizeOpaqueId(input.assetId, "assetId")) as AssetRow | undefined;
  if (!row) return null;
  assertScope(row, scope);
  return hydrate(row, scope);
}

export async function listUserAssetVersions(input: AssetScope & { assetId: string }): Promise<UserAssetVersionDescriptor[]> {
  const scope = normalizeScope(input);
  const asset = requireAsset({ ...scope, assetId: input.assetId });
  const rows = sqlite.prepare(
    "SELECT " + VERSION_COLUMNS + " FROM user_asset_versions " +
    "WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? " +
    "ORDER BY created_at DESC, version_id DESC",
  ).all(asset.assetId, scope.userId, scope.projectId, scope.instanceId) as VersionRow[];
  return rows.map(versionFromRow);
}

export async function readCurrentUserAsset(input: AssetScope & { assetId: string }): Promise<UserAssetBytes> {
  const scope = normalizeScope(input);
  const asset = requireAsset({ ...scope, assetId: input.assetId });
  if (!asset.currentVersionId) throw new UserAssetError("ASSET_NOT_FOUND", asset.assetId);
  return readUserAssetVersion({ ...scope, assetId: asset.assetId, versionId: asset.currentVersionId });
}

export async function readUserAssetVersion(input: AssetScope & { assetId: string; versionId: string }): Promise<UserAssetBytes> {
  const scope = normalizeScope(input);
  const assetId = normalizeOpaqueId(input.assetId, "assetId");
  const versionId = normalizeOpaqueId(input.versionId, "versionId");
  const row = sqlite.prepare("SELECT " + VERSION_COLUMNS + " FROM user_asset_versions WHERE version_id = ?")
    .get(versionId) as VersionRow | undefined;
  if (!row) throw new UserAssetError("ASSET_NOT_FOUND", versionId);
  assertScope(row, scope);
  if (row.assetId !== assetId) throw new UserAssetError("ASSET_SCOPE_MISMATCH", versionId);
  return { descriptor: versionFromRow(row), bytes: await readAndVerify(scope, row) };
}

export async function renameUserAsset(input: AssetScope & { assetId: string; name: string }): Promise<UserAssetDescriptor> {
  const scope = normalizeScope(input);
  const assetId = normalizeOpaqueId(input.assetId, "assetId");
  const name = normalizeName(input.name);
  return withResourceMutationLock(scope, "user-asset:" + assetId, async () => {
    const asset = requireAsset({ ...scope, assetId });
    if (asset.status !== "active") throw new UserAssetError("ASSET_ARCHIVED", assetId);
    sqlite.prepare(
      "UPDATE user_assets SET name = ?, updated_at = ? " +
      "WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?",
    ).run(name, nowIso(), assetId, scope.userId, scope.projectId, scope.instanceId);
    const result = await hydrate(requireAsset({ ...scope, assetId }), scope);
    recordAssetLifecycle(scope, assetId, "asset.renamed", "success", { name });
    return result;
  });
}

export async function archiveUserAsset(input: AssetScope & { assetId: string }): Promise<UserAssetDescriptor> {
  const scope = normalizeScope(input);
  const assetId = normalizeOpaqueId(input.assetId, "assetId");
  return withResourceMutationLock(scope, "user-asset:" + assetId, async () => {
    requireAsset({ ...scope, assetId });
    const now = nowIso();
    sqlite.prepare(
      "UPDATE user_assets SET status = 'archived', archived_at = ?, updated_at = ? " +
      "WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?",
    ).run(now, now, assetId, scope.userId, scope.projectId, scope.instanceId);
    const result = await hydrate(requireAsset({ ...scope, assetId }), scope);
    recordAssetLifecycle(scope, assetId, "asset.archived", "success", { status: "archived" });
    return result;
  });
}

export async function listUserAssetReferences(input: AssetScope & { assetId: string }): Promise<{
  taskBindings: Array<{ bindingId: string; taskId: string; revisionId: string; role: string; versionPolicy: string; versionId: string | null; createdAt: string }>;
  provenance: UserAssetVersionDescriptor[];
}> {
  const scope = normalizeScope(input);
  const asset = requireAsset({ ...scope, assetId: input.assetId });
  const bindings = sqlite.prepare(
    "SELECT binding_id AS bindingId, task_id AS taskId, revision_id AS revisionId, role, " +
    "version_policy AS versionPolicy, version_id AS versionId, created_at AS createdAt " +
    "FROM automation_task_asset_bindings WHERE asset_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? " +
    "ORDER BY created_at DESC",
  ).all(asset.assetId, scope.userId, scope.projectId, scope.instanceId) as Array<{
    bindingId: string; taskId: string; revisionId: string; role: string; versionPolicy: string; versionId: string | null; createdAt: string;
  }>;
  return { taskBindings: bindings, provenance: await listUserAssetVersions({ ...scope, assetId: asset.assetId }) };
}

export function assetFormatForFileName(fileName: string): AssetFormat {
  const format = EXTENSION_FORMAT[path.posix.extname(fileName.trim().toLowerCase())];
  if (!format) throw new UserAssetError("ASSET_UNSUPPORTED_FORMAT", fileName);
  return format;
}

async function normalizeInput(fileNameValue: string, mimeValue: string | undefined, value: Uint8Array): Promise<NormalizedInput> {
  const fileName = normalizeFileName(fileNameValue);
  const format = assetFormatForFileName(fileName);
  const bytes = Buffer.from(value || new Uint8Array());
  if (!bytes.length) throw new UserAssetError("ASSET_INVALID_CONTENT", "asset is empty");
  if (bytes.length > MAX_BYTES[format]) throw new UserAssetError("ASSET_TOO_LARGE", String(bytes.length), { limitBytes: MAX_BYTES[format] });
  const mime = normalizeMime(mimeValue);
  if (mime && !MIME_BY_FORMAT[format].includes(mime)) throw new UserAssetError("ASSET_MIME_MISMATCH", fileName + ":" + mime);
  await validateContent(format, bytes);
  return { fileName, format, mimeType: CANONICAL_MIME[format], bytes, checksum: sha256(bytes) };
}

async function validateContent(format: AssetFormat, bytes: Buffer): Promise<void> {
  if (format === "csv" || format === "xlsx") {
    try {
      await validateAutomationSpreadsheet({ extension: format === "csv" ? ".csv" : ".xlsx", bytes });
    } catch (error) {
      throw new UserAssetError("ASSET_INVALID_CONTENT", errorMessage(error));
    }
  }
  if (format === "markdown" || format === "html" || format === "svg") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new UserAssetError("ASSET_INVALID_CONTENT", "text asset must be UTF-8"); }
    if (text.includes("\u0000")) throw new UserAssetError("ASSET_INVALID_CONTENT", "text asset contains NUL");
    if (format === "html" && /<script|javascript:/i.test(text)) throw new UserAssetError("ASSET_INVALID_CONTENT", "HTML contains unsafe active content");
    if (format === "svg" && /<script|javascript:|on[a-z]+\s*=/i.test(text)) throw new UserAssetError("ASSET_INVALID_CONTENT", "SVG contains unsafe active content");
  }
  if (format === "pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new UserAssetError("ASSET_MIME_MISMATCH", "PDF signature is invalid");
  if (format === "png" && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new UserAssetError("ASSET_MIME_MISMATCH", "PNG signature is invalid");
  if (format === "jpeg" && !(bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217)) throw new UserAssetError("ASSET_MIME_MISMATCH", "JPEG signature is invalid");
  if (format === "webp" && !(bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP")) throw new UserAssetError("ASSET_MIME_MISMATCH", "WebP signature is invalid");
}

function requireAsset(input: AssetScope & { assetId: string }): AssetRow {
  const row = sqlite.prepare("SELECT " + ASSET_COLUMNS + " FROM user_assets WHERE asset_id = ?")
    .get(normalizeOpaqueId(input.assetId, "assetId")) as AssetRow | undefined;
  if (!row) throw new UserAssetError("ASSET_NOT_FOUND", input.assetId);
  assertScope(row, input);
  return row;
}

async function hydrate(row: AssetRow, scope: AssetScope): Promise<UserAssetDescriptor> {
  const version = row.currentVersionId
    ? sqlite.prepare("SELECT " + VERSION_COLUMNS + " FROM user_asset_versions WHERE version_id = ?").get(row.currentVersionId) as VersionRow | undefined
    : undefined;
  if (version) assertScope(version, scope);
  return {
    assetId: row.assetId, userId: row.userId, projectId: row.projectId, instanceId: row.instanceId,
    name: row.name, status: normalizeStatus(row.status), currentVersionId: row.currentVersionId,
    currentVersion: version ? versionFromRow(version) : null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, archivedAt: row.archivedAt,
  };
}

function versionFromRow(row: VersionRow): UserAssetVersionDescriptor {
  return {
    versionId: row.versionId, assetId: row.assetId, userId: row.userId, projectId: row.projectId,
    instanceId: row.instanceId, versionNumber: row.versionNumber, fileName: row.fileName, format: normalizeFormat(row.format),
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, checksum: row.checksum, storagePath: row.storagePath,
    source: normalizeSource(row.source as UserAssetSource), conversationId: row.conversationId,
    taskId: row.taskId, runId: row.runId, parentVersionId: row.parentVersionId,
    idempotencyKey: row.idempotencyKey, createdAt: row.createdAt,
  };
}

async function readAndVerify(scope: AssetScope, row: VersionRow): Promise<Buffer> {
  const root = await workspaceRoot(scope);
  const expected = assetStoragePath(row.assetId, row.versionId, row.fileName);
  if (row.storagePath !== expected) throw new UserAssetError("ASSET_PATH_UNSAFE", row.versionId);
  const target = path.resolve(root, row.storagePath);
  const entry = await lstat(target).catch(() => null);
  if (!entry || !entry.isFile() || entry.isSymbolicLink()) throw new UserAssetError("ASSET_NOT_FOUND", row.versionId);
  const real = await realpath(target).catch(() => null);
  if (!real || !isWithin(root, real)) throw new UserAssetError("ASSET_PATH_UNSAFE", row.versionId);
  const bytes = await readFile(real);
  if (bytes.length !== row.sizeBytes || sha256(bytes) !== row.checksum) throw new UserAssetError("ASSET_CHECKSUM_MISMATCH", row.versionId);
  return bytes;
}

async function stageAndCommit(scope: AssetScope, storagePath: string, bytes: Buffer): Promise<string> {
  const root = await workspaceRoot(scope);
  const target = path.resolve(root, storagePath);
  if (!isWithin(root, target)) throw new UserAssetError("ASSET_PATH_UNSAFE", storagePath);
  const stagingDir = path.join(root, "assets", ".staging", randomUUID().replaceAll("-", ""));
  const staging = path.join(stagingDir, path.basename(target));
  await ensureSafeDirectory(root, path.dirname(target));
  await ensureSafeDirectory(root, stagingDir);
  try {
    await writeFile(staging, bytes, { flag: "wx", mode: 0o600 });
    await assertRegular(root, staging);
    await rename(staging, target);
    await assertRegular(root, target);
    return target;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function workspaceRoot(scope: AssetScope): Promise<string> {
  await mkdir(config.workspace.root, { recursive: true });
  const workspace = resolveWorkspacePath(scope.userId);
  await mkdir(workspace, { recursive: true });
  const configuredRoot = await realpath(config.workspace.root).catch(() => null);
  const root = await realpath(workspace).catch(() => null);
  if (!root || !configuredRoot || !isWithin(configuredRoot, root)) throw new UserAssetError("ASSET_PATH_UNSAFE", "workspace unavailable");
  return root;
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  if (!isWithin(root, directory)) throw new UserAssetError("ASSET_PATH_UNSAFE", directory);
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment || segment === "." || segment === "..") throw new UserAssetError("ASSET_PATH_UNSAFE", directory);
    current = path.join(current, segment);
    let entry = await lstat(current).catch(() => null);
    if (!entry) {
      try {
        await mkdir(current);
      } catch (error) {
        // Another upload may have created this directory between lstat and
        // mkdir. Re-read it, then apply the same symlink/path checks below.
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      }
      entry = await lstat(current).catch(() => null);
    }
    const real = await realpath(current).catch(() => null);
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink() || !real || !isWithin(root, real)) {
      throw new UserAssetError("ASSET_PATH_UNSAFE", directory);
    }
  }
}

async function assertRegular(root: string, target: string): Promise<void> {
  const entry = await lstat(target).catch(() => null);
  const real = await realpath(target).catch(() => null);
  if (!entry || !entry.isFile() || entry.isSymbolicLink() || !real || !isWithin(root, real)) throw new UserAssetError("ASSET_PATH_UNSAFE", target);
}

function insertVersion(input: {
  versionId: string; versionNumber: number; assetId: string; scope: AssetScope; normalized: NormalizedInput; storagePath: string;
  source: UserAssetSource; input: UserAssetMutationSource; idempotencyKey: string | null;
  idempotencyFingerprint: string; createdAt: string;
}): void {
  sqlite.prepare(
    "INSERT INTO user_asset_versions " +
    "(version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,conversation_id,task_id,run_id,parent_version_id,idempotency_key,idempotency_fingerprint,created_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    input.versionId, input.assetId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.versionNumber,
    input.normalized.fileName, input.normalized.format, input.normalized.mimeType, input.normalized.bytes.length,
    input.normalized.checksum, input.storagePath, input.source, input.input.conversationId || null,
    input.input.taskId || null, input.input.runId || null, input.input.parentVersionId || null,
    input.idempotencyKey, input.idempotencyFingerprint, input.createdAt,
  );
}

function assertAutomationMutationLease(scope: AssetScope, source: UserAssetSource, input: UserAssetMutationSource): void {
  if (source !== "automation") return;
  if (!input.taskId || !input.runId) {
    throw new UserAssetError("ASSET_INVALID_CONTENT", "automation asset mutation requires taskId and runId");
  }
  const row = sqlite.prepare(`
    SELECT status, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
    FROM automation_task_runs
    WHERE run_id = ? AND task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(input.runId, input.taskId, scope.userId, scope.projectId, scope.instanceId) as {
    status: string; leaseToken: string | null; leaseExpiresAt: string | null;
  } | undefined;
  const expiresAt = row?.leaseExpiresAt ? Date.parse(row.leaseExpiresAt) : NaN;
  if (!row || row.status !== "running" || !row.leaseToken ||
      (input.leaseToken !== undefined && input.leaseToken !== row.leaseToken) ||
      !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new UserAssetError("AUTOMATION_RUN_LEASE_LOST", "automation run lease is not valid");
  }
}

function normalizeScope(input: AssetScope): AssetScope {
  return { userId: normalizeOpaqueId(input.userId, "userId"), projectId: normalizeOpaqueId(input.projectId, "projectId"), instanceId: normalizeOpaqueId(input.instanceId, "instanceId") };
}
function assertScope(row: { userId: string; projectId: string; instanceId: string }, scope: AssetScope): void {
  if (row.userId !== scope.userId || row.projectId !== scope.projectId || row.instanceId !== scope.instanceId) throw new UserAssetError("ASSET_SCOPE_MISMATCH", "asset does not belong to the requested scope");
}
function normalizeOpaqueId(value: string, label: string): string {
  const result = String(value || "").trim();
  if (!result || result.length > 300 || /[\u0000-\u001f\u007f]/.test(result)) throw new UserAssetError("ASSET_INVALID_SCOPE", label + " is invalid");
  return result;
}
function normalizeName(value: string): string {
  const result = String(value || "").trim();
  if (!result || result.length > 200 || result.includes("\u0000")) throw new UserAssetError("ASSET_INVALID_NAME", result || "empty");
  return result;
}
function normalizeFileName(value: string): string {
  const result = String(value || "").trim();
  if (!result || result.length > 255 || result === "." || result === ".." || result.includes("\u0000") ||
      path.posix.isAbsolute(result) || path.win32.isAbsolute(result) || /[\\/]/.test(result)) throw new UserAssetError("ASSET_INVALID_NAME", result || "empty");
  return result;
}
function normalizeMime(value?: string): string { return String(value || "").split(";", 1)[0].trim().toLowerCase(); }
function normalizeKey(value?: string | null): string | null {
  if (!value || !value.trim()) return null;
  if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) throw new UserAssetError("ASSET_INVALID_CONTENT", "invalid idempotency key");
  return value.trim();
}
function normalizeSource(value?: UserAssetSource): UserAssetSource {
  const result = value || "upload";
  if (!SOURCES.has(result)) throw new UserAssetError("ASSET_INVALID_CONTENT", "invalid source");
  return result;
}
function normalizeStatus(value: string): UserAssetStatus {
  if (value === "active" || value === "archived") return value;
  throw new UserAssetError("ASSET_COMMIT_FAILED", "asset status is corrupt");
}
function normalizeFormat(value: string): AssetFormat {
  if (Object.prototype.hasOwnProperty.call(MAX_BYTES, value)) return value as AssetFormat;
  throw new UserAssetError("ASSET_COMMIT_FAILED", "asset format is corrupt");
}
function defaultName(fileName: string): string {
  const ext = path.posix.extname(fileName);
  return fileName.slice(0, -ext.length) || fileName;
}
function assetStoragePath(assetId: string, versionId: string, fileName: string): string {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(assetId) || !/^[A-Za-z0-9_-]{1,300}$/.test(versionId)) throw new UserAssetError("ASSET_PATH_UNSAFE", "invalid asset identifier");
  return path.posix.join("assets", assetId, "versions", versionId, normalizeFileName(fileName));
}
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function nowIso(): string { return new Date().toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fingerprint(operation: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ operation, ...payload });
}
function recordAssetLifecycle(
  scope: AssetScope,
  assetId: string,
  event: string,
  status: "success" | "failure" | "pending" | "skipped",
  summary?: Record<string, string | number | boolean | null | undefined>,
): void {
  recordFileLifecycleEvent({ entityType: "asset", entityId: assetId, userId: scope.userId, instanceId: scope.instanceId, event, status, summary: { projectId: scope.projectId, ...summary } });
}
function clampLimit(value?: number): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1) throw new UserAssetError("ASSET_INVALID_SCOPE", "invalid limit");
  return Math.min(value, 200);
}
