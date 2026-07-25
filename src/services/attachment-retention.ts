import { cleanupExpiredAttachments as cleanupExpiredAttachmentRows, pruneEmptyAttachmentDateDirs } from "./file-retention.js";
import { logger } from "../lib/logger.js";

/**
 * @deprecated Retention is now driven by the authoritative
 * `conversation_attachments` table in `./file-retention.ts`. This module is
 * kept only so existing call sites (`src/index.ts`) keep importing a stable
 * symbol; the actual cleanup delegates to the table-based implementation.
 *
 * The old 3-day mtime sweep is gone. The new loop:
 *  - runs the table-based attachment cleanup (7-day `expires_at`);
 *  - prunes now-empty `attachments/YYYY-MM-DD/` directories as a best-effort
 *    cosmetic step.
 *
 * The first real production cleanup still requires an explicit operator
 * confirmation — see
 * `docs/portal-file-retention-and-library-governance-work-package.md` §10.C.
 * Until that confirmation is given, `startAttachmentRetentionCleanup` is a
 * no-op so the daily job cannot fire prematurely. Flip
 * `FILE_RETENTION_CLEANUP_ENABLED=true` once the dry-run + backup + confirm
 * gate has been satisfied.
 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export async function cleanupExpiredAttachments() {
  if (process.env.FILE_RETENTION_CLEANUP_ENABLED !== "true") {
    return { deletedFiles: 0, deletedBytes: 0, errors: 0, skipped: true as const };
  }
  const summary = await cleanupExpiredAttachmentRows({});
  await pruneEmptyAttachmentDateDirs({}).catch((error) => {
    logger.warn(`attachment date-dir prune failed: ${(error as Error).message}`);
  });
  if (summary.deletedFiles || summary.errors) {
    logger.info(`attachment cleanup deleted=${summary.deletedFiles} bytes=${summary.deletedBytes} missing=${summary.missing} errors=${summary.errors}`);
  }
  return {
    deletedFiles: summary.deletedFiles,
    deletedBytes: summary.deletedBytes,
    errors: summary.errors,
    skipped: false as const,
  };
}

export function startAttachmentRetentionCleanup() {
  stopAttachmentRetentionCleanup();
  const enabled = process.env.FILE_RETENTION_CLEANUP_ENABLED === "true";
  if (!enabled) {
    logger.info("attachment cleanup disabled (FILE_RETENTION_CLEANUP_ENABLED != true); run dry-run + confirm before enabling");
    return;
  }
  const run = () => void cleanupExpiredAttachments();
  cleanupTimer = setInterval(run, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}

export function stopAttachmentRetentionCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}
