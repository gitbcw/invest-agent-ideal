/**
 * Operator CLI for the Portal file-retention governance rollout.
 *
 * Run order (work package §10):
 *   1. `npm run build`
 *   2. `node --import tsx src/scripts/file-retention-backfill.ts backfill --dry-run`
 *      (Phase B: idempotent index writes; no destructive action)
 *   3. `node --import tsx src/scripts/file-retention-backfill.ts backfill --apply`
 *   4. `node --import tsx src/scripts/file-retention-backfill.ts cleanup --dry-run`
 *      (Phase C dry-run: report what WOULD be deleted; never unlink)
 *   5. After explicit operator confirmation + SQLite backup:
 *      `FILE_RETENTION_CLEANUP_ENABLED=true node --import tsx src/scripts/file-retention-backfill.ts cleanup --apply`
 *
 * The cleanup `--apply` step is a material destructive action. The CLI never
 * runs it unless `--apply` is passed AND `FILE_RETENTION_CLEANUP_ENABLED=true`
 * in the environment; otherwise it always behaves as a dry-run.
 */
import "dotenv/config";

import { initDb, sqlite } from "../db/index.js";
import {
  backfillArtifactRetentionClassification,
  backfillAttachmentIndex,
  backfillCuratedWorkspaceReports,
} from "../services/file-retention-backfill.js";
import { cleanupExpiredAttachments as cleanupExpiredAttachmentRows, pruneEmptyAttachmentDateDirs } from "../services/file-retention.js";
import { purgeExpiredArtifactTrash } from "../services/artifact-deletion.js";
import { backupSqliteToFile, runSqliteQuickCheck } from "../lib/sqlite-ops.js";

type Command = "backfill" | "cleanup" | "trash" | "report" | "backup";

function readFlags(): { command: Command; apply: boolean; dryRun: boolean; limit?: number } {
  const [, , rawCommand, ...rest] = process.argv;
  const command = (rawCommand || "") as Command;
  const valid: Command[] = ["backfill", "cleanup", "trash", "report", "backup"];
  if (!valid.includes(command)) {
    const choices = valid.join("|");
    console.error(`Usage: node --import tsx src/scripts/file-retention-backfill.ts <command>\n  command choices: ${choices}\n  flags: [--apply] [--dry-run] [--limit N]`);
    process.exit(2);
  }
  const apply = rest.includes("--apply");
  const dryRun = rest.includes("--dry-run") || !apply;
  const limitIndex = rest.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : undefined;
  return { command, apply, dryRun, limit: Number.isFinite(limit) ? limit : undefined };
}

async function main() {
  const flags = readFlags();
  initDb();

  if (flags.command === "backup") {
    const target = await backupSqliteToFile(sqlite, { suffix: "file-retention" });
    const quickCheck = await runSqliteQuickCheck(sqlite);
    console.log(JSON.stringify({ backup: target, quickCheck }, null, 2));
    return;
  }

  if (flags.command === "report") {
    // COALESCE so empty tables report 0 instead of NULL (SUM over zero rows).
    const attachments = sqlite
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN expires_at <= ? AND deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS expiredPending,
           COALESCE(SUM(CASE WHEN delete_reason = 'cleanup_candidate' THEN 1 ELSE 0 END), 0) AS cleanupCandidates,
           COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted
         FROM conversation_attachments`
      )
      .all(new Date().toISOString())[0];
    const artifacts = sqlite
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN retention_class = 'durable_library' THEN 1 ELSE 0 END), 0) AS durable,
           COALESCE(SUM(CASE WHEN retention_class = 'transient_generated' THEN 1 ELSE 0 END), 0) AS transient,
           COALESCE(SUM(CASE WHEN retention_class = 'reference_only' THEN 1 ELSE 0 END), 0) AS referenceOnly,
           COALESCE(SUM(CASE WHEN retention_class = 'trashed' AND purge_at <= ? THEN 1 ELSE 0 END), 0) AS trashPurgePending,
           COALESCE(SUM(CASE WHEN retention_class IS NULL THEN 1 ELSE 0 END), 0) AS unclassified
         FROM conversation_artifacts`
      )
      .all(new Date().toISOString())[0];
    console.log(JSON.stringify({ attachments, artifacts, cleanupEnabled: process.env.FILE_RETENTION_CLEANUP_ENABLED === "true" }, null, 2));
    return;
  }

  if (flags.command === "backfill") {
    const classification = await backfillArtifactRetentionClassification({ limit: flags.limit, dryRun: flags.dryRun });
    const workspace = await backfillCuratedWorkspaceReports({ dryRun: flags.dryRun });
    const attachments = await backfillAttachmentIndex({ dryRun: flags.dryRun, limit: flags.limit });
    console.log(JSON.stringify({ command: "backfill", apply: flags.apply, classification, workspace, attachments }, null, 2));
    return;
  }

  if (flags.command === "cleanup") {
    if (!flags.apply) {
      const summary = await cleanupExpiredAttachmentRows({ dryRun: true, limit: flags.limit });
      console.log(JSON.stringify({ command: "cleanup", apply: false, summary }, null, 2));
      return;
    }
    if (process.env.FILE_RETENTION_CLEANUP_ENABLED !== "true") {
      console.error("REFUSING_REAL_CLEANUP: set FILE_RETENTION_CLEANUP_ENABLED=true after backup + dry-run + explicit confirmation");
      process.exit(3);
    }
    const summary = await cleanupExpiredAttachmentRows({ limit: flags.limit });
    await pruneEmptyAttachmentDateDirs({}).catch(() => undefined);
    console.log(JSON.stringify({ command: "cleanup", apply: true, summary }, null, 2));
    return;
  }

  if (flags.command === "trash") {
    if (!flags.apply) {
      const summary = await purgeExpiredArtifactTrash({ dryRun: true, limit: flags.limit });
      console.log(JSON.stringify({ command: "trash", apply: false, summary }, null, 2));
      return;
    }
    if (process.env.FILE_RETENTION_CLEANUP_ENABLED !== "true") {
      console.error("REFUSING_REAL_PURGE: set FILE_RETENTION_CLEANUP_ENABLED=true after backup + dry-run + explicit confirmation");
      process.exit(3);
    }
    const summary = await purgeExpiredArtifactTrash({ limit: flags.limit });
    console.log(JSON.stringify({ command: "trash", apply: true, summary }, null, 2));
    return;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
