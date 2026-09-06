#!/usr/bin/env node
/**
 * T-480 mg 工作簿 schema 对齐：为 update 模式表格任务显式提交带
 * expectedSchema 的新 revision（append-only + 审计），把任务契约绑定到
 * 绑定资产当前版本的实测结构。幂等：已对齐或契约一致时跳过。
 *
 * 用法（生产，需与部署后的 dist 同源）：
 *   set -a; . ./.env; set +a
 *   node scripts/align-mg-workbook-schema.mjs --dist ./dist [--dry-run] \
 *     [--tasks at_60d62fcb-5eb3-4e0e-b70b-6203680a750d,at_d64649ad-d96f-447b-a462-91d89c01de5d]
 */
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const distArg = args.find((a) => a.startsWith("--dist="))?.slice(7) ?? (args.includes("--dist") ? args[args.indexOf("--dist") + 1] : "./dist");
const defaultTasks = [
  "at_60d62fcb-5eb3-4e0e-b70b-6203680a750d", // mg 行业复盘（trading_days 19:30 update）
  "at_d64649ad-d96f-447b-a462-91d89c01de5d", // mg 持仓复盘（trading_days 09:30 update）
];
const tasksArg = args.find((a) => a.startsWith("--tasks="))?.slice(8);
const taskIds = (tasksArg ? tasksArg.split(",") : defaultTasks).map((s) => s.trim()).filter(Boolean);

const dist = path.resolve(distArg);
const { updateAutomationTask, activateAutomationTask } = await import(path.join(dist, "services/automation-tasks.js"));
const { readUserAssetVersion } = await import(path.join(dist, "services/user-assets.js"));
const { snapshotWorkbookSchema } = await import(path.join(dist, "services/automation-spreadsheet.js"));
const { sqlite } = await import(path.join(dist, "db/index.js"));

function schemaEquals(a, b) {
  if (!a || !b) return false;
  if (a.columnCount !== b.columnCount || a.headerRow !== b.headerRow) return false;
  const ah = a.header ?? [];
  const bh = b.header ?? [];
  if (ah.length !== bh.length) return false;
  return ah.every((v, i) => v === bh[i]);
}

for (const taskId of taskIds) {
  const taskRow = sqlite.prepare("SELECT task_id, user_id, project_id, instance_id, status, current_revision FROM automation_tasks WHERE task_id = ?").get(taskId);
  if (!taskRow) { console.log(`[align] ${taskId} SKIP task not found`); continue; }
  const rev = sqlite.prepare(`
    SELECT revision, instruction, schedule_json, inputs_json, output_json, delivery_json, name
    FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1
  `).get(taskId);
  const output = JSON.parse(rev.output_json || "{}");
  if (output.mode !== "update") { console.log(`[align] ${taskId} SKIP output.mode=${output.mode}`); continue; }

  const scope = { userId: taskRow.user_id, projectId: taskRow.project_id, instanceId: taskRow.instance_id };
  const asset = sqlite.prepare("SELECT current_version_id FROM user_assets WHERE asset_id = ?").get(output.assetId);
  if (!asset?.current_version_id) { console.log(`[align] ${taskId} SKIP bound asset has no current version`); continue; }
  const version = await readUserAssetVersion({ ...scope, assetId: output.assetId, versionId: asset.current_version_id });
  const schema = await snapshotWorkbookSchema(version.bytes);
  const label = `${taskId.slice(0, 18)}… rev${rev.revision} asset=${version.descriptor.fileName}`;
  console.log(`[align] ${label} 实测 ${schema.columnCount} 列 headerRow=${schema.headerRow}`);

  if (schemaEquals(output.expectedSchema, schema)) { console.log(`[align] ${taskId} OK already aligned`); continue; }
  if (dryRun) { console.log(`[align] ${taskId} DRY-RUN would commit revision ${rev.revision + 1} with expectedSchema(${schema.columnCount} 列)`); continue; }

  const previousStatus = taskRow.status;
  const updated = await updateAutomationTask({
    ...scope,
    taskId,
    expectedRevision: rev.revision,
    name: rev.name,
    instruction: rev.instruction,
    schedule: JSON.parse(rev.schedule_json || "{}"),
    inputs: JSON.parse(rev.inputs_json || "[]"),
    output: { ...output, expectedSchema: schema },
    delivery: JSON.parse(rev.delivery_json || "{}"),
    editSource: "script",
    editSourceRef: "t480-workbook-schema-align",
  });
  console.log(`[align] ${taskId} committed revision ${updated.currentRevision}`);
  if (previousStatus === "active") {
    const active = await activateAutomationTask({ ...scope, taskId, expectedRevision: updated.currentRevision });
    console.log(`[align] ${taskId} re-activated status=${active.status} next_run=${active.nextRunAt ?? "n/a"}`);
  } else {
    console.log(`[align] ${taskId} kept status=${previousStatus}（非 active 不自动激活）`);
  }
  const check = sqlite.prepare("SELECT output_json FROM automation_task_revisions WHERE task_id = ? AND revision = ?").get(taskId, updated.currentRevision);
  const committed = JSON.parse(check.output_json).expectedSchema;
  console.log(`[align] ${taskId} verify committedSchema columns=${committed?.columnCount} headerRow=${committed?.headerRow} headerLen=${committed?.header?.length ?? "none"}`);
}
console.log("[align] done");
