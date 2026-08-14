#!/usr/bin/env node

/**
 * Idempotently import only a strategy's structured profile projection into a
 * disposable target SQLite database. Rules remain project-file/asset work.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const args = parseArgs(process.argv.slice(2));
const mappingPath = requiredAbsolute(args.mapping, "--mapping");
const targetDbPath = requiredAbsolute(args.targetDb, "--target-db");
const batchId = requiredId(args.batchId, "--batch-id");
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
await assertFile(mappingPath, "mapping report");
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertTargetOutsideSnapshot(targetDbPath, snapshotRoot);

const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
const source = mapping?.source;
const profile = mapping?.mapping?.serviceMigration;
if (!source || !profile || mapping.mode !== "dry_run") throw new Error("mapping must be a strategy mapping dry-run report");
if (!source.userId || !source.instanceId || !profile.fields || !profile.idempotencyKey) throw new Error("mapping is missing scope or profile fields");
if (!source.workspaceId || !source.sourcePath || !source.sha256) throw new Error("mapping is missing source path or checksum");
const sourcePath = path.join(snapshotRoot, source.workspaceId, source.sourcePath);
await assertFile(sourcePath, "strategy source");
const sourceBytes = await readFile(sourcePath);
if (sha256(sourceBytes) !== source.sha256) throw new Error("MASTRA_STRATEGY_SOURCE_CHANGED: source checksum differs from dry-run");
const projectId = args.projectId ? requiredId(args.projectId, "--project-id") : "invest-agent";
const profileJson = JSON.stringify(profile.fields);
const now = new Date().toISOString();
const db = new Database(targetDbPath);
try {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mastra_project_profiles (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      profile_json TEXT NOT NULL, source_path TEXT NOT NULL, source_checksum TEXT NOT NULL,
      source_revision TEXT, migration_batch_id TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id, instance_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mastra_project_profiles_source
      ON mastra_project_profiles(user_id, project_id, instance_id, source_checksum);
  `);
  const existing = db.prepare(
    "SELECT profile_json AS profileJson, source_checksum AS sourceChecksum, source_path AS sourcePath FROM mastra_project_profiles WHERE user_id = ? AND project_id = ? AND instance_id = ?",
  ).get(source.userId, projectId, source.instanceId);
  let action;
  if (!existing) {
    db.prepare(
      "INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(source.userId, projectId, source.instanceId, profileJson, source.sourcePath, source.sha256, profile.fields.sourceRevision, batchId, now, now);
    action = "inserted";
  } else if (existing.sourceChecksum === source.sha256 && existing.profileJson === profileJson && existing.sourcePath === source.sourcePath) {
    action = "replayed";
  } else {
    throw new Error("MASTRA_PROFILE_IMPORT_CONFLICT: target scope already holds a different profile projection");
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM mastra_project_profiles WHERE user_id = ? AND project_id = ? AND instance_id = ?")
    .get(source.userId, projectId, source.instanceId).count;
  console.log(JSON.stringify({
    ok: true, mode: "target_import", action, count, batchId,
    scope: { userId: source.userId, projectId, instanceId: source.instanceId },
    source: { path: source.sourcePath, checksum: source.sha256 },
    profileChecksum: sha256(profileJson),
  }, null, 2));
} finally {
  db.close();
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertTargetOutsideSnapshot(target, snapshotRoot) {
  const root = await realpath(snapshotRoot);
  const candidate = path.join(await realpath(path.dirname(target)), path.basename(target));
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--target-db must be outside the workspace snapshot source");
}
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--mapping", "--target-db", "--batch-id", "--workspace-snapshot", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index];
  }
  return values;
}
