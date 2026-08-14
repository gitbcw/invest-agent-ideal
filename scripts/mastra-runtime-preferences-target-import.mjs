#!/usr/bin/env node

/** Import runtime preference mapping into an isolated target, with source assets. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

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
const migration = mapping?.mapping?.serviceMigration;
if (mapping?.mode !== "dry_run" || !source || !migration?.fields || !migration?.sourceChecksums) throw new Error("mapping must be a runtime preferences dry-run report");
if (!source.userId || !source.instanceId || !source.workspaceId) throw new Error("mapping is missing source scope");

const files = Object.entries(source.files).map(([relativePath, metadata]) => ({ relativePath, metadata, sourcePath: path.join(snapshotRoot, source.workspaceId, relativePath) }));
for (const file of files) {
  await assertFile(file.sourcePath, file.relativePath);
  const bytes = await readFile(file.sourcePath);
  if (sha256(bytes) !== file.metadata.sha256 || migration.sourceChecksums[file.relativePath] !== file.metadata.sha256) throw new Error(`MASTRA_RUNTIME_PREFERENCES_SOURCE_CHANGED: ${file.relativePath}`);
  file.bytes = bytes;
}
const preferencesJson = JSON.stringify(migration.fields);
const now = new Date().toISOString();

const db = new Database(targetDbPath);
try {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mastra_runtime_preferences (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      preferences_json TEXT NOT NULL, source_checksums_json TEXT NOT NULL,
      source_revision TEXT, migration_batch_id TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id, instance_id)
    );
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
  const existing = db.prepare("SELECT preferences_json AS preferencesJson, source_checksums_json AS checksumsJson, source_revision AS sourceRevision FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=?").get(source.userId, projectId, source.instanceId);
  const existingAssets = files.map((file) => {
    const assetId = assetIdFor(source, projectId, file.relativePath);
    return db.prepare(`SELECT a.current_version_id AS currentVersionId, v.checksum, v.storage_path AS storagePath, v.idempotency_key AS idempotencyKey FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id WHERE a.asset_id=? AND a.user_id=? AND a.project_id=? AND a.instance_id=?`).get(assetId, source.userId, projectId, source.instanceId);
  });
  const existingBytes = await Promise.all(files.map((file) => readOptional(path.join(targetProjectRoot, assetPathFor(source, projectId, file.relativePath)))));
  const stateMatches = existing && existing.preferencesJson === preferencesJson && existing.checksumsJson === JSON.stringify(migration.sourceChecksums) && existing.sourceRevision === migration.fields.sourceRevision;
  const assetsMatch = files.every((file, index) => {
    const asset = existingAssets[index];
    const assetId = assetIdFor(source, projectId, file.relativePath);
    const versionId = versionIdFor(file.metadata.sha256);
    return asset && asset.currentVersionId === versionId && asset.checksum === file.metadata.sha256 && asset.storagePath === assetPathFor(source, projectId, file.relativePath) && asset.idempotencyKey === `workspace-migration:runtime-preferences:${file.metadata.sha256}` && existingBytes[index]?.equals(file.bytes);
  });
  if ((existing || existingAssets.some(Boolean) || existingBytes.some(Boolean)) && !(stateMatches && assetsMatch)) throw new Error("MASTRA_RUNTIME_PREFERENCES_IMPORT_CONFLICT: target differs for the same scope");
  if (stateMatches && assetsMatch) {
    console.log(JSON.stringify(result("replayed"), null, 2));
  } else {
    const writtenPaths = [];
    try {
      for (const file of files) {
        const targetPath = path.join(targetProjectRoot, assetPathFor(source, projectId, file.relativePath));
        await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        await writeFile(targetPath, file.bytes, { flag: "wx", mode: 0o600 });
        writtenPaths.push(targetPath);
      }
      db.transaction(() => {
        db.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(source.userId, projectId, source.instanceId, preferencesJson, JSON.stringify(migration.sourceChecksums), migration.fields.sourceRevision, batchId, now, now);
        for (const file of files) {
          const assetId = assetIdFor(source, projectId, file.relativePath);
          const versionId = versionIdFor(file.metadata.sha256);
          const assetPath = assetPathFor(source, projectId, file.relativePath);
          const key = `workspace-migration:runtime-preferences:${file.metadata.sha256}`;
          db.prepare("INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,folder_id,name,status,current_version_id,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(assetId, source.userId, projectId, source.instanceId, null, path.basename(file.relativePath), "active", versionId, null, now, now);
          db.prepare("INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,conversation_id,task_id,run_id,parent_version_id,idempotency_key,idempotency_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(versionId, assetId, source.userId, projectId, source.instanceId, 1, "config/" + path.basename(file.relativePath), "yaml", "application/yaml", file.bytes.length, file.metadata.sha256, assetPath, "workspace_migration", null, null, null, null, key, sha256(`${key}\0${file.metadata.sha256}`), now);
        }
      })();
    } catch (error) {
      for (const targetPath of writtenPaths) await unlink(targetPath).catch(() => undefined);
      throw error;
    }
    console.log(JSON.stringify(result("inserted"), null, 2));
  }
} finally {
  db.close();
}

function result(action) { return { ok: true, mode: "target_import", action, batchId, scope: { userId: source.userId, projectId, instanceId: source.instanceId }, sourceRevision: migration.fields.sourceRevision, sourceChecksums: migration.sourceChecksums, assetCount: files.length, schedulerActivation: migration.fields.schedulerActivation }; }
function assetIdFor(sourceValue, project, relativePath) { return `asset_runtime_${sha256(`${sourceValue.userId}\0${project}\0${sourceValue.instanceId}\0${relativePath}`).slice(0, 24)}`; }
function versionIdFor(checksum) { return `version_runtime_${checksum.slice(0, 24)}`; }
function assetPathFor(sourceValue, project, relativePath) { return `assets/${assetIdFor(sourceValue, project, relativePath)}/versions/${versionIdFor(sourceValue.files[relativePath].sha256)}/${path.basename(relativePath)}`; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function readOptional(value) { try { return await readFile(value); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function assertOutsideSnapshot(target, root, flag) { const canonicalRoot = await realpath(root); const candidate = await canonicalFuturePath(target); const relative = path.relative(canonicalRoot, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error(`${flag} must be outside the workspace snapshot source`); }
async function canonicalFuturePath(target) { const tail = []; let current = target; while (true) { try { return path.join(await realpath(current), ...tail.reverse()); } catch (error) { if (error?.code !== "ENOENT") throw error; const parent = path.dirname(current); if (parent === current) throw error; tail.push(path.basename(current)); current = parent; } } }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--mapping", "--target-db", "--target-project-root", "--batch-id", "--workspace-snapshot", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
