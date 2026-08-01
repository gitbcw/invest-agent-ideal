import { randomUUID, createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const MAX_IMAGE_BYTES = Number(process.env.ATTACHMENT_IMAGE_MAX_BYTES) || 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = Number(process.env.ATTACHMENT_DOCUMENT_MAX_BYTES) || 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = Number(process.env.ATTACHMENT_MAX_FILES_PER_MESSAGE) || 8;
const MAX_TOTAL_BYTES_PER_MESSAGE = Number(process.env.ATTACHMENT_MAX_TOTAL_BYTES_PER_MESSAGE) || 40 * 1024 * 1024;

/**
 * Authoritative TTL for user uploads, in days. The previous cleanup loop
 * guessed retention from the `attachments/YYYY-MM-DD/` directory name; the
 * file-retention work package replaces that with an explicit `expires_at`
 * column on `conversation_attachments`. This constant is the single source
 * of truth for both the upload write path and the cleanup job.
 */
export const ATTACHMENT_RETENTION_DAYS = 7;

const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_DOCUMENT_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
]);

const EXTENSION_MIME: Record<string, string[]> = {
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".webp": ["image/webp"],
  ".pdf": ["application/pdf"],
  ".doc": ["application/msword"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".ppt": ["application/vnd.ms-powerpoint"],
  ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ".xls": ["application/vnd.ms-excel"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ".csv": ["text/csv"],
  ".html": ["text/html"],
  ".htm": ["text/html"],
  ".md": ["text/markdown", "text/plain"],
  ".txt": ["text/plain", "text/markdown"],
};

export type IncomingMediaAttachment = {
  type: "image" | "audio" | "video" | "file";
  filePath: string;
  mimeType: string;
  fileName?: string;
};

export type IncomingPortalAttachment = {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  base64?: string;
  downloadUrl?: string;
};

export type StoredAttachment = {
  id: string;
  type: "image" | "document";
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  path: string;
  relativePath: string;
  source: "weixin" | "portal";
  /** sha256 of the stored bytes; persisted on the `conversation_attachments` row. */
  checksum: string;
};

export type PublicAttachmentMetadata = Omit<StoredAttachment, "path">;

export class AttachmentStoreError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_ATTACHMENT_TYPE"
      | "UNSUPPORTED_ATTACHMENT_MIME"
      | "ATTACHMENT_TOO_LARGE"
      | "ATTACHMENT_TOTAL_TOO_LARGE"
      | "ATTACHMENT_TOO_MANY_FILES"
      | "ATTACHMENT_INVALID_BASE64"
      | "ATTACHMENT_MIME_MISMATCH"
      | "ATTACHMENT_BINARY_TEXT"
      | "ATTACHMENT_DOWNLOAD_FAILED"
      | "ATTACHMENT_DOWNLOAD_URL_UNSAFE",
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(`${code}:${message}`);
    this.name = "AttachmentStoreError";
  }
}

export async function storeWeixinAttachment(input: {
  workspacePath: string;
  media: IncomingMediaAttachment;
}): Promise<StoredAttachment> {
  if (input.media.type !== "image") {
    throw new AttachmentStoreError("UNSUPPORTED_ATTACHMENT_TYPE", input.media.type);
  }
  const sourceStat = await stat(input.media.filePath);
  if (sourceStat.size > MAX_IMAGE_BYTES) {
    throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(sourceStat.size), {
      limitBytes: MAX_IMAGE_BYTES,
      sizeBytes: sourceStat.size,
    });
  }
  const bytes = await readFile(input.media.filePath);
  const detected = detectAttachmentBytes(bytes);
  const declaredMime = normalizeMimeType(input.media.mimeType);
  const mimeType = declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== "image/*"
    ? declaredMime
    : detected.mimeType || inferMimeType(input.media.fileName || input.media.filePath) || "image/jpeg";
  const ext = extensionForMime(mimeType, detected.extension);
  validateAttachment({
    kind: "image",
    mimeType,
    fileName: input.media.fileName || `weixin-image${ext}`,
    bytes,
    detected,
  });

  const id = `att_${randomUUID()}`;
  const safeName = safeFileName(input.media.fileName, ext) || `${id}${ext}`;
  const relativePath = buildRelativeAttachmentPath(id, safeName);
  const targetPath = path.join(input.workspacePath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(input.media.filePath, targetPath);

  return {
    id,
    type: "image",
    mimeType,
    fileName: safeName,
    sizeBytes: sourceStat.size,
    path: targetPath,
    relativePath,
    source: "weixin",
    checksum: sha256Hex(bytes),
  };
}

export async function storePortalAttachment(input: {
  workspacePath: string;
  attachment: IncomingPortalAttachment;
}): Promise<StoredAttachment> {
  return storeIncomingAttachment({
    workspacePath: input.workspacePath,
    attachment: input.attachment,
    source: "portal",
  });
}

export async function storePortalAttachments(input: {
  workspacePath: string;
  attachments?: IncomingPortalAttachment[];
}): Promise<StoredAttachment[]> {
  const attachments = input.attachments || [];
  if (attachments.length > MAX_FILES_PER_MESSAGE) {
    throw new AttachmentStoreError("ATTACHMENT_TOO_MANY_FILES", String(attachments.length), {
      limit: MAX_FILES_PER_MESSAGE,
      count: attachments.length,
    });
  }
  const declaredTotal = attachments.reduce((sum, item) => sum + Math.max(Number(item.sizeBytes || 0), 0), 0);
  if (declaredTotal > MAX_TOTAL_BYTES_PER_MESSAGE) {
    throw new AttachmentStoreError("ATTACHMENT_TOTAL_TOO_LARGE", String(declaredTotal), {
      limitBytes: MAX_TOTAL_BYTES_PER_MESSAGE,
      sizeBytes: declaredTotal,
    });
  }

  const stored: StoredAttachment[] = [];
  let actualTotal = 0;
  for (const attachment of attachments) {
    const item = await storePortalAttachment({ workspacePath: input.workspacePath, attachment });
    actualTotal += item.sizeBytes;
    if (actualTotal > MAX_TOTAL_BYTES_PER_MESSAGE) {
      throw new AttachmentStoreError("ATTACHMENT_TOTAL_TOO_LARGE", String(actualTotal), {
        limitBytes: MAX_TOTAL_BYTES_PER_MESSAGE,
        sizeBytes: actualTotal,
      });
    }
    stored.push(item);
  }
  return stored;
}

export function toPublicAttachmentMetadata(attachment: StoredAttachment): PublicAttachmentMetadata {
  const { path: _path, ...publicMetadata } = attachment;
  return publicMetadata;
}

async function storeIncomingAttachment(input: {
  workspacePath: string;
  attachment: IncomingPortalAttachment;
  source: "portal";
}): Promise<StoredAttachment> {
  const bytes = await readPortalAttachmentBytes(input.attachment);
  const detected = detectAttachmentBytes(bytes);
  const declaredMime = normalizeMimeType(input.attachment.mimeType);
  const mimeType = declaredMime || detected.mimeType || inferMimeType(input.attachment.fileName) || "";
  const kind = input.attachment.kind || inferKind(mimeType);
  validateAttachment({
    kind,
    mimeType,
    fileName: input.attachment.fileName,
    bytes,
    detected,
  });
  if (input.attachment.sizeBytes !== undefined && Number(input.attachment.sizeBytes) !== bytes.length) {
    throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", `declared size ${input.attachment.sizeBytes} does not match actual ${bytes.length}`, {
      declaredSizeBytes: input.attachment.sizeBytes,
      sizeBytes: bytes.length,
    });
  }

  const id = `att_${randomUUID()}`;
  const ext = path.extname(path.basename(input.attachment.fileName)).toLowerCase() || extensionForMime(mimeType, detected.extension);
  const safeName = safeFileName(input.attachment.fileName, ext) || `${id}${ext}`;
  const relativePath = buildRelativeAttachmentPath(id, safeName);
  const targetPath = path.join(input.workspacePath, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, bytes);

  return {
    id,
    type: kind,
    mimeType,
    fileName: safeName,
    sizeBytes: bytes.length,
    path: targetPath,
    relativePath,
    source: input.source,
    checksum: sha256Hex(bytes),
  };
}

async function readPortalAttachmentBytes(input: IncomingPortalAttachment): Promise<Buffer> {
  if (input.base64) {
    const raw = input.base64.trim().startsWith("data:")
      ? input.base64.trim().slice(input.base64.trim().indexOf(",") + 1)
      : input.base64.trim();
    const compactLength = raw.replace(/\s+/g, "").length;
    if (compactLength > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4) {
      throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(compactLength), { limitBytes: MAX_DOCUMENT_BYTES, encodedSizeBytes: compactLength });
    }
    const base64 = normalizeBase64(input.base64);
    if (!base64) {
      throw new AttachmentStoreError("ATTACHMENT_INVALID_BASE64", input.fileName || "-");
    }
    const decodedBytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
    if (decodedBytes > MAX_DOCUMENT_BYTES) {
      throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(decodedBytes), { limitBytes: MAX_DOCUMENT_BYTES, sizeBytes: decodedBytes });
    }
    return Buffer.from(base64, "base64");
  }
  if (input.downloadUrl) {
    await assertSafeDownloadUrl(input.downloadUrl);
    let response: Response;
    try {
      response = await fetch(input.downloadUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_FAILED", (error as Error).message);
    }
    if (!response.ok) {
      throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_FAILED", `${response.status} ${response.statusText}`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_DOCUMENT_BYTES) {
      throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(contentLength), { limitBytes: MAX_DOCUMENT_BYTES, sizeBytes: contentLength });
    }
    return readResponseWithLimit(response, MAX_DOCUMENT_BYTES);
  }
  throw new AttachmentStoreError("ATTACHMENT_INVALID_BASE64", "missing base64 or downloadUrl");
}

async function readResponseWithLimit(response: Response, limitBytes: number) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(total), { limitBytes, sizeBytes: total });
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function assertSafeDownloadUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_URL_UNSAFE", "invalid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) {
    throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_URL_UNSAFE", "only credential-free HTTPS URLs are allowed");
  }
  const allowedHosts = new Set((process.env.PORTAL_ATTACHMENT_DOWNLOAD_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_URL_UNSAFE", "download host is not allowlisted");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new AttachmentStoreError("ATTACHMENT_DOWNLOAD_URL_UNSAFE", "download host must resolve only to public addresses");
  }
}

function isPublicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
  }
  const normalized = address.toLowerCase();
  return !(normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:"));
}

function normalizeBase64(value: string) {
  const trimmed = value.trim();
  const raw = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  const compact = raw.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return "";
  const decoded = Buffer.from(compact, "base64");
  return decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === compact.replace(/=+$/, "") ? compact : "";
}

function validateAttachment(input: {
  kind: "image" | "document";
  mimeType: string;
  fileName: string;
  bytes: Buffer;
  detected: DetectedAttachmentFile;
}) {
  const ext = path.extname(path.basename(input.fileName)).toLowerCase();
  const allowedMimes = input.kind === "image" ? ALLOWED_IMAGE_MIME : ALLOWED_DOCUMENT_MIME;
  if (!allowedMimes.has(input.mimeType)) {
    throw new AttachmentStoreError("UNSUPPORTED_ATTACHMENT_MIME", input.mimeType || "-", { mimeType: input.mimeType });
  }
  if (!EXTENSION_MIME[ext]?.includes(input.mimeType)) {
    throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", `${ext || "(no extension)"} vs ${input.mimeType}`, {
      extension: ext,
      mimeType: input.mimeType,
    });
  }
  const maxBytes = input.kind === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (input.bytes.length > maxBytes) {
    throw new AttachmentStoreError("ATTACHMENT_TOO_LARGE", String(input.bytes.length), {
      limitBytes: maxBytes,
      sizeBytes: input.bytes.length,
    });
  }
  if (input.kind === "image" && input.detected.mimeType !== input.mimeType) {
    throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", `magic ${input.detected.mimeType || "unknown"} vs ${input.mimeType}`, {
      detectedMimeType: input.detected.mimeType,
      mimeType: input.mimeType,
    });
  }
  if (input.kind === "document") validateDocumentMagic(input);
}

function validateDocumentMagic(input: {
  mimeType: string;
  bytes: Buffer;
  detected: DetectedAttachmentFile;
}) {
  if (input.mimeType === "application/pdf" && input.detected.mimeType !== "application/pdf") {
    throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", "invalid pdf header");
  }
  if (input.mimeType === "application/msword" || input.mimeType === "application/vnd.ms-powerpoint") {
    if (input.detected.family !== "ole") throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", "invalid ole header");
  }
  if (
    input.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    input.mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    input.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    if (input.detected.family !== "zip") throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", "invalid zip header");
  }
  if (input.mimeType === "application/vnd.ms-excel") {
    if (input.detected.family !== "ole") throw new AttachmentStoreError("ATTACHMENT_MIME_MISMATCH", "invalid ole header");
  }
  if (input.mimeType === "text/html" || input.mimeType === "text/markdown" || input.mimeType === "text/plain" || input.mimeType === "text/csv") {
    if (!looksLikeUtf8Text(input.bytes)) {
      throw new AttachmentStoreError("ATTACHMENT_BINARY_TEXT", "text attachment looks binary");
    }
  }
}

type DetectedAttachmentFile = {
  mimeType?: string;
  extension?: string;
  family?: "image" | "ole" | "zip" | "text";
};

function detectAttachmentBytes(bytes: Buffer): DetectedAttachmentFile {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: "image/png", extension: ".png", family: "image" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg", family: "image" };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mimeType: "image/webp", extension: ".webp", family: "image" };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF") {
    return { mimeType: "application/pdf", extension: ".pdf" };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return { family: "ole" };
  }
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    return { family: "zip" };
  }
  if (looksLikeUtf8Text(bytes)) return { family: "text" };
  return {};
}

function looksLikeUtf8Text(bytes: Buffer) {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return false;
  const decoded = sample.toString("utf8");
  if (decoded.includes("\uFFFD")) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }
  return suspicious <= Math.max(2, sample.length * 0.01);
}

function normalizeMimeType(value?: string) {
  const normalized = String(value || "").split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (normalized === "text/x-markdown" || normalized === "text/md") return "text/markdown";
  return normalized;
}

function inferMimeType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME[ext]?.[0] || null;
}

function inferKind(mimeType: string): "image" | "document" {
  return ALLOWED_IMAGE_MIME.has(mimeType) ? "image" : "document";
}

function extensionForMime(mimeType: string, detectedExtension?: string) {
  if (detectedExtension) return detectedExtension;
  for (const [extension, mimes] of Object.entries(EXTENSION_MIME)) {
    if (mimes[0] === mimeType) return extension;
  }
  return ".bin";
}

function buildRelativeAttachmentPath(id: string, safeName: string) {
  return path.posix.join("attachments", new Date().toISOString().slice(0, 10), `${id}_${safeName}`);
}

function safeFileName(value: string | undefined, fallbackExt: string) {
  const base = path.basename(value || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base) return "";
  const withExt = path.extname(base) ? base : `${base}${fallbackExt}`;
  return withExt.length > 120 ? withExt.slice(-120) : withExt;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
