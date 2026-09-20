#!/usr/bin/env node
/**
 * W7 窗口日任务依赖注册脚本（批次步骤 6）。
 *
 * 把 owner 已批准采用（approve+adopt）的方法 pin 到有方法消费者的
 * active 任务（agent_space_task_dependencies，kind=method，pinned=当前
 * 采用版本）。幂等：upsert 唯一键 task+kind+ref，重跑零副作用。
 *
 * 用法：
 *   node --import tsx scripts/agent-space/w7-register-task-deps.mjs \
 *     --plan <plan.json> [--confirm]
 *
 * plan.json：[{ "userId": "mg", "methodItemId": "mg:liveProjectRoot:methods/控盘度综合评分.md",
 *               "taskIds": ["at_d64649ad-…"] }, …]
 * methodItemId 必须是 W6 已导入且经授权 adopt 的方法（脚本核对
 * idempotency_key=w6:<itemId>:method 与 current_version_id；未 adopt 拒绝）。
 * 环境必须指向目标 DB（生产=生产 DB；演练=隔离 DB）；默认 dry-run。
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const planPath = argOf("plan");
const confirm = args.includes("--confirm");
if (!planPath) {
  console.error("usage: w7-register-task-deps.mjs --plan <plan.json> [--confirm]");
  process.exit(2);
}
if (!process.env.DB_PATH) {
  console.error("refusing to run: DB_PATH not set (point at the target database explicitly)");
  process.exit(2);
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

const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (!Array.isArray(plan)) {
  console.error("plan must be an array of {userId, methodItemId, taskIds}");
  process.exit(2);
}

const results = [];
let failed = false;
for (const entry of plan) {
  const { userId, methodItemId, taskIds } = entry;
  const methodKey = `w6:${methodItemId}:method`;
  const methodRow = db.sqlite
    .prepare("SELECT method_id, user_id, project_id, instance_id, name, status, current_version_id FROM agent_space_methods WHERE idempotency_key=?")
    .get(methodKey);
  if (!methodRow) {
    results.push({ userId, methodItemId, status: "rejected", reason: "method not imported (w6 idempotency key missing)" });
    failed = true;
    continue;
  }
  const scope = { userId: methodRow.user_id, projectId: methodRow.project_id, instanceId: methodRow.instance_id };
  if (scope.userId !== userId) {
    results.push({ userId, methodItemId, status: "rejected", reason: `method belongs to ${scope.userId}` });
    failed = true;
    continue;
  }
  if (!methodRow.current_version_id) {
    results.push({ userId, methodItemId, status: "rejected", reason: "method has no adopted current version (approve+adopt first)" });
    failed = true;
    continue;
  }
  for (const taskId of taskIds ?? []) {
    const task = db.sqlite
      .prepare("SELECT user_id, project_id, instance_id, status FROM automation_tasks WHERE task_id=?")
      .get(taskId);
    if (!task) {
      results.push({ userId, methodItemId, taskId, status: "rejected", reason: "task not found" });
      failed = true;
      continue;
    }
    if (task.user_id !== scope.userId || task.project_id !== scope.projectId || task.instance_id !== scope.instanceId) {
      results.push({ userId, methodItemId, taskId, status: "rejected", reason: "task scope mismatch" });
      failed = true;
      continue;
    }
    if (task.status !== "active") {
      results.push({ userId, methodItemId, taskId, status: "rejected", reason: `task is ${task.status} (only active tasks register)` });
      failed = true;
      continue;
    }
    // 解析校验：adopt 后的 current 必须可 pin（带 BLOCKS_RUN_BINDING 约束会被拒）。
    try {
      space.resolveMethodVersion(scope, methodRow.method_id, methodRow.current_version_id);
    } catch (error) {
      results.push({ userId, methodItemId, taskId, status: "rejected", reason: `version not pinnable: ${error.message}` });
      failed = true;
      continue;
    }
    if (!confirm) {
      results.push({ userId, methodItemId, taskId, status: "dry-run", methodId: methodRow.method_id, pinnedVersionId: methodRow.current_version_id });
      continue;
    }
    try {
      const dep = space.upsertTaskDependency({
        scope, taskId, kind: "method", refId: methodRow.method_id,
        versionPolicy: "pinned", pinnedVersionId: methodRow.current_version_id,
        actor: "w7-cutover",
      });
      results.push({ userId, methodItemId, taskId, status: "registered", methodId: methodRow.method_id, pinnedVersionId: methodRow.current_version_id, dependencyId: dep.dependency_id });
    } catch (error) {
      results.push({ userId, methodItemId, taskId, status: "failed", reason: error.message });
      failed = true;
    }
  }
}

console.log(JSON.stringify({ confirm, results, ok: !failed }, null, 1));
process.exit(failed ? 1 : 0);
