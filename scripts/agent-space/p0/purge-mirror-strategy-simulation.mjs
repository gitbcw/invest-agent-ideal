#!/usr/bin/env node
/**
 * 2026-10-10 用户裁决「都清理掉」：在 remove-mirror-strategy-simulation.mjs（卸载+墓碑）
 * 之后，彻底清除本地 production-mirror 中「量化策略模拟」(strategy-simulation) 的全部痕迹：
 * - db：安装记录、发布、版本、技能行、相关 authorization 与 audit 记录；
 * - 内容寻址 blob：该技能版本独占的 system-skill-content 文件（先校验无跨技能共享）；
 * - workspace 文件副本：fresh 项目 skills/strategy-simulation/（模板播种产物）。
 * 执行前备份数据库到 runtime-before-simulation-purge.db。模板目录由仓库侧删除，不在此脚本内。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(repo, ".state", "production-mirror");
const dbPath = path.join(root, "runtime.db");
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== dbPath) throw new Error("只允许本地 production-mirror 数据库");
if (!fs.existsSync(dbPath)) throw new Error("本地镜像未准备好");
process.env.DB_PATH = dbPath;
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
const { sqlite, initDb } = await import("../../../src/db/index.ts");
initDb();

const SLUG = "strategy-simulation";
const skill = sqlite.prepare("SELECT skill_id FROM agent_space_skills WHERE domain='system' AND slug=?").get(SLUG);
if (!skill) {
  console.log(`${SLUG} 已不存在，无需清理`);
  process.exit(0);
}
const skillId = skill.skill_id;

const backupPath = path.join(root, "runtime-before-simulation-purge.db");
if (!fs.existsSync(backupPath)) await sqlite.backup(backupPath);

const checksums = sqlite.prepare("SELECT content_checksum FROM agent_space_skill_versions WHERE skill_id=?").all(skillId).map((r) => r.content_checksum);
const shared = sqlite.prepare(
  "SELECT COUNT(DISTINCT skill_id) AS n FROM agent_space_skill_versions WHERE content_checksum IN (" + checksums.map(() => "?").join(",") + ") AND skill_id != ?",
).get(...checksums, skillId);
if (shared.n > 0) throw new Error("版本内容与其它技能共享，拒绝删除 blob；请人工核对");

const counts = {};
const tx = sqlite.transaction(() => {
  const del = (table, where, ...args) => {
    counts[table] = sqlite.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes;
  };
  del("agent_space_agent_skill_installations", "skill_id=?", skillId);
  del("agent_space_skill_releases", "skill_id=?", skillId);
  del("agent_space_skill_versions", "skill_id=?", skillId);
  del("agent_space_skills", "skill_id=?", skillId);
  del("agent_space_authorizations", "object_id LIKE ? OR extra_binding_json LIKE ?", `%${skillId}%`, `%${skillId}%`);
  del("agent_space_audit_logs", "object_id LIKE ? OR detail_json LIKE ?", `%${skillId}%`, `%${skillId}%`);
});
tx();

let blobsDeleted = 0;
for (const checksum of checksums) {
  const file = path.join(root, "runtime", "system-skill-content", checksum);
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    blobsDeleted += 1;
  }
}

const freshSkills = path.join(root, "projects", "58a4c177eccde765dc8a1cfb", "skills", SLUG);
const workspaceRemoved = fs.existsSync(freshSkills) ? (fs.rmSync(freshSkills, { recursive: true }), true) : false;

sqlite.close();
console.log(`清除完成：${JSON.stringify(counts)}；blob 删除 ${blobsDeleted} 个；fresh workspace 副本删除：${workspaceRemoved}；库备份：${backupPath}`);
