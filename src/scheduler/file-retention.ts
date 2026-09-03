import { logger } from "../lib/logger.js";
import { beijingDateKey } from "../lib/schedules-loader.js";
import { claimScheduledTaskRun, finishScheduledTaskRun } from "../services/scheduled-task-runs.js";
import { cleanupExpiredAttachments as cleanupExpiredAttachmentRows, pruneEmptyAttachmentDateDirs } from "../services/file-retention.js";
import { purgeExpiredArtifactTrash } from "../services/artifact-deletion.js";
import { purgeExpiredAutomationToolPayloads } from "../services/trace-payload-retention.js";

/**
 * Daily file-retention jobs. Two independent, lock-protected loops:
 *
 *  1. Attachment expiry — deletes bytes for `conversation_attachments` rows
 *     whose 7-day `expires_at` has passed. Disabled until an operator has run
 *     the dry-run + backup + explicit-confirmation gate (work package §10.C).
 *     Gated by `FILE_RETENTION_CLEANUP_ENABLED=true`.
 *
 *  2. Trash purge — physically removes artifact files that the user soft-deleted
 *     more than 30 days ago. Same gate applies on first run.
 *
 * Both jobs claim a `scheduled_task_runs` row before doing work so two Runtime
 * processes cannot purge the same batch concurrently. A missing file is always
 * treated as idempotent success.
 */

const FILE_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const TRASH_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const TRACE_PAYLOAD_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

let attachmentTimer: ReturnType<typeof setInterval> | null = null;
let trashTimer: ReturnType<typeof setInterval> | null = null;
let tracePayloadTimer: ReturnType<typeof setInterval> | null = null;

export function startFileRetentionScheduler(): void {
  stopFileRetentionScheduler();
  attachmentTimer = setInterval(() => {
    void runAttachmentCleanup().catch((error) => logger.error(`file-retention attachment cleanup failed: ${(error as Error).message}`));
  }, FILE_RETENTION_INTERVAL_MS);
  attachmentTimer.unref?.();
  trashTimer = setInterval(() => {
    void runTrashPurge().catch((error) => logger.error(`file-retention trash purge failed: ${(error as Error).message}`));
  }, TRASH_PURGE_INTERVAL_MS);
  trashTimer.unref?.();
  tracePayloadTimer = setInterval(() => {
    void runTracePayloadRetention().catch((error) => logger.error(`trace-payload retention failed: ${(error as Error).message}`));
  }, TRACE_PAYLOAD_RETENTION_INTERVAL_MS);
  tracePayloadTimer.unref?.();
  logger.info("file-retention scheduler started (attachment cleanup + trash purge; both gated by FILE_RETENTION_CLEANUP_ENABLED; trace-payload retention on by default)");
}

export function stopFileRetentionScheduler(): void {
  if (attachmentTimer) clearInterval(attachmentTimer);
  if (trashTimer) clearInterval(trashTimer);
  if (tracePayloadTimer) clearInterval(tracePayloadTimer);
  attachmentTimer = null;
  trashTimer = null;
  tracePayloadTimer = null;
}

/**
 * T-459：TRACE 载荷 90 天滚动清理。与上面两个文件级清理不同，它只删
 * automation_tool_payloads 观测行，非破坏性，默认启用；kill switch 为
 * TRACE_PAYLOAD_RETENTION_ENABLED=false。
 */
export async function runTracePayloadRetention(input: { now?: Date; limit?: number } = {}): Promise<{
  ran: boolean;
  summary: { retentionDays: number; cutoff: string; deleted: number } | null;
}> {
  if (process.env.TRACE_PAYLOAD_RETENTION_ENABLED === "false") return { ran: false, summary: null };
  const now = input.now ?? new Date();
  const dateKey = beijingDateKey(now);
  const taskKey = `trace-payload-retention:${dateKey}`;
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: "trace_payload_retention",
    scheduledFor: now.toISOString(),
  });
  if (!claimed) return { ran: false, summary: null };
  try {
    const summary = purgeExpiredAutomationToolPayloads({ now, limit: input.limit });
    await finishScheduledTaskRun(taskKey, { status: "success" });
    return { ran: true, summary };
  } catch (error) {
    await finishScheduledTaskRun(taskKey, { status: "error", errorMessage: (error as Error).message });
    throw error;
  }
}

export async function runAttachmentCleanup(input: { now?: Date; dryRun?: boolean; limit?: number } = {}): Promise<{
  ran: boolean;
  summary: { deletedFiles: number; deletedBytes: number; missing: number; errors: number; scanned: number } | null;
}> {
  if (process.env.FILE_RETENTION_CLEANUP_ENABLED !== "true" && !input.dryRun) {
    return { ran: false, summary: null };
  }
  const now = input.now ?? new Date();
  const dateKey = beijingDateKey(now);
  const taskKey = `file-retention:attachments:${dateKey}:${input.dryRun ? "dryrun" : "default"}`;
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: "file_retention_attachment_cleanup",
    scheduledFor: now.toISOString(),
  });
  if (!claimed) {
    return { ran: false, summary: null };
  }
  try {
    const summary = await cleanupExpiredAttachmentRows({ now, dryRun: input.dryRun, limit: input.limit });
    if (!input.dryRun) {
      await pruneEmptyAttachmentDateDirs({ now }).catch((error) => {
        logger.warn(`attachment date-dir prune failed: ${(error as Error).message}`);
      });
    }
    await finishScheduledTaskRun(taskKey, {
      status: summary.errors > 0 ? "error" : "success",
      errorMessage: summary.errors > 0 ? `${summary.errors} cleanup errors` : undefined,
    });
    return { ran: true, summary };
  } catch (error) {
    await finishScheduledTaskRun(taskKey, { status: "error", errorMessage: (error as Error).message });
    throw error;
  }
}

export async function runTrashPurge(input: { now?: Date; dryRun?: boolean; limit?: number } = {}): Promise<{
  ran: boolean;
  summary: { scanned: number; purgedFiles: number; purgedBytes: number; missing: number; errors: number } | null;
}> {
  if (process.env.FILE_RETENTION_CLEANUP_ENABLED !== "true" && !input.dryRun) {
    return { ran: false, summary: null };
  }
  const now = input.now ?? new Date();
  const dateKey = beijingDateKey(now);
  const taskKey = `file-retention:trash:${dateKey}:${input.dryRun ? "dryrun" : "default"}`;
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: "file_retention_trash_purge",
    scheduledFor: now.toISOString(),
  });
  if (!claimed) {
    return { ran: false, summary: null };
  }
  try {
    const summary = await purgeExpiredArtifactTrash({ now, dryRun: input.dryRun, limit: input.limit });
    await finishScheduledTaskRun(taskKey, {
      status: summary.errors > 0 ? "error" : "success",
      errorMessage: summary.errors > 0 ? `${summary.errors} purge errors` : undefined,
    });
    return { ran: true, summary };
  } catch (error) {
    await finishScheduledTaskRun(taskKey, { status: "error", errorMessage: (error as Error).message });
    throw error;
  }
}
