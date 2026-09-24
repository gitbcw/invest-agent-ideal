#!/usr/bin/env node
/**
 * Build an offline single-scope Portal/runtime fixture from a complete local
 * disaster-recovery backup. The source backup is opened read-only; all pruning
 * and schedule freezing happen only in P0_ROOT.
 *
 * Example:
 *   P0_BACKUP_ROOT=/path/to/full/2026-09-22T010004+0800 \
 *   P0_USER_ID=mg P0_INSTANCE_ID=invest-agent-mg \
 *   node scripts/agent-space/p0/import-local-backup-scope.mjs
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.resolve(process.env.P0_ROOT ?? path.join(REPO_ROOT, ".state", "agent-space-p0"));
const backupRoot = path.resolve(process.env.P0_BACKUP_ROOT ?? "");
const scope = {
  userId: process.env.P0_USER_ID ?? "111",
  projectId: process.env.P0_PROJECT_ID ?? "invest-agent",
  instanceId: process.env.P0_INSTANCE_ID ?? "invest-agent-111",
};

if (!backupRoot || backupRoot === REPO_ROOT) throw new Error("必须设置 P0_BACKUP_ROOT 为完整灾备目录");
const sourcePath = path.join(backupRoot, "databases", "runtime.db");
const digest = createHash("sha256")
  .update(`${scope.userId}\0${scope.projectId}\0${scope.instanceId}`)
  .digest("hex")
  .slice(0, 24);
const sourceProject = path.join(backupRoot, "runtime-data", "projects", digest);
if (!fs.existsSync(sourcePath)) throw new Error(`备份中缺少 runtime.db: ${sourcePath}`);
if (!fs.existsSync(sourceProject)) throw new Error(`备份中缺少 ${scope.userId} 容器: ${sourceProject}`);

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const sourceInstance = source.prepare("SELECT id FROM ai_instances WHERE id=? AND owner_user_id=? AND project_id=?")
  .get(scope.instanceId, scope.userId, scope.projectId);
const sourcePortal = source.prepare("SELECT id FROM portal_users WHERE username=? AND instance_id=?")
  .get(scope.userId, scope.instanceId);
if (!sourceInstance || !sourcePortal) throw new Error(`备份没有完整 scope 映射: ${JSON.stringify(scope)}`);
const sourceCounts = new Map();
for (const row of source.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  const columns = source.prepare(`PRAGMA table_info(${JSON.stringify(row.name)})`).all().map((column) => column.name);
  if (columns.includes("user_id")) {
    sourceCounts.set(row.name, source.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(row.name)} WHERE user_id=?`).get(scope.userId).count);
  }
}
source.close();

fs.rmSync(P0_ROOT, { recursive: true, force: true });
fs.mkdirSync(P0_ROOT, { recursive: true });
const targetPath = path.join(P0_ROOT, "runtime.db");
fs.copyFileSync(sourcePath, targetPath);
fs.cpSync(sourceProject, path.join(P0_ROOT, "projects", digest), { recursive: true });

const db = new Database(targetPath);
db.pragma("foreign_keys = OFF");
const portalUserIds = db.prepare("SELECT id FROM portal_users WHERE instance_id=?").all(scope.instanceId).map((row) => row.id);
if (portalUserIds.length !== 1) throw new Error(`隔离 scope Portal 用户映射异常: ${portalUserIds.length}`);
const presentationTables = new Set(["conversation_labels", "portal_conversation_meta", "portal_conversation_reconciliation"]);
const placeholders = portalUserIds.map(() => "?").join(",");
const pruned = [];
for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  const table = row.name;
  if (table.startsWith("sqlite_")) continue;
  const columns = db.pragma(`table_info(${JSON.stringify(table)})`).map((column) => column.name);
  let predicate = null;
  let params = [];
  if (table === "ai_instances") {
    predicate = "owner_user_id IS NOT NULL AND owner_user_id != ?";
    params = [scope.userId];
  } else if (presentationTables.has(table)) {
    predicate = `user_id IS NOT NULL AND user_id NOT IN (${placeholders})`;
    params = portalUserIds;
  } else if (columns.includes("user_id")) {
    predicate = "user_id IS NOT NULL AND user_id != ?";
    params = [scope.userId];
  } else if (columns.includes("instance_id")) {
    predicate = "instance_id IS NOT NULL AND instance_id != ?";
    params = [scope.instanceId];
  }
  if (!predicate) continue;
  const before = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)}`).get().count;
  db.prepare(`DELETE FROM ${JSON.stringify(table)} WHERE ${predicate}`).run(...params);
  const after = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)}`).get().count;
  if (before !== after) pruned.push({ table, before, after });
}
db.prepare("UPDATE automation_tasks SET next_run_at=NULL WHERE user_id=?").run(scope.userId);
const foreignKeyErrors = db.pragma("foreign_key_check");
db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");
if (foreignKeyErrors.length > 0) throw new Error(`裁剪后 foreign_key_check 失败: ${JSON.stringify(foreignKeyErrors.slice(0, 3))}`);

const countCheck = [];
for (const [table, sourceCount] of sourceCounts) {
  const local = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)} WHERE user_id=?`).get(scope.userId).count;
  countCheck.push({ table, source: sourceCount, local, ok: sourceCount === local });
}
const assetVersions = db.prepare("SELECT asset_id, version_id, file_name, size_bytes, checksum FROM user_asset_versions WHERE user_id=?").all(scope.userId);
const byteFailures = [];
for (const version of assetVersions) {
  const file = path.join(P0_ROOT, "projects", digest, "assets", version.asset_id, "versions", version.version_id, version.file_name);
  try {
    const bytes = fs.readFileSync(file);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== version.size_bytes || checksum !== version.checksum) byteFailures.push(version.version_id);
  } catch { byteFailures.push(version.version_id); }
}
db.close();
const allCountsMatch = countCheck.every((row) => row.ok);
const manifest = {
  source: { backupRoot, runtimeDb: sourcePath, readonly: true },
  scope,
  digest,
  prunedTables: pruned.length,
  countCheck,
  assetVersions: { checked: assetVersions.length, byteFailures },
  allChecksPassed: allCountsMatch && byteFailures.length === 0,
};
fs.writeFileSync(path.join(P0_ROOT, "pull-manifest.json"), JSON.stringify(manifest, null, 2));
if (!manifest.allChecksPassed) throw new Error("MG 副本校验失败，详见 pull-manifest.json");
console.log(JSON.stringify({ p0Root: P0_ROOT, scope, prunedTables: pruned.length, checkedTables: countCheck.length, assetVersions: assetVersions.length }));
