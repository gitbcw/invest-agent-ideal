import { readdir, lstat, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";

const DEFAULT_RETENTION_DAYS = 3;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredAttachments(input: { workspaceRoot?: string; now?: number; retentionDays?: number } = {}) {
  const root = input.workspaceRoot ?? config.workspace.root;
  const cutoff = (input.now ?? Date.now()) - (input.retentionDays ?? DEFAULT_RETENTION_DAYS) * 86_400_000;
  const result = { deletedFiles: 0, deletedBytes: 0, errors: 0 };
  let workspaces;
  try { workspaces = await readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const workspace of workspaces) {
    if (workspace.isDirectory() && !workspace.isSymbolicLink()) {
      await cleanup(path.join(root, workspace.name, "attachments"), cutoff, result);
    }
  }
  return result;
}

export function startAttachmentRetentionCleanup() {
  stopAttachmentRetentionCleanup();
  const run = () => void cleanupExpiredAttachments().then((result) => {
    if (result.deletedFiles || result.errors) logger.info(`attachment cleanup deleted=${result.deletedFiles} errors=${result.errors}`);
  });
  run();
  cleanupTimer = setInterval(run, CLEANUP_INTERVAL_MS);
}

export function stopAttachmentRetentionCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

async function cleanup(directory: string, cutoff: number, result: { deletedFiles: number; deletedBytes: number; errors: number }) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await cleanup(target, cutoff, result);
      await rmdir(target).catch(() => {});
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const details = await lstat(target);
      if (details.mtimeMs < cutoff) {
        await rm(target, { force: true });
        result.deletedFiles += 1;
        result.deletedBytes += details.size;
      }
    } catch { result.errors += 1; }
  }
}
