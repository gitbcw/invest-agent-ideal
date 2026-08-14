#!/usr/bin/env node

/** Import daily/review/memory dry-run data into an isolated target ledger. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const mappingPath = requiredAbsolute(args.mapping, "--mapping");
const targetDbPath = requiredAbsolute(args.targetDb, "--target-db");
const targetProjectRoot = requiredAbsolute(args.targetProjectRoot, "--target-project-root");
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const batchId = requiredId(args.batchId, "--batch-id");
const projectId = args.projectId ? requiredId(args.projectId, "--project-id") : "invest-agent";
await assertFile(mappingPath, "mapping report");
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutsideSnapshot(targetDbPath, snapshotRoot, "--target-db");
await assertOutsideSnapshot(targetProjectRoot, snapshotRoot, "--target-project-root");
await mkdir(path.dirname(targetDbPath), { recursive: true, mode: 0o700 });
await mkdir(targetProjectRoot, { recursive: true, mode: 0o700 });

const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
const source = mapping?.source;
if (mapping?.mode !== "dry_run" || !source?.workspaceId || !source?.userId || !source?.instanceId) throw new Error("mapping must be a review memory dry-run report");
const entries = await collectEntries();
const expectedFiles = [...(mapping.mapping?.dailyPlans?.entries ?? []).map((entry) => entry.relativePath), ...(mapping.mapping?.memory ?? []).map((entry) => entry.relativePath)].sort();
const files = expectedFiles;

const db = new Database(targetDbPath);
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mastra_review_memory_records (
      record_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      instance_id TEXT NOT NULL, record_type TEXT NOT NULL, business_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, source_path TEXT NOT NULL, source_line INTEGER,
      source_checksum TEXT NOT NULL, migration_batch_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mastra_review_memory_scope_key
      ON mastra_review_memory_records(user_id, project_id, instance_id, record_type, business_key);
    CREATE TABLE IF NOT EXISTS user_assets (
      asset_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      instance_id TEXT NOT NULL, folder_id TEXT, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', current_version_id TEXT,
      archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_asset_versions (
      version_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, user_id TEXT NOT NULL,
      project_id TEXT NOT NULL, instance_id TEXT NOT NULL, version_number INTEGER NOT NULL DEFAULT 1,
      file_name TEXT NOT NULL, format TEXT NOT NULL, mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, checksum TEXT NOT NULL, storage_path TEXT NOT NULL,
      source TEXT NOT NULL, conversation_id TEXT, task_id TEXT, run_id TEXT,
      parent_version_id TEXT, idempotency_key TEXT, idempotency_fingerprint TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const existing = db.prepare("SELECT record_id AS recordId,record_type AS recordType,business_key AS businessKey,payload_json AS payloadJson,source_path AS sourcePath,source_line AS sourceLine,source_checksum AS sourceChecksum FROM mastra_review_memory_records WHERE user_id=? AND project_id=? AND instance_id=?").all(source.userId, projectId, source.instanceId);
  const existingByKey = new Map(existing.map((row) => [`${row.recordType}\0${row.businessKey}`, row]));
  for (const entry of entries) {
    const row = existingByKey.get(`${entry.recordType}\0${entry.businessKey}`);
    if (row && (row.payloadJson !== entry.payloadJson || row.sourcePath !== entry.sourcePath || row.sourceLine !== entry.sourceLine || row.sourceChecksum !== entry.sourceChecksum)) throw new Error(`MASTRA_REVIEW_MEMORY_IMPORT_CONFLICT: ${entry.recordType}/${entry.businessKey}`);
  }
  if (existing.length > 0 && existing.length !== entries.length) throw new Error("MASTRA_REVIEW_MEMORY_IMPORT_CONFLICT: target record count differs");
  const existingAssets = db.prepare("SELECT a.asset_id AS assetId,a.current_version_id AS currentVersionId,v.checksum,v.storage_path AS storagePath,v.idempotency_key AS idempotencyKey FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id WHERE a.user_id=? AND a.project_id=? AND a.instance_id=?").all(source.userId, projectId, source.instanceId);
  const assetByPath = new Map(existingAssets.map((row) => [row.storagePath, row]));
  const assetFiles = await Promise.all(files.map(async (relativePath) => ({ relativePath, bytes: await readFile(path.join(snapshotRoot, source.workspaceId, relativePath)), checksum: sha256(await readFile(path.join(snapshotRoot, source.workspaceId, relativePath))) })));
  for (const file of assetFiles) {
    const assetPath = assetPathFor(source, projectId, file.relativePath, file.checksum);
    const row = assetByPath.get(assetPath);
    const targetBytes = await readOptional(path.join(targetProjectRoot, assetPath));
    if (row && (row.checksum !== file.checksum || row.idempotencyKey !== `workspace-migration:review-memory:${file.checksum}` || !targetBytes?.equals(file.bytes))) throw new Error(`MASTRA_REVIEW_MEMORY_IMPORT_CONFLICT: asset/${file.relativePath}`);
  }
  if (existing.length === entries.length && existingAssets.length === assetFiles.length && assetFiles.every((file) => assetByPath.has(assetPathFor(source, projectId, file.relativePath, file.checksum)))) {
    console.log(JSON.stringify(result("replayed", entries, assetFiles), null, 2));
  } else {
    const now = new Date().toISOString();
    const written = [];
    try {
      for (const file of assetFiles) { const target = path.join(targetProjectRoot, assetPathFor(source, projectId, file.relativePath, file.checksum)); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, file.bytes, { flag: "wx", mode: 0o600 }); written.push(target); }
      db.transaction(() => {
        for (const entry of entries) db.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_line,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(entry.recordId, source.userId, projectId, source.instanceId, entry.recordType, entry.businessKey, entry.payloadJson, entry.sourcePath, entry.sourceLine, entry.sourceChecksum, batchId, now);
        for (const file of assetFiles) { const assetId = assetIdFor(source, projectId, file.relativePath); const versionId = versionIdFor(file.checksum); const assetPath = assetPathFor(source, projectId, file.relativePath, file.checksum); const key = `workspace-migration:review-memory:${file.checksum}`; db.prepare("INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,folder_id,name,status,current_version_id,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(assetId, source.userId, projectId, source.instanceId, null, path.basename(file.relativePath), "active", versionId, null, now, now); db.prepare("INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,conversation_id,task_id,run_id,parent_version_id,idempotency_key,idempotency_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(versionId, assetId, source.userId, projectId, source.instanceId, 1, path.basename(file.relativePath), path.extname(file.relativePath).slice(1) || "jsonl", "application/jsonl", file.bytes.length, file.checksum, assetPath, "workspace_migration", null, null, null, null, key, sha256(`${key}\0${file.checksum}`), now); }
      })();
    } catch (error) { for (const target of written) await unlink(target).catch(() => undefined); throw error; }
    console.log(JSON.stringify(result("inserted", entries, assetFiles), null, 2));
  }
} finally { db.close(); }

async function collectEntries() {
  const out = [];
  const planEntries = mapping.mapping.dailyPlans.entries;
  for (const plan of planEntries) { const raw = await readFile(path.join(snapshotRoot, source.workspaceId, plan.relativePath)); if (sha256(raw) !== plan.sha256) throw new Error(`MASTRA_REVIEW_MEMORY_SOURCE_CHANGED: ${plan.relativePath}`); const value = parse(raw.toString("utf8")); out.push({ recordId: `daily-plan:${plan.planDate}`, recordType: "daily_plan", businessKey: plan.planDate, payloadJson: JSON.stringify(value), sourcePath: plan.relativePath, sourceLine: null, sourceChecksum: plan.sha256 }); }
  for (const memory of mapping.mapping.memory) { const raw = await readFile(path.join(snapshotRoot, source.workspaceId, memory.relativePath)); if (sha256(raw) !== memory.sha256) throw new Error(`MASTRA_REVIEW_MEMORY_SOURCE_CHANGED: ${memory.relativePath}`); const lines = raw.toString().split(/\r?\n/).filter(Boolean); lines.forEach((line, index) => { const payload = JSON.parse(line); const lineHash = sha256(line); out.push({ recordId: `memory:${memory.relativePath}:${index + 1}:${lineHash.slice(0, 16)}`, recordType: memory.disposition, businessKey: `${memory.relativePath}:${index + 1}:${lineHash}`, payloadJson: JSON.stringify(payload), sourcePath: memory.relativePath, sourceLine: index + 1, sourceChecksum: memory.sha256 }); }); }
  return out;
}
function result(action, entries, assets) { return { ok: true, mode: "target_import", action, batchId, scope: { userId: source.userId, projectId, instanceId: source.instanceId }, recordCount: entries.length, assetCount: assets.length, dailyPlanCount: entries.filter((entry) => entry.recordType === "daily_plan").length, historyDoesNotCreateAutomationTasks: true }; }
function assetIdFor(sourceValue, project, relativePath) { return `asset_review_${sha256(`${sourceValue.userId}\0${project}\0${sourceValue.instanceId}\0${relativePath}`).slice(0, 24)}`; }
function versionIdFor(checksum) { return `version_review_${checksum.slice(0, 24)}`; }
function assetPathFor(sourceValue, project, relativePath, checksum) { return `assets/${assetIdFor(sourceValue, project, relativePath)}/versions/${versionIdFor(checksum)}/${path.basename(relativePath)}`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function readOptional(value) { try { return await readFile(value); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function assertOutsideSnapshot(target, root, flag) { const canonicalRoot = await realpath(root); const candidate = await canonicalFuturePath(target); const relative = path.relative(canonicalRoot, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error(`${flag} must be outside the workspace snapshot source`); }
async function canonicalFuturePath(target) { const tail = []; let current = target; while (true) { try { return path.join(await realpath(current), ...tail.reverse()); } catch (error) { if (error?.code !== "ENOENT") throw error; const parent = path.dirname(current); if (parent === current) throw error; tail.push(path.basename(current)); current = parent; } } }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--mapping", "--target-db", "--target-project-root", "--batch-id", "--workspace-snapshot", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
