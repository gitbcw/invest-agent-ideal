import { createHash } from "node:crypto";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { resolveWorkspacePath } from "../lib/workspace.js";

const MAX_LISTED_FILES = 5_000;
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".state",
  ".trash",
  "node_modules",
  "cache",
  "dist",
  "build",
  "coverage",
  "logs",
  "tmp",
  "temp",
]);

const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "auth.json",
]);

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".py": "text/x-python",
  ".toml": "text/plain",
  ".ini": "text/plain",
  ".conf": "text/plain",
  ".properties": "text/plain",
  ".xml": "text/xml",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".h": "text/x-c",
  ".cpp": "text/x-c++",
  ".vue": "text/plain",
  ".svelte": "text/plain",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export type WorkspaceFilePreviewMode = "markdown" | "html" | "image" | "pdf" | "text" | "table" | "unsupported";

export type WorkspaceFileItem = {
  fileId: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  previewMode: WorkspaceFilePreviewMode;
  downloadable: boolean;
};

export type WorkspaceFilePayload = WorkspaceFileItem & {
  base64: string;
  checksum: string;
};

export class WorkspaceFileError extends Error {
  constructor(
    public readonly code:
      | "WORKSPACE_FILE_INVALID_PATH"
      | "WORKSPACE_FILE_NOT_FOUND"
      | "WORKSPACE_FILE_FORBIDDEN"
      | "WORKSPACE_FILE_TOO_LARGE"
      | "WORKSPACE_FILE_LIMIT_EXCEEDED",
    message: string,
  ) {
    super(`${code}:${message}`);
    this.name = "WorkspaceFileError";
  }
}

export async function listWorkspaceFiles(input: { userId: string }): Promise<{ items: WorkspaceFileItem[] }> {
  const workspacePath = resolveWorkspacePath(input.userId);
  const realWorkspacePath = await realpath(workspacePath).catch(() => {
    throw new WorkspaceFileError("WORKSPACE_FILE_NOT_FOUND", "workspace");
  });
  const items: WorkspaceFileItem[] = [];

  await walk(realWorkspacePath, "", items);
  items.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-CN"));
  return { items };
}

export async function readWorkspaceFile(input: { userId: string; relativePath: string }): Promise<WorkspaceFilePayload> {
  const relativePath = normalizeRelativePath(input.relativePath);
  assertVisiblePath(relativePath);
  const workspacePath = resolveWorkspacePath(input.userId);
  const targetPath = path.resolve(workspacePath, relativePath);

  const rawTargetStat = await lstat(targetPath).catch(() => null);
  if (!rawTargetStat) throw new WorkspaceFileError("WORKSPACE_FILE_NOT_FOUND", relativePath);
  if (rawTargetStat.isSymbolicLink()) {
    throw new WorkspaceFileError("WORKSPACE_FILE_FORBIDDEN", relativePath);
  }

  let realWorkspacePath: string;
  let realTargetPath: string;
  try {
    [realWorkspacePath, realTargetPath] = await Promise.all([realpath(workspacePath), realpath(targetPath)]);
  } catch {
    throw new WorkspaceFileError("WORKSPACE_FILE_NOT_FOUND", relativePath);
  }
  if (!isWithin(realWorkspacePath, realTargetPath)) {
    throw new WorkspaceFileError("WORKSPACE_FILE_FORBIDDEN", relativePath);
  }

  const fileStat = await lstat(realTargetPath);
  if (!fileStat.isFile()) {
    throw new WorkspaceFileError("WORKSPACE_FILE_NOT_FOUND", relativePath);
  }
  if (fileStat.size > MAX_PREVIEW_BYTES) {
    throw new WorkspaceFileError("WORKSPACE_FILE_TOO_LARGE", String(fileStat.size));
  }

  const item = describeFile(relativePath, fileStat.size, fileStat.mtime.toISOString());
  if (!isBrowsableWorkspaceFile(item)) {
    throw new WorkspaceFileError("WORKSPACE_FILE_FORBIDDEN", relativePath);
  }
  const bytes = await readFile(realTargetPath);
  return {
    ...item,
    base64: bytes.toString("base64"),
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function walk(rootPath: string, relativeDirectory: string, items: WorkspaceFileItem[]): Promise<void> {
  const absoluteDirectory = path.join(rootPath, relativeDirectory);
  const directory = await opendir(absoluteDirectory);
  for await (const entry of directory) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll(path.sep, "/"), entry.name);
    if (!isVisiblePath(relativePath, entry.isDirectory())) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(rootPath, relativePath, items);
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await lstat(path.join(rootPath, relativePath));
    const item = describeFile(relativePath, fileStat.size, fileStat.mtime.toISOString());
    if (!isBrowsableWorkspaceFile(item)) continue;
    items.push(item);
    if (items.length > MAX_LISTED_FILES) {
      throw new WorkspaceFileError("WORKSPACE_FILE_LIMIT_EXCEEDED", String(MAX_LISTED_FILES));
    }
  }
}

function describeFile(relativePath: string, sizeBytes: number, updatedAt: string): WorkspaceFileItem {
  const extension = path.posix.extname(relativePath).toLowerCase();
  // Workspace source/config files often use uncommon or no extensions. Treat
  // unknown formats as text; known binary formats above keep dedicated modes.
  const mimeType = MIME_TYPES[extension] ?? "text/plain";
  return {
    fileId: createHash("sha256").update(relativePath).digest("hex").slice(0, 24),
    relativePath,
    fileName: path.posix.basename(relativePath),
    mimeType,
    sizeBytes,
    updatedAt,
    previewMode: previewModeFor(mimeType),
    downloadable: sizeBytes <= MAX_PREVIEW_BYTES,
  };
}

function previewModeFor(mimeType: string): WorkspaceFilePreviewMode {
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "text/html") return "html";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "text/csv" || mimeType === "text/tab-separated-values") return "table";
  if (mimeType.startsWith("text/") || mimeType.includes("json") || mimeType.includes("yaml")) return "text";
  return "unsupported";
}

function isBrowsableWorkspaceFile(item: WorkspaceFileItem): boolean {
  // YAML is workspace configuration, so expose it only through the existing
  // escaped plain-text preview. Other source/text formats remain excluded.
  return item.previewMode === "markdown"
    || item.previewMode === "html"
    || item.previewMode === "image"
    || item.mimeType === "application/yaml";
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized)) {
    throw new WorkspaceFileError("WORKSPACE_FILE_INVALID_PATH", value || "empty");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new WorkspaceFileError("WORKSPACE_FILE_INVALID_PATH", value);
  }
  return normalized;
}

function assertVisiblePath(relativePath: string): void {
  if (!isVisiblePath(relativePath, false)) {
    throw new WorkspaceFileError("WORKSPACE_FILE_FORBIDDEN", relativePath);
  }
}

function isVisiblePath(relativePath: string, directory: boolean): boolean {
  const segments = relativePath.split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment))) return false;
  if (segments.some((segment) => segment.startsWith("."))) return false;
  if (directory) return true;
  const fileName = segments.at(-1)?.toLowerCase() ?? "";
  if (EXCLUDED_FILE_NAMES.has(fileName) || fileName.startsWith(".env.")) return false;
  if (/\.(pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i.test(fileName)) return false;
  return true;
}

function isWithin(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
