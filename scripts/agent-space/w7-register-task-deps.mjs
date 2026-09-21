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
 *     --plan <plan.json> [--confirm --target isolated|production \
 *       --w0-root <dir> --manifest-sha256 <sha> --batch B1|B2|B3]
 *
 * plan.json：[{ "userId": "mg", "methodItemId": "mg:liveProjectRoot:methods/控盘度综合评分.md",
 *               "taskIds": ["at_d64649ad-…"] }, …]
 * methodItemId 必须是 W6 已导入且经授权 adopt 的方法（脚本核对
 * idempotency_key=w6:<itemId>:method 与 current_version_id；未 adopt 拒绝）。
 * 环境必须指向目标 DB；默认 dry-run（任意隔离 DB 可跑）。
 *
 * W7-R3 护栏：--confirm 必须携带完整目标身份——
 *   --target production 时：NODE_ENV 非 test、--batch 批次合法、--w0-root 与
 *     --manifest-sha256 与目标库导入所用 import-gate.json 指纹一致；
 *   --target isolated 时：同样要求 manifest 指纹（隔离演练库）；
 *   plan 中 userId 必须属于该批次用户集（B1=mg / B2=dyk / B3=111）。
 * 注册前后输出 affected 清单（新增/既有依赖行），重跑幂等。
 */
import { readFileSync } from "node:fs";

import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const planPath = argOf("plan");
const confirm = args.includes("--confirm");
const target = argOf("target");
const w0Root = argOf("w0-root");
const manifestSha = argOf("manifest-sha256");
const batch = argOf("batch");
const BATCH_USERS = { B1: ["mg"], B2: ["dyk"], B3: ["111"] };
if (!planPath) {
  console.error("usage: w7-register-task-deps.mjs --plan <plan.json> [--confirm --target isolated|production --w0-root <dir> --manifest-sha256 <sha> --batch B1|B2|B3]");
  process.exit(2);
}
if (!process.env.DB_PATH) {
  console.error("refusing to run: DB_PATH not set (point at the target database explicitly)");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (!Array.isArray(plan)) {
  console.error("plan must be an array of {userId, methodItemId, taskIds}");
  process.exit(2);
}
if (confirm) {
  const missing = [];
  if (target !== "isolated" && target !== "production") missing.push("--target isolated|production");
  if (!w0Root) missing.push("--w0-root");
  if (!manifestSha) missing.push("--manifest-sha256");
  if (!BATCH_USERS[batch ?? ""]) missing.push("--batch B1|B2|B3");
  if (missing.length > 0) {
    console.error(`confirm requires target identity: missing ${missing.join(", ")}`);
    process.exit(2);
  }
  const actualSha = createHash("sha256").update(readFileSync(`${w0Root}/import-gate.json`)).digest("hex");
  if (actualSha !== manifestSha) {
    console.error(`manifest fingerprint mismatch: --manifest-sha256=${manifestSha} but ${w0Root}/import-gate.json is ${actualSha}`);
    console.error(" refusing: 目标库导入所用门禁清单与本次声明不一致（清单可能已重生成，先重跑 W6 演练核对）");
    process.exit(2);
  }
  if (target === "production" && process.env.NODE_ENV === "test") {
    console.error("refusing production write under NODE_ENV=test");
    process.exit(2);
  }
  const batchUsers = BATCH_USERS[batch];
  const foreign = [...new Set(plan.map((e) => e.userId))].filter((u) => !batchUsers.includes(u));
  if (foreign.length > 0) {
    console.error(`plan users ${foreign.join(",")} do not belong to batch ${batch} (${batchUsers.join(",")})`);
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

const results = [];
let failed = false;
const beforeRows = {};
for (const entry of plan) {
  for (const taskId of entry.taskIds ?? []) {
    beforeRows[taskId] = db.sqlite
      .prepare("SELECT dependency_id, kind, ref_id, pinned_version_id FROM agent_space_task_dependencies WHERE task_id=?")
      .all(taskId);
  }
}
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
        metadata: { registeredBy: "w7-cutover", batch: batch ?? null, manifestSha256: manifestSha ?? null },
        actor: "w7-cutover",
      });
      results.push({ userId, methodItemId, taskId, status: "registered", methodId: methodRow.method_id, pinnedVersionId: methodRow.current_version_id, dependencyId: dep.dependency_id });
    } catch (error) {
      results.push({ userId, methodItemId, taskId, status: "failed", reason: error.message });
      failed = true;
    }
  }
}

const afterRows = {};
for (const entry of plan) {
  for (const taskId of entry.taskIds ?? []) {
    afterRows[taskId] = db.sqlite
      .prepare("SELECT dependency_id, kind, ref_id, pinned_version_id FROM agent_space_task_dependencies WHERE task_id=?")
      .all(taskId);
  }
}
console.log(JSON.stringify({ confirm, target: target ?? null, batch: batch ?? null, results, affected: { before: beforeRows, after: afterRows }, ok: !failed }, null, 1));
process.exit(failed ? 1 : 0);
