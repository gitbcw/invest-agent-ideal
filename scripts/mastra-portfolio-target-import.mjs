#!/usr/bin/env node

/**
 * Import a dry-run portfolio mapping into a disposable Mastra target. The
 * structured state becomes service-owned; the original YAML is preserved as
 * an immutable user asset. The snapshot source is never modified.
 */
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
const state = mapping?.mapping?.serviceMigration;
if (mapping?.mode !== "dry_run" || !source || !state?.fields || !state?.idempotencyKey) throw new Error("mapping must be a portfolio mapping dry-run report");
if (!source.userId || !source.instanceId || !source.sourcePath || !source.sha256 || !source.workspaceId) throw new Error("mapping is missing source scope or checksum");
const sourcePath = path.join(snapshotRoot, source.workspaceId, source.sourcePath);
await assertFile(sourcePath, "portfolio source");
const sourceBytes = await readFile(sourcePath);
if (sha256(sourceBytes) !== source.sha256) throw new Error("MASTRA_PORTFOLIO_SOURCE_CHANGED: source checksum differs from dry-run");

const stateJson = JSON.stringify(state.fields);
const assetId = `asset_portfolio_${sha256(`${source.userId}\0${projectId}\0${source.instanceId}\0${source.sourcePath}`).slice(0, 24)}`;
const versionId = `version_portfolio_${source.sha256.slice(0, 24)}`;
const assetRelativePath = `assets/${assetId}/versions/${versionId}/portfolio.yaml`;
const assetPath = path.join(targetProjectRoot, assetRelativePath);
const idempotencyKey = `workspace-migration:portfolio-source:${source.sha256}`;
const now = new Date().toISOString();

const db = new Database(targetDbPath);
try {
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mastra_portfolio_states (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
      portfolio_json TEXT NOT NULL, source_path TEXT NOT NULL, source_checksum TEXT NOT NULL,
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
  const existingState = db.prepare("SELECT portfolio_json AS stateJson, source_path AS sourcePath, source_checksum AS sourceChecksum FROM mastra_portfolio_states WHERE user_id=? AND project_id=? AND instance_id=?")
    .get(source.userId, projectId, source.instanceId);
  const existingAsset = db.prepare(`
    SELECT a.asset_id AS assetId, a.current_version_id AS currentVersionId, v.checksum,
      v.storage_path AS storagePath, v.file_name AS fileName, v.idempotency_key AS idempotencyKey
    FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
    WHERE a.asset_id=? AND a.user_id=? AND a.project_id=? AND a.instance_id=?
  `).get(assetId, source.userId, projectId, source.instanceId);
  const savedBytes = await readOptional(assetPath);
  const stateMatches = existingState && existingState.stateJson === stateJson && existingState.sourcePath === source.sourcePath && existingState.sourceChecksum === source.sha256;
  const assetMatches = existingAsset && existingAsset.currentVersionId === versionId && existingAsset.checksum === source.sha256 && existingAsset.storagePath === assetRelativePath && existingAsset.fileName === "portfolio.yaml" && existingAsset.idempotencyKey === idempotencyKey && savedBytes?.equals(sourceBytes);
  if ((existingState || existingAsset || savedBytes) && !(stateMatches && assetMatches)) {
    throw new Error("MASTRA_PORTFOLIO_IMPORT_CONFLICT: target differs for the same scope");
  }
  if (stateMatches && assetMatches) {
    console.log(JSON.stringify(result("replayed"), null, 2));
  } else {
    await mkdir(path.dirname(assetPath), { recursive: true, mode: 0o700 });
    await writeFile(assetPath, sourceBytes, { flag: "wx", mode: 0o600 });
    try {
      db.transaction(() => {
        db.prepare("INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(source.userId, projectId, source.instanceId, stateJson, source.sourcePath, source.sha256, state.fields.sourceRevision, batchId, now, now);
        db.prepare("INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,folder_id,name,status,current_version_id,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(assetId, source.userId, projectId, source.instanceId, null, "portfolio.yaml", "active", versionId, null, now, now);
        db.prepare("INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,conversation_id,task_id,run_id,parent_version_id,idempotency_key,idempotency_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(versionId, assetId, source.userId, projectId, source.instanceId, 1, "portfolio.yaml", "yaml", "application/yaml", sourceBytes.length, source.sha256, assetRelativePath, "workspace_migration", null, null, null, null, idempotencyKey, sha256(`${idempotencyKey}\0${source.sha256}`), now);
      })();
    } catch (error) {
      await unlink(assetPath).catch(() => undefined);
      throw error;
    }
    console.log(JSON.stringify(result("inserted"), null, 2));
  }
} finally {
  db.close();
}

function result(action) {
  return {
    ok: true, mode: "target_import", action, batchId,
    scope: { userId: source.userId, projectId, instanceId: source.instanceId },
    state: { checksum: sha256(stateJson), sourceChecksum: source.sha256, counts: mapping.mapping.counts },
    asset: { assetId, versionId, path: assetRelativePath, checksum: source.sha256, bytes: sourceBytes.length },
  };
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function readOptional(value) { try { return await readFile(value); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function assertOutsideSnapshot(target, snapshotRoot, flag) { const root = await realpath(snapshotRoot); const candidate = await canonicalFuturePath(target); const relative = path.relative(root, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error(`${flag} must be outside the workspace snapshot source`); }
async function canonicalFuturePath(target) { const tail = []; let current = target; while (true) { try { return path.join(await realpath(current), ...tail.reverse()); } catch (error) { if (error?.code !== "ENOENT") throw error; const parent = path.dirname(current); if (parent === current) throw error; tail.push(path.basename(current)); current = parent; } } }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--mapping", "--target-db", "--target-project-root", "--batch-id", "--workspace-snapshot", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
