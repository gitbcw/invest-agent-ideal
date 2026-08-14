#!/usr/bin/env node

/**
 * Read-only verification for a composed migration target.
 * The target must already have been imported by the domain-specific scripts.
 * This verifier never opens the backup source and never writes the target.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const args = parseArgs(process.argv.slice(2));
const targetDb = requiredAbsolute(args.targetDb, "--target-db");
const targetProjectRoot = requiredAbsolute(args.targetProjectRoot, "--target-project-root");
const userId = requiredId(args.userId, "--user-id");
const projectId = requiredId(args.projectId || "invest-agent", "--project-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
await assertRegularFile(targetDb, "target database");
await assertDirectory(targetProjectRoot, "target project root");

const db = new Database(targetDb, { readonly: true });
try {
  const scope = [userId, projectId, instanceId];
  const profile = one(db, "SELECT profile_json AS profileJson, source_checksum AS sourceChecksum FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=?", scope);
  const portfolio = one(db, "SELECT portfolio_json AS portfolioJson, source_checksum AS sourceChecksum FROM mastra_portfolio_states WHERE user_id=? AND project_id=? AND instance_id=?", scope);
  const preferences = one(db, "SELECT preferences_json AS preferencesJson, source_checksums_json AS sourceChecksumsJson, source_revision AS sourceRevision FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=?", scope);
  const reviewCount = count(db, "SELECT COUNT(*) AS count FROM mastra_review_memory_records WHERE user_id=? AND project_id=? AND instance_id=?", scope);
  const assetRows = db.prepare("SELECT source_path AS sourcePath, checksum, target_path AS targetPath, executable FROM mastra_workspace_asset_records WHERE user_id=? AND project_id=? AND instance_id=? ORDER BY source_path").all(...scope);
  if (!profile || !portfolio || !preferences) throw new Error("MASTRA_TARGET_COLD_START_INCOMPLETE: missing one or more service projections");
  if (preferences.sourceRevision === null || preferences.sourceRevision === undefined) throw new Error("MASTRA_TARGET_COLD_START_INCOMPLETE: preferences revision missing");
  if (JSON.parse(preferences.preferencesJson).schedulerActivation !== "disabled_until_target_cold_start_and_explicit_enable") {
    throw new Error("MASTRA_TARGET_SCHEDULER_NOT_DISABLED");
  }
  if (reviewCount <= 0) throw new Error("MASTRA_TARGET_COLD_START_INCOMPLETE: review/memory ledger is empty");
  if (assetRows.length === 0) throw new Error("MASTRA_TARGET_COLD_START_INCOMPLETE: asset ledger is empty");
  const executableRows = assetRows.filter((row) => row.executable !== 0);
  if (executableRows.length > 0) throw new Error(`MASTRA_TARGET_EXECUTABLE_ASSET: ${executableRows[0].sourcePath}`);
  const files = [];
  for (const row of assetRows) {
    if (!isSafeRelative(row.targetPath)) throw new Error(`MASTRA_TARGET_PATH_INVALID: ${row.sourcePath}`);
    const targetPath = path.join(targetProjectRoot, row.targetPath);
    const bytes = await readFile(targetPath).catch(() => { throw new Error(`MASTRA_TARGET_ASSET_MISSING: ${row.sourcePath}`); });
    const checksum = sha256(bytes);
    if (checksum !== row.checksum) throw new Error(`MASTRA_TARGET_ASSET_CHECKSUM_MISMATCH: ${row.sourcePath}`);
    const mode = (await lstat(targetPath)).mode;
    if ((mode & 0o111) !== 0) throw new Error(`MASTRA_TARGET_ASSET_EXECUTABLE_BIT: ${row.sourcePath}`);
    files.push({ sourcePath: row.sourcePath, targetPath: row.targetPath, checksum });
  }
  console.log(JSON.stringify({
    ok: true,
    mode: "target_cold_start_verify",
    scope: { userId, projectId, instanceId },
    projections: { profile: true, portfolio: true, runtimePreferences: true, reviewMemoryRecords: reviewCount },
    assets: { recordCount: assetRows.length, executableRows: 0, files },
    schedulerActivation: JSON.parse(preferences.preferencesJson).schedulerActivation,
    readOnly: true,
  }, null, 2));
} finally {
  db.close();
}

function one(db, sql, params) { return db.prepare(sql).get(...params); }
function count(db, sql, params) { return Number(one(db, sql, params).count); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function isSafeRelative(value) { return typeof value === "string" && value.length > 0 && !path.posix.isAbsolute(value) && !value.split("/").some((part) => !part || part === "." || part === "..") && !value.includes("\\"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertRegularFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--target-db", "--target-project-root", "--user-id", "--project-id", "--instance-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
