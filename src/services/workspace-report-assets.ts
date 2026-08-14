import { realpath, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveProjectStorageRoot, ProjectStorageRootError } from "./project-storage-root.js";

const REPORT_ROOT = "reports";
const MIME_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const MAX_REPORT_ASSET_BYTES = 15 * 1024 * 1024;

export type WorkspaceReportAsset = {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
};

export class WorkspaceReportAssetError extends Error {
  constructor(
    public readonly code: "REPORT_ASSET_INVALID_PATH" | "REPORT_ASSET_NOT_FOUND" | "REPORT_ASSET_UNSUPPORTED" | "REPORT_ASSET_TOO_LARGE" | "REPORT_ASSET_SCOPE_UNAVAILABLE",
    message: string,
  ) {
    super(`${code}:${message}`);
    this.name = "WorkspaceReportAssetError";
  }
}

/**
 * Reads a user-visible report artifact without ever accepting an absolute
 * workspace path. The resolved target is checked again to reject symlinks
 * escaping the user's reports directory.
 */
export async function readWorkspaceReportAsset(input: {
  userId: string;
  projectId?: string;
  instanceId?: string;
  relativePath: string;
}): Promise<WorkspaceReportAsset> {
  const relativePath = normalizeReportPath(input.relativePath);
  let workspacePath: string;
  try {
    workspacePath = await resolveProjectStorageRoot(input);
  } catch (error) {
    if (error instanceof ProjectStorageRootError) throw new WorkspaceReportAssetError("REPORT_ASSET_SCOPE_UNAVAILABLE", error.message);
    throw error;
  }
  const reportsPath = path.join(workspacePath, REPORT_ROOT);
  const targetPath = path.resolve(workspacePath, relativePath);

  let realReportsPath: string;
  let realTargetPath: string;
  try {
    [realReportsPath, realTargetPath] = await Promise.all([realpath(reportsPath), realpath(targetPath)]);
  } catch {
    throw new WorkspaceReportAssetError("REPORT_ASSET_NOT_FOUND", relativePath);
  }
  if (!isWithin(realReportsPath, realTargetPath)) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_INVALID_PATH", relativePath);
  }

  const extension = path.extname(realTargetPath).toLowerCase();
  const mimeType = MIME_TYPES[extension];
  if (!mimeType) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_UNSUPPORTED", extension || "no extension");
  }
  const fileStat = await stat(realTargetPath);
  if (!fileStat.isFile()) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_NOT_FOUND", relativePath);
  }
  if (fileStat.size > MAX_REPORT_ASSET_BYTES) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_TOO_LARGE", String(fileStat.size));
  }
  const bytes = await readFile(realTargetPath);
  return {
    fileName: path.basename(realTargetPath),
    mimeType,
    sizeBytes: bytes.length,
    base64: bytes.toString("base64"),
  };
}

function normalizeReportPath(value: string) {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || path.posix.isAbsolute(normalized) || !normalized.startsWith(`${REPORT_ROOT}/`)) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_INVALID_PATH", value || "empty");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new WorkspaceReportAssetError("REPORT_ASSET_INVALID_PATH", value);
  }
  return normalized;
}

function isWithin(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}
