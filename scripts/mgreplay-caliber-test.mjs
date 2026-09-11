#!/usr/bin/env node
/**
 * One-time test (2026-09-11 晚, owner 授权「现在就用 mgreplay 用户做测试」):
 * 口径归还 agent 修复（5fde450）的生产全链验证。为 mgreplay 的行业复盘
 * 镜像任务（mgreplay-industry-chain-test）新建空白工作簿 + rev2（col4 从
 * 申万词表枚举换 kind=text 格式级规则、说明去「仅一级」约束并追加口径行），
 * 然后手动触发真实执行链，回读入库行验证：一级/二级名均放行、规则字段
 * 穿过修订边界未剥离、截断/超长仍被拦（后者由单测覆盖，此处验主路径）。
 *
 * 前置：已部署含 kind=text 校验与边界透传的版本。幂等：以 run 是否完成
 * 为准；重复执行前先看 rev2 是否已存在（会再出新修订，注意 task 状态）。
 * 用法：node scripts/mgreplay-caliber-test.mjs [--dry-run]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const dryRun = process.argv.includes("--dry-run");
const TASK_ID = "mgreplay-industry-chain-test";
const CALIBER_LINE = "行业名称口径由你按当日复盘主线判断：申万一级或二级粒度均可，同一交易日内保持粒度一致；必须使用数据源的完整行业名，禁止截断、简写或自造合并名。";

const rules = JSON.parse(readFileSync(new URL("./industry-review-column-rules.json", import.meta.url), "utf8"));
if (rules["4"]?.kind !== "text") {
  console.error("[caliber-test] rules JSON col4 is not kind=text — refusing to run with a stale rules file");
  process.exit(2);
}

const { sqlite } = await import("../dist/db/index.js");
const { updateAutomationTask, activateAutomationTask } = await import("../dist/services/automation-tasks.js");
const { createUserAsset, readCurrentUserAsset } = await import("../dist/services/user-assets.js");
const { snapshotWorkbookSchema } = await import("../dist/services/automation-spreadsheet.js");
const { runGenericAutomationTaskNow } = await import("../dist/services/generic-automation-runner.js");

const taskRow = sqlite.prepare("SELECT task_id, user_id, project_id, instance_id, status FROM automation_tasks WHERE task_id = ?").get(TASK_ID);
if (!taskRow) { console.error(`[caliber-test] task not found: ${TASK_ID}`); process.exit(2); }
const scope = { userId: taskRow.user_id, projectId: taskRow.project_id, instanceId: taskRow.instance_id };
const rev = sqlite.prepare(`
  SELECT revision, name, instruction, schedule_json, inputs_json, output_json, delivery_json
  FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1
`).get(TASK_ID);
const output = JSON.parse(rev.output_json || "{}");
const headers = output.expectedSchema?.header ?? [];

// 1) 新空白工作簿：合并标题行 r1 + 17 列表头 r2，零数据行（保证真实追加而非判重跳过）。
const ExcelJS = (await import("exceljs")).default;
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("数据");
ws.getCell(1, 1).value = "2026年09月行业复盘（mgreplay 口径测试）";
ws.mergeCells(1, 1, 1, headers.length);
ws.getRow(2).values = headers;
const bytes = Buffer.from(await wb.xlsx.writeBuffer());

console.log(`[caliber-test] task rev${rev.revision} status=${taskRow.status} headers=${headers.length}`);
if (dryRun) { console.log("[caliber-test] dry-run, no changes"); process.exit(0); }

const asset = await createUserAsset({ ...scope, name: "行业复盘（mgreplay 口径测试）", fileName: `行业复盘-口径测试-${new Date().toISOString().slice(0, 10)}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes, source: "system" });
const schema = await snapshotWorkbookSchema((await readCurrentUserAsset({ ...scope, assetId: asset.assetId })).bytes);
console.log(`[caliber-test] fresh asset=${asset.assetId} snapshot=${schema.columnCount}列 headerRow=${schema.headerRow}`);

// 2) rev2：绑定新工作簿 + 格式级列规则 + 口径说明（去「仅一级行业」约束）。
const nextInstruction = `${rev.instruction
  .replace("获取当日申万一级行业（仅一级行业）涨幅前 10 名", "获取当日涨幅前 10 名行业")}\n${CALIBER_LINE}`;
const updated = await updateAutomationTask({
  ...scope,
  taskId: TASK_ID,
  expectedRevision: rev.revision,
  name: rev.name,
  instruction: nextInstruction,
  schedule: JSON.parse(rev.schedule_json || "{}"),
  inputs: JSON.parse(rev.inputs_json || "[]"),
  output: { ...output, assetId: asset.assetId, expectedSchema: { ...schema, columnRules: rules } },
  delivery: JSON.parse(rev.delivery_json || "{}"),
  editSource: "script",
  editSourceRef: "mgreplay-caliber-test-20260911",
});
if (taskRow.status === "active") await activateAutomationTask({ ...scope, taskId: TASK_ID, expectedRevision: updated.currentRevision });
const committed = JSON.parse(sqlite.prepare("SELECT output_json FROM automation_task_revisions WHERE task_id = ? AND revision = ?").get(TASK_ID, updated.currentRevision).output_json);
console.log(`[caliber-test] rev${updated.currentRevision} col4=${JSON.stringify(committed.expectedSchema.columnRules["4"])} caliberLine=${committed === null || nextInstruction.includes(CALIBER_LINE)}`);

// 3) 手动触发真实执行链（模型取数 + appendRows 过新校验）。
const started = Date.now();
const result = await runGenericAutomationTaskNow({
  scope, taskId: TASK_ID, origin: "manual",
  idempotencyKey: `mgreplay-caliber-test-${new Date().toISOString().slice(0, 16)}`,
});
console.log(`[caliber-test] run ${result.run.status} in ${Math.round((Date.now() - started) / 1000)}s delivery=${result.run.deliveryStatus} err=${result.run.errorMessage?.slice(0, 160) ?? "none"}`);
console.log(`[caliber-test] summary: ${result.run.resultSummary?.slice(0, 300) ?? "none"}`);

// 4) 回读入库行：第 4 列行业名（任何粒度完整名都应放行入库）。
const current = await readCurrentUserAsset({ ...scope, assetId: asset.assetId });
const wb2 = new ExcelJS.Workbook();
const buf = Buffer.from(current.bytes);
await wb2.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const sheet = wb2.getWorksheet("数据");
const names = [];
for (let r = 3; r <= sheet.rowCount; r += 1) {
  const name = sheet.getRow(r).getCell(4).value;
  if (name !== null && name !== undefined && String(name).trim()) names.push(String(name));
}
console.log(`[caliber-test] appended col4 names (${names.length}): ${names.join("、") || "NONE"}`);
