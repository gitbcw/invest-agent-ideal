#!/usr/bin/env node
/**
 * W7 逐用户隔离回滚（R2：补偿式前向修复，不做整库恢复）。
 *
 * 生产回滚两级：
 *   1) --level switch-only（默认）：只输出装配开关回退指令并核对当前 scope
 *      清单——零数据操作，立即生效，永远安全。
 *   2) --level deactivate：前向停用本批对象（任务依赖删除、Agent→disabled、
 *      w6 导入方法→retired、w6 导入资产→archived）。逐行只动本 scope 的
 *      w6:* 幂等键对象，不触碰其他用户与既有生产资产，不覆盖窗口期间
 *      任何新写入。
 *
 * 整库快照恢复不属于本脚本：仅 owner 明确批准的维护窗口内、阻断相关写入、
 * 核对快照后变更清单后另行执行（W7 执行计划第 10 步）。
 *
 * 用法：
 *   node --import tsx scripts/agent-space/w7-rollback-scope.mjs --scope <userId> \
 *     [--level switch-only|deactivate] [--target isolated|production] [--confirm]
 * deactivate 必须 --confirm 与 --target；target=production 要求 NODE_ENV 非 test。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const scopeUser = argOf("scope");
const level = argOf("level") ?? "switch-only";
const target = argOf("target");
const confirm = args.includes("--confirm");

if (!scopeUser || !["switch-only", "deactivate"].includes(level)) {
  console.error("usage: w7-rollback-scope.mjs --scope <userId> [--level switch-only|deactivate] [--target isolated|production] [--confirm]");
  process.exit(2);
}
if (!process.env.DB_PATH) {
  console.error("refusing to run: DB_PATH not set (point at the target database explicitly)");
  process.exit(2);
}
if (level === "deactivate") {
  if (!confirm) {
    console.error("deactivate requires --confirm (this mutates scope objects)");
    process.exit(2);
  }
  if (target !== "isolated" && target !== "production") {
    console.error("deactivate requires --target isolated|production (explicit target identity)");
    process.exit(2);
  }
  if (target === "production" && process.env.NODE_ENV === "test") {
    console.error("refusing production write under NODE_ENV=test");
    process.exit(2);
  }
}
process.env.NODE_ENV ??= "test";
process.env.WORKSPACE_BACKEND ??= "mastra";

async function importAppModule(relative) {
  for (const base of ["../../src", "../../dist"]) {
    try {
      return await import(new URL(`${base}/${relative}`, import.meta.url).href);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`cannot resolve app module: ${relative}`);
}

const db = await importAppModule("db/index.js");
db.initDb();
const space = await importAppModule("services/agent-space/index.js");
const userAssets = await importAppModule("services/user-assets.js");

const scopeRowOf = db.sqlite.prepare("SELECT user_id AS u, project_id AS p, instance_id AS i FROM agent_space_agents WHERE agent_id=?");
// R2 返工：deactivate 的删除/停用面严格限定 W7 批次对象——
//   Agent：仅幂等键 w6:*/w7:*（批次约定键）的批次 Agent；手工/既有 Agent 不动。
//   依赖：仅 kind=method 且 ref 指向本 scope w6 导入方法的依赖（W7 注册的就是这些）；
//         其他 kind（asset_input 等）与非 w6 方法的依赖一律不动。
const batchAgents = db.sqlite.prepare("SELECT agent_id, status FROM agent_space_agents WHERE user_id=? AND (idempotency_key LIKE 'w6:%' OR idempotency_key LIKE 'w7:%')").all(scopeUser);
// NULL 幂等键（手工/既有 Agent）必须算非批次：NULL LIKE 为三值逻辑 NULL。
const otherAgents = db.sqlite.prepare(
  "SELECT COUNT(*) AS n FROM agent_space_agents WHERE user_id=? AND (idempotency_key IS NULL OR (idempotency_key NOT LIKE 'w6:%' AND idempotency_key NOT LIKE 'w7:%'))",
).get(scopeUser);
const w6MethodIds = db.sqlite.prepare("SELECT method_id FROM agent_space_methods WHERE user_id=? AND idempotency_key LIKE 'w6:%'").all(scopeUser).map((r) => r.method_id);
const w6MethodIdSet = new Set(w6MethodIds);
const deps = db.sqlite
  .prepare("SELECT dependency_id, task_id, kind, ref_id FROM agent_space_task_dependencies WHERE user_id=? AND kind='method'")
  .all(scopeUser)
  .filter((d) => w6MethodIdSet.has(d.ref_id));
const depsUntouched = db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_task_dependencies WHERE user_id=?").get(scopeUser).n - deps.length;
const w6Methods = db.sqlite.prepare("SELECT method_id, name, status FROM agent_space_methods WHERE user_id=? AND idempotency_key LIKE 'w6:%'").all(scopeUser);
const w6Assets = db.sqlite.prepare("SELECT asset_id FROM user_asset_versions WHERE user_id=? AND idempotency_key LIKE 'w6:%' GROUP BY asset_id").all(scopeUser);

const report = {
  scope: scopeUser,
  level,
  target: target ?? null,
  confirm,
  dbPath: process.env.DB_PATH,
  dbSha256: createHash("sha256").update(readFileSync(process.env.DB_PATH)).digest("hex"),
  inventory: {
    batchAgents,
    untouched: { nonBatchAgents: otherAgents.n, nonBatchDependencies: depsUntouched },
    w6MethodDependencies: deps,
    w6Methods,
    w6Assets: w6Assets.map((a) => a.asset_id),
  },
  actions: [],
  switchInstruction: [
    "生产开关回退（本批 scope）：从生产环境 AGENT_SPACE_ASSEMBLY_MODE 的 scope 列表移除该用户（或整体置 off），随后白天重启 mastra-portal；",
    "开关为进程内 env，回退立即生效且零数据操作——这是任何批次失败的首选回滚。",
  ],
};

if (level === "switch-only") {
  report.actions.push({ action: "none", note: "switch-only：仅输出开关指令与清单，未做任何数据操作。" });
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

for (const dep of deps) {
  db.sqlite.prepare("DELETE FROM agent_space_task_dependencies WHERE dependency_id=? AND user_id=?").run(dep.dependency_id, scopeUser);
  report.actions.push({ action: "task-dependency.deleted", dependencyId: dep.dependency_id, taskId: dep.task_id, ref: `${dep.kind}:${dep.ref_id}` });
}
for (const agent of batchAgents) {
  if (agent.status === "disabled") continue;
  const s = scopeRowOf.get(agent.agent_id);
  space.setAgentStatus({ userId: s.u, projectId: s.p, instanceId: s.i }, agent.agent_id, "disabled", "w7-rollback");
  report.actions.push({ action: "agent.disabled", agentId: agent.agent_id });
}
for (const method of w6Methods) {
  if (method.status === "retired") continue;
  const row = db.sqlite.prepare("SELECT user_id AS u, project_id AS p, instance_id AS i FROM agent_space_methods WHERE method_id=?").get(method.method_id);
  space.retireMethod({ userId: row.u, projectId: row.p, instanceId: row.i }, method.method_id, "w7-rollback");
  report.actions.push({ action: "method.retired", methodId: method.method_id, name: method.name });
}
for (const { asset_id: assetId } of w6Assets) {
  const row = db.sqlite.prepare("SELECT user_id AS u, project_id AS p, instance_id AS i, status FROM user_assets WHERE asset_id=?").get(assetId);
  if (row.status !== "active") continue;
  await userAssets.archiveUserAsset({ userId: row.u, projectId: row.p, instanceId: row.i, assetId });
  report.actions.push({ action: "asset.archived", assetId });
}
report.note = "补偿只停用本 scope 的 w6:* 导入对象与本 scope Agent/依赖；未删除字节、未触碰其他用户、未覆盖窗口期间写入。";
console.log(JSON.stringify(report, null, 1));
process.exit(0);
