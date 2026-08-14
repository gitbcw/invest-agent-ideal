#!/usr/bin/env node

/**
 * Import the user-owned strategy rules into a disposable Mastra project.
 * The source snapshot is read-only. Structured profile import is handled by
 * mastra-strategy-target-import; this script owns the readable rules file and
 * the immutable source YAML asset version.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
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
await assertOutsideSnapshot(targetProjectRoot, snapshotRoot, "--target-project-root");
await assertOutsideSnapshot(targetDbPath, snapshotRoot, "--target-db");
await mkdir(targetProjectRoot, { recursive: true, mode: 0o700 });
await mkdir(path.dirname(targetDbPath), { recursive: true, mode: 0o700 });

const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
const source = mapping?.source;
const projectMethod = mapping?.mapping?.projectFile;
if (mapping?.mode !== "dry_run" || !source || !projectMethod?.fields) {
  throw new Error("mapping must be a strategy mapping dry-run report");
}
if (!source.userId || !source.instanceId || !source.sourcePath || !source.sha256) {
  throw new Error("mapping is missing source scope or checksum");
}
const sourcePath = path.join(snapshotRoot, source.workspaceId, source.sourcePath);
await assertFile(sourcePath, "strategy source");
const sourceBytes = await readFile(sourcePath);
const sourceChecksum = sha256(sourceBytes);
if (sourceChecksum !== source.sha256) throw new Error("MASTRA_STRATEGY_SOURCE_CHANGED: source checksum differs from dry-run");

const methodsRelativePath = "methods/strategy-rules.md";
const methodsPath = path.join(targetProjectRoot, methodsRelativePath);
const assetId = `asset_strategy_${sha256(`${source.userId}\0${projectId}\0${source.instanceId}\0${source.sourcePath}`).slice(0, 24)}`;
const versionId = `version_strategy_${source.sha256.slice(0, 24)}`;
const assetRelativePath = `assets/${assetId}/versions/${versionId}/strategy.yaml`;
const assetPath = path.join(targetProjectRoot, assetRelativePath);
const methodsBytes = Buffer.from(renderMethodsMarkdown(projectMethod.fields, source), "utf8");
const methodsChecksum = sha256(methodsBytes);
const now = new Date().toISOString();

const db = new Database(targetDbPath);
try {
  db.pragma("foreign_keys = ON");
  db.exec(`
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
  const existing = db.prepare(`
    SELECT a.asset_id AS assetId, a.current_version_id AS currentVersionId,
      v.checksum, v.storage_path AS storagePath, v.file_name AS fileName,
      v.idempotency_key AS idempotencyKey
    FROM user_assets a JOIN user_asset_versions v ON v.version_id = a.current_version_id
    WHERE a.asset_id = ? AND a.user_id = ? AND a.project_id = ? AND a.instance_id = ?
  `).get(assetId, source.userId, projectId, source.instanceId);
  const existingMethods = await readOptional(methodsPath);
  const existingAsset = await readOptional(assetPath);
  const expectedKey = `workspace-migration:strategy-source:${source.sha256}`;
  const same = existing
    && existing.checksum === source.sha256
    && existing.storagePath === assetRelativePath
    && existing.fileName === "strategy.yaml"
    && existing.idempotencyKey === expectedKey
    && existingMethods?.equals(methodsBytes)
    && existingAsset?.equals(sourceBytes);
  if (existing && !same) throw new Error("MASTRA_STRATEGY_PROJECT_IMPORT_CONFLICT: target differs for the same scope");
  if (same) {
    console.log(JSON.stringify({ ok: true, mode: "target_project_import", action: "replayed", batchId, scope: { userId: source.userId, projectId, instanceId: source.instanceId }, methods: { path: methodsRelativePath, checksum: methodsChecksum }, asset: { assetId, versionId, path: assetRelativePath, checksum: source.sha256 } }, null, 2));
  } else {
    await mkdir(path.dirname(methodsPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(assetPath), { recursive: true, mode: 0o700 });
    await writeFile(methodsPath, methodsBytes, { flag: "wx", mode: 0o600 });
    await writeFile(assetPath, sourceBytes, { flag: "wx", mode: 0o600 });
    db.transaction(() => {
      db.prepare(`INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,folder_id,name,status,current_version_id,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(assetId, source.userId, projectId, source.instanceId, null, "strategy.yaml", "active", versionId, null, now, now);
      db.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,conversation_id,task_id,run_id,parent_version_id,idempotency_key,idempotency_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(versionId, assetId, source.userId, projectId, source.instanceId, 1, "strategy.yaml", "yaml", "application/yaml", sourceBytes.length, source.sha256, assetRelativePath, "workspace_migration", null, null, null, null, expectedKey, sha256(`${expectedKey}\0${source.sha256}`), now);
    })();
    console.log(JSON.stringify({ ok: true, mode: "target_project_import", action: "inserted", batchId, scope: { userId: source.userId, projectId, instanceId: source.instanceId }, methods: { path: methodsRelativePath, checksum: methodsChecksum, bytes: methodsBytes.length }, asset: { assetId, versionId, path: assetRelativePath, checksum: source.sha256, bytes: sourceBytes.length } }, null, 2));
  }
} finally {
  db.close();
}

function renderMethodsMarkdown(fields, source) {
  const sections = [
    ["Buy rules", fields.buyRules], ["Sell rules", fields.sellRules], ["Rebalance rules", fields.rebalanceRules],
    ["Risk rules", fields.riskRules], ["Do not do", fields.doNotDoRules], ["Decision boundaries", fields.decisionBoundaries], ["Notes", fields.notes],
  ];
  const lines = ["# Strategy Rules", "", `Source: ${source.sourcePath}`, `Source checksum: ${source.sha256}`, `Source revision: ${fields.sourceRevision ?? ""}`, "", "This file is a user method asset. It does not grant service permissions or enable code execution.", ""];
  for (const [title, value] of sections) {
    lines.push(`## ${title}`, "");
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push("- None", "");
      else for (const item of value) lines.push(`- ${String(item)}`);
    } else if (value && typeof value === "object") {
      lines.push("```json", JSON.stringify(value, null, 2), "```", "");
    } else {
      lines.push(String(value ?? ""), "");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function readOptional(value) { try { return await readFile(value); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
async function assertOutsideSnapshot(target, snapshotRoot, flag) {
  const root = await realpath(snapshotRoot);
  const candidate = await canonicalFuturePath(target);
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error(`${flag} must be outside the workspace snapshot source`);
}
async function canonicalFuturePath(target) {
  const tail = [];
  let current = target;
  while (true) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--mapping", "--target-db", "--target-project-root", "--batch-id", "--workspace-snapshot", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index];
  }
  return values;
}
