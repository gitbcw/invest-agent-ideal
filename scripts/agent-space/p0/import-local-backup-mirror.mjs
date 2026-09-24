#!/usr/bin/env node
/**
 * Build a local, writable mirror of a complete production backup.
 * The backup is read only. The mirror keeps every backed-up scope and project
 * container, while disabling future automation dispatches in the copied DB.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(process.env.MIRROR_ROOT ?? path.join(REPO_ROOT, ".state", "production-mirror"));
const backupRoot = path.resolve(process.env.MIRROR_BACKUP_ROOT ?? "");
if (!backupRoot || backupRoot === REPO_ROOT) throw new Error("必须设置 MIRROR_BACKUP_ROOT 为完整灾备目录");

const sourceDb = path.join(backupRoot, "databases", "runtime.db");
const sourceProjects = path.join(backupRoot, "runtime-data", "projects");
if (!fs.existsSync(sourceDb) || !fs.existsSync(sourceProjects)) throw new Error("备份缺少 runtime.db 或 runtime-data/projects");
if (!fs.existsSync(path.join(backupRoot, "COMPLETE"))) throw new Error("备份没有 COMPLETE 标记，拒绝导入");

fs.rmSync(mirrorRoot, { recursive: true, force: true });
fs.mkdirSync(mirrorRoot, { recursive: true, mode: 0o700 });
for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${sourceDb}${suffix}`;
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(mirrorRoot, `runtime.db${suffix}`));
}
fs.cpSync(sourceProjects, path.join(mirrorRoot, "projects"), { recursive: true });

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(path.join(mirrorRoot, "runtime.db"));
db.pragma("foreign_keys = ON");
for (const table of ["automation_tasks", "scheduled_task_runs"]) {
  const columns = db.pragma(`table_info(${JSON.stringify(table)})`).map((column) => column.name);
  if (columns.includes("next_run_at")) db.prepare(`UPDATE ${table} SET next_run_at=NULL`).run();
}
const fkErrors = db.pragma("foreign_key_check");
if (fkErrors.length) throw new Error(`副本 foreign_key_check 失败: ${JSON.stringify(fkErrors.slice(0, 3))}`);
db.pragma("wal_checkpoint(TRUNCATE)");

const users = db.prepare(
  "SELECT owner_user_id AS userId, id AS instanceId, project_id AS projectId FROM ai_instances WHERE owner_user_id IS NOT NULL ORDER BY owner_user_id",
).all();
const counts = {
  users: users.length,
  conversations: db.prepare("SELECT COUNT(*) AS n FROM conversation_sessions").get().n,
  messages: db.prepare("SELECT COUNT(*) AS n FROM conversation_messages").get().n,
  projects: fs.readdirSync(path.join(mirrorRoot, "projects")).length,
};
db.close();

const manifest = { backupRoot, sourceDb, mirrorRoot, users, counts, offline: true, createdAt: new Date().toISOString() };
fs.writeFileSync(path.join(mirrorRoot, "mirror-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(manifest));
