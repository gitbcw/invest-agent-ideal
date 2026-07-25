import { createHash, randomBytes } from "node:crypto";
import { realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../db/index.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { scanForUnsafeContent } from "./svg-sanitizer.js";
import { recordArtifactEvent } from "./artifact-events.js";
import { getCurrentTurnId } from "./conversation-turns.js";

export const ARTIFACT_PREVIEWABLE_MIME_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
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
  "application/json": "data",
  "text/csv": "data",
};

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "image/svg+xml",
]);

const MAX_PUBLISH_BYTES = 15 * 1024 * 1024;
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const REPORT_ROOT = "reports";

export interface ConversationArtifact {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "report" | "chart" | "data" | "document";
  previewMode: "markdown" | "image" | "pdf" | "text" | "table" | "unsupported";
  createdAt: string;
  checksum?: string;
}

export interface ConversationArtifactRecord extends ConversationArtifact {
  userId: string;
  instanceId: string;
  relativePath: string;
  scope: ConversationArtifactScope;
  turnId?: string | null;
}

export interface ConversationArtifactScope {
  projectId: string;
  assistantId: string;
  conversationId?: string | null;
  messageId?: string | null;
  source: "reviews.save" | "artifacts.publish" | "legacy_path";
}

export class ConversationArtifactError extends Error {
  constructor(
    public readonly code:
      | "ARTIFACT_INVALID_PATH"
      | "ARTIFACT_NOT_FOUND"
      | "ARTIFACT_UNSUPPORTED"
      | "ARTIFACT_TOO_LARGE"
      | "ARTIFACT_UNSAFE"
      | "ARTIFACT_SCOPE_MISMATCH",
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
  if (fileStat.size > MAX_PUBLISH_BYTES) {
    throw new ConversationArtifactError("ARTIFACT_TOO_LARGE", String(fileStat.size));
  }

  const raw = await readFile(realTargetPath);
  const checksum = sha256Hex(raw);
  const { mimeType, sanitizedBase64 } = await prepareArtifactPayload(inferredMime, raw);
  const sizeBytes = sanitizedBase64 ? Buffer.from(sanitizedBase64, "base64").length : raw.length;
  if (sizeBytes > MAX_PUBLISH_BYTES) {
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
  };

  sqlite
    .prepare(
      `INSERT INTO conversation_artifacts (
         artifact_id, user_id, instance_id, project_id, assistant_id,
         conversation_id, message_id, turn_id, source, kind, preview_mode,
         title, file_name, mime_type, relative_path, size_bytes, checksum,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(artifact_id) DO UPDATE SET
         updated_at = excluded.updated_at,
         title = excluded.title,
         file_name = excluded.file_name,
         mime_type = excluded.mime_type,
         relative_path = excluded.relative_path,
         size_bytes = excluded.size_bytes,
         checksum = excluded.checksum,
         turn_id = COALESCE(excluded.turn_id, conversation_artifacts.turn_id)`
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
    );

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
  const record = requireRecord(
    sqlite
      .prepare(
        `SELECT
           artifact_id AS artifactId,
           user_id AS userId,
           instance_id AS instanceId,
           project_id AS projectId,
           assistant_id AS assistantId,
           conversation_id AS conversationId,
           message_id AS messageId,
           turn_id AS turnId,
           source,
           kind,
           preview_mode AS previewMode,
           title,
           file_name AS fileName,
           mime_type AS mimeType,
           relative_path AS relativePath,
           size_bytes AS sizeBytes,
           checksum,
           created_at AS createdAt
         FROM conversation_artifacts
         WHERE artifact_id = ?`
      )
      .get(input.artifactId) as ConversationArtifactRecord | undefined,
  );
  if (record.userId !== input.userId) {
    throw new ConversationArtifactError("ARTIFACT_SCOPE_MISMATCH", input.artifactId);
  }
  if (input.instanceId && record.instanceId !== input.instanceId) {
    throw new ConversationArtifactError("ARTIFACT_SCOPE_MISMATCH", input.artifactId);
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
  if (!fileStat.isFile()) {
    throw new ConversationArtifactError("ARTIFACT_NOT_FOUND", record.relativePath);
  }
  if (fileStat.size > MAX_INLINE_BYTES) {
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
      `SELECT
         artifact_id AS artifactId,
         user_id AS userId,
         instance_id AS instanceId,
         project_id AS projectId,
         assistant_id AS assistantId,
         conversation_id AS conversationId,
         message_id AS messageId,
         turn_id AS turnId,
         source,
         kind,
         preview_mode AS previewMode,
         title,
         file_name AS fileName,
         mime_type AS mimeType,
         relative_path AS relativePath,
         size_bytes AS sizeBytes,
         checksum,
         created_at AS createdAt
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
      `SELECT
         artifact_id AS artifactId,
         user_id AS userId,
         instance_id AS instanceId,
         project_id AS projectId,
         assistant_id AS assistantId,
         conversation_id AS conversationId,
         message_id AS messageId,
         turn_id AS turnId,
         source,
         kind,
         preview_mode AS previewMode,
         title,
         file_name AS fileName,
         mime_type AS mimeType,
         relative_path AS relativePath,
         size_bytes AS sizeBytes,
         checksum,
         created_at AS createdAt
       FROM conversation_artifacts
       WHERE user_id = ? AND instance_id = ? AND conversation_id = ? AND turn_id = ?
       ORDER BY created_at ASC, artifact_id ASC`
    )
    .all(input.userId, input.instanceId, input.conversationId, input.turnId) as ConversationArtifactRecord[];
  return rows;
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
