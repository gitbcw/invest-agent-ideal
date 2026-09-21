#!/usr/bin/env node
/**
 * W7 步骤 0b 生产 schema 结构核验（T-531 复验补强项）。
 *
 *   node --import tsx scripts/agent-space/w7-verify-schema.mjs --db <生产 runtime.db>
 *   # 服务器（无 tsx）直接 node 运行：src 导入失败自动回退 dist
 *
 * 语义：用**部署代码自身的 initDb** 在临时参照库建出完整 schema，再与目标库
 * 只读比对全部 agent_space 表的：存在性、列名序列（PRAGMA table_info）、
 * 非自动索引名集合、唯一索引列元组。表名存在但结构不完整（缺列/缺索引/
 * 旧结构残留）会被逐表报出。目标库全程 readonly 打开、零写入；参照库是
 * 系统临时目录里的新文件（退出即删，--keep-reference 保留供诊断）。
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const targetDb = argOf("db");
if (!targetDb || !existsSync(targetDb)) {
  console.error("usage: w7-verify-schema.mjs --db <target runtime.db> [--keep-reference]");
  process.exit(2);
}
process.env.NODE_ENV ??= "test";

const AGENT_SPACE_TABLES = [
  "agent_space_agents", "agent_space_agent_asset_grants", "agent_space_agent_method_bindings",
  "agent_space_agent_skill_installations", "agent_space_audit_logs", "agent_space_authorizations",
  "agent_space_commitment_fulfillments", "agent_space_commitments", "agent_space_facts",
  "agent_space_lesson_versions", "agent_space_lessons", "agent_space_method_versions",
  "agent_space_methods", "agent_space_run_basis", "agent_space_run_outcomes",
  "agent_space_skill_releases", "agent_space_skill_versions", "agent_space_skills",
  "agent_space_task_dependencies", "agent_space_task_run_snapshots",
  "agent_space_workflow_versions", "agent_space_workflows",
];

async function importAppModule(relative) {
  // 先 src（本地 tsx 直跑），任何失败都回退 dist（服务器部署无 tsx）。
  for (const base of ["../../src", "../../dist"]) {
    try {
      return await import(new URL(`${base}/${relative}`, import.meta.url).href);
    } catch { /* 尝试下一个基目录 */ }
  }
  throw new Error("cannot resolve app module (neither src nor dist): " + relative);
}

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "w7-verify-schema-"));
const referenceDb = path.join(tmpDir, "reference.db");
process.env.DB_PATH = referenceDb;
const dbModule = await importAppModule("db/index.js");
// initDb 的初始化日志（logger→console.log）会打到 stdout；核验脚本 stdout 必须是纯 JSON（窗口日可管道解析），临时静默。
const originalInfo = console.info;
const originalLog = console.log;
console.info = () => {};
console.log = () => {};
try {
  dbModule.initDb();
} finally {
  console.info = originalInfo;
  console.log = originalLog;
}
dbModule.sqlite.pragma("wal_checkpoint(TRUNCATE)");
dbModule.sqlite.close?.();

const { default: Database } = await import("better-sqlite3");
const structureOf = (db, label) => {
  const result = {};
  for (const table of AGENT_SPACE_TABLES) {
    const exists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    if (!exists) { result[table] = { exists: false }; continue; }
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all()
      .filter((idx) => !idx.name.startsWith("sqlite_autoindex"));
    const uniqueColumnTuples = indexes
      .filter((idx) => idx.unique === 1)
      .map((idx) => db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name).join(","))
      .sort();
    result[table] = { exists: true, columns, indexNames: indexes.map((i) => i.name).sort(), uniqueColumnTuples, _label: label };
  }
  return result;
};

const target = new Database(targetDb, { readonly: true });
const reference = new Database(referenceDb, { readonly: true });
const targetStructure = structureOf(target, "target");
const referenceStructure = structureOf(reference, "reference");
target.close();
reference.close();

const results = [];
for (const table of AGENT_SPACE_TABLES) {
  const t = targetStructure[table];
  const r = referenceStructure[table];
  const problems = [];
  if (!t.exists) problems.push("table-missing-in-target");
  else {
    if (!r.exists) problems.push("table-missing-in-reference-code(代码异常)");
    else {
      const missingColumns = r.columns.filter((c) => !t.columns.includes(c));
      const extraColumns = t.columns.filter((c) => !r.columns.includes(c));
      if (missingColumns.length) problems.push(`missing-columns:[${missingColumns.join(",")}]`);
      if (extraColumns.length) problems.push(`unexpected-columns:[${extraColumns.join(",")}]`);
      const missingIndexes = r.indexNames.filter((i) => !t.indexNames.includes(i));
      if (missingIndexes.length) problems.push(`missing-indexes:[${missingIndexes.join(",")}]`);
      const missingUniques = r.uniqueColumnTuples.filter((u) => !t.uniqueColumnTuples.includes(u));
      if (missingUniques.length) problems.push(`missing-unique-constraints:[${missingUniques.join(" | ")}]`);
    }
  }
  results.push({ table, ok: problems.length === 0, problems: problems.length ? problems : null });
}

const report = {
  targetDb: path.resolve(targetDb),
  referenceDb,
  checkedAt: new Date().toISOString(),
  tableCount: { expected: AGENT_SPACE_TABLES.length, presentInTarget: Object.values(targetStructure).filter((t) => t.exists).length },
  results,
  pass: results.every((r) => r.ok),
  note: "目标库只读打开零写入；参照库由部署代码 initDb 在系统临时目录生成（结构=代码权威），退出即删。",
};
console.log(JSON.stringify(report, null, 1));

if (!argOf("keep-reference")) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(referenceDb + suffix); } catch { /* 无该文件 */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
}
process.exit(report.pass ? 0 : 1);
