import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * SQLite operational helpers shared by the file-retention CLI and any future
 * destructive-gate workflow. Keeping them out of the hot path means the
 * runtime server never accidentally links against backup/quick_check code.
 */

export interface SqliteLike {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
  pragma(pragma: string): unknown;
}

/**
 * Copies the SQLite database file (and its WAL/SHM siblings when present) to a
 * timestamped backup path under `<db dir>/backups/`. Returns the backup path.
 * This is a filesystem-level copy — it does not lock the database, so callers
 * should quiesce writers first (the retention CLI runs offline against a
 * stopped runtime in production).
 */
export async function backupSqliteToFile(db: SqliteLike, options: { suffix?: string; now?: Date } = {}): Promise<string> {
  const now = options.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const suffix = options.suffix ? `-${options.suffix}` : "";
  const dbPath = config.db.path;
  const dir = path.dirname(dbPath);
  const backupDir = path.join(dir, "backups");
  await mkdir(backupDir, { recursive: true });
  const base = path.basename(dbPath);
  const target = path.join(backupDir, `${base}.${stamp}${suffix}.bak`);
  await copyFile(dbPath, target);
  for (const ext of ["-wal", "-shm"]) {
    const side = `${dbPath}${ext}`;
    if (existsSync(side)) {
      await copyFile(side, `${target}${ext}`).catch((error) => {
        logger.warn(`sqlite backup sidecar copy failed (${ext}): ${(error as Error).message}`);
      });
    }
  }
  return target;
}

/**
 * Runs `PRAGMA quick_check` and returns whether the database reports ok. The
 * retention CLI gates the first real cleanup on a passing quick_check.
 */
export async function runSqliteQuickCheck(db: SqliteLike): Promise<{ ok: boolean; raw: unknown }> {
  const rows = db.prepare("PRAGMA quick_check").all() as Array<{ quick_check?: string }>;
  const raw = rows[0]?.quick_check ?? "no-result";
  return { ok: raw === "ok", raw };
}
