#!/usr/bin/env node
/**
 * One-time test (2026-09-11 深夜, owner 问询「之前几天的行业复盘能过吗」):
 * 用 mgreplay 镜像任务验证 9-8/9-9/9-10 三个缺失交易日的补录链路——历史
 * 数据可达性 + 新格式级列规则下的入库。流程：镜像任务 rev3 换补录指令
 * （列规则不动）→ 手动真跑 → 回读各日期入库行 → 恢复常规「当日」指令
 * （rev4，保持任务语义不被补录指令污染）。工作簿沿用 mgreplay 口径测试簿
 * （已有 9-11 行，补录日判重不冲突）。
 * 用法：node scripts/mgreplay-backfill-test.mjs
 */
import { readFileSync } from "node:fs";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const TASK_ID = "mgreplay-industry-chain-test";
const DATES = ["2026-09-08", "2026-09-09", "2026-09-10"];
const CALIBER_LINE = "行业名称口径由你按当日复盘主线判断：申万一级或二级粒度均可，同一交易日内保持粒度一致；必须使用数据源的完整行业名，禁止截断、简写或自造合并名。";
const NORMAL_INSTRUCTION_HEAD = "每个交易日 19:30 完成行业复盘：获取当日涨幅前 10 名行业，逐行业一行追加到绑定工作簿表尾，严格使用工作簿现有 17 列表头与列序（含行业代码 pt 前缀与来源时间列）；涨停公司列写当日行业内涨停公司（无则写「无涨停 / 不适用」）；资金流不可得时该单元格写「数据缺失」。";

const { sqlite } = await import("../dist/db/index.js");
const { updateAutomationTask, activateAutomationTask } = await import("../dist/services/automation-tasks.js");
const { readCurrentUserAsset } = await import("../dist/services/user-assets.js");
const { runGenericAutomationTaskNow } = await import("../dist/services/generic-automation-runner.js");

const taskRow = sqlite.prepare("SELECT task_id, user_id, project_id, instance_id, status FROM automation_tasks WHERE task_id = ?").get(TASK_ID);
const scope = { userId: taskRow.user_id, projectId: taskRow.project_id, instanceId: taskRow.instance_id };
const rev = sqlite.prepare(`
  SELECT revision, name, instruction, schedule_json, inputs_json, output_json, delivery_json
  FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1
`).get(TASK_ID);
const output = JSON.parse(rev.output_json || "{}");
const assetId = output.assetId;

// rev3：补录指令（沿用绑定工作簿与列规则，只换指令语义）。
const backfillInstruction = [
  `本次为补录任务：为 ${DATES.join("、")} 三个交易日各追加「当日涨幅前 10 名行业」的复盘行到绑定工作簿表尾（每个日期一组，严格使用现有 17 列表头与列序，含行业代码 pt 前缀与来源时间列）。`,
  "历史数据口径：行业资金流用行业资金流矩阵的对应日期窗口；涨停公司用涨停池按日期回查；板块涨幅榜历史快照可取每日头部行业；某列历史值确实不可得时该单元格如实写「数据缺失」，禁止用其他日期的值冒充当日值。",
  "涨停公司列无数据时写「无涨停 / 不适用」。",
  CALIBER_LINE,
].join("\n");
const updated = await updateAutomationTask({
  ...scope, taskId: TASK_ID, expectedRevision: rev.revision,
  name: rev.name, instruction: backfillInstruction,
  schedule: JSON.parse(rev.schedule_json || "{}"),
  inputs: JSON.parse(rev.inputs_json || "[]"),
  output, delivery: JSON.parse(rev.delivery_json || "{}"),
  editSource: "script", editSourceRef: "mgreplay-backfill-test-20260911",
});
await activateAutomationTask({ ...scope, taskId: TASK_ID, expectedRevision: updated.currentRevision });
console.log(`[backfill-test] rev${updated.currentRevision} instruction=backfill(${DATES.join("/")})`);

try {
  const started = Date.now();
  const result = await runGenericAutomationTaskNow({
    scope, taskId: TASK_ID, origin: "manual",
    idempotencyKey: `mgreplay-backfill-test-${new Date().toISOString().slice(0, 16)}`,
  });
  console.log(`[backfill-test] run ${result.run.status} in ${Math.round((Date.now() - started) / 1000)}s delivery=${result.run.deliveryStatus}`);
  console.log(`[backfill-test] err=${result.run.errorMessage?.slice(0, 200) ?? "none"}`);
  console.log(`[backfill-test] summary: ${result.run.resultSummary?.slice(0, 400) ?? "none"}`);
} finally {
  // 无论成败，恢复常规「当日」指令，任务语义不留在补录态。
  const latest = sqlite.prepare("SELECT revision, name, instruction, schedule_json, inputs_json, output_json, delivery_json FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(TASK_ID);
  const restored = await updateAutomationTask({
    ...scope, taskId: TASK_ID, expectedRevision: latest.revision,
    name: latest.name, instruction: `${NORMAL_INSTRUCTION_HEAD}\n${CALIBER_LINE}`,
    schedule: JSON.parse(latest.schedule_json || "{}"),
    inputs: JSON.parse(latest.inputs_json || "[]"),
    output: JSON.parse(latest.output_json || "{}"), delivery: JSON.parse(latest.delivery_json || "{}"),
    editSource: "script", editSourceRef: "mgreplay-backfill-test-restore",
  });
  await activateAutomationTask({ ...scope, taskId: TASK_ID, expectedRevision: restored.currentRevision });
  console.log(`[backfill-test] instruction restored at rev${restored.currentRevision}`);
}

// 回读工作簿：按日期统计入库行与第 4 列名称。
const current = await readCurrentUserAsset({ ...scope, assetId });
const ExcelJS = (await import("exceljs")).default;
const wb = new ExcelJS.Workbook();
const buf = Buffer.from(current.bytes);
await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const sheet = wb.getWorksheet("数据");
const byDate = {};
for (let r = 3; r <= sheet.rowCount; r += 1) {
  const row = sheet.getRow(r);
  const date = String(row.getCell(2).value ?? "").trim().slice(0, 10);
  const name = String(row.getCell(4).value ?? "").trim();
  if (date && name) (byDate[date] ??= []).push(name);
}
for (const [date, names] of Object.entries(byDate)) {
  console.log(`[backfill-test] ${date}: ${names.length} 行 — ${names.join("、")}`);
}
