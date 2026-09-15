#!/usr/bin/env node
/**
 * 一次性补录（owner 2026-09-14 晚授权「9/08–9/11 四个交易日缺口稍微补一下」）：
 * 为 mg 行业复盘工作簿（asset_71e25a40，当前 v5）补 2026-09-08/09/09/10/11 四个
 * 交易日的复盘行。做法：在 mg scope 下新建一次性任务（不动正式任务 at_60d62fcb
 * 的 revision 链），逐字复刻 rev24 的 output/inputs 绑定（update+rollover+
 * expectedSchema+双绑定），仅指令换为补录语义（沿用 1b31b66 mgreplay 已验证的
 * 补录指令口径，扩展到 4 日期）；manual 触发单次 run（manual 不触发 T-479 失败
 * 通知，delivery=none 不推送 mg）；finally 暂停任务防止次日 19:30 误调度。
 * 跑前备份当前版本字节到 data/backup-asset71e25a40-v5-pre-backfill-20260914.xlsx。
 * 数据质量边界（1b31b66 验证结论）：涨幅榜历史全量不可得，选样近似涨停家数口径，
 * 行业级行情/资金流列不可得处如实写「数据缺失」。
 * 用法（在生产 /home/claude/invest-agent-mastra 下执行）：node scripts/mg-industry-backfill-20260914.mjs
 */
import { writeFileSync } from "node:fs";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const REAL_TASK_ID = "at_60d62fcb-5eb3-4e0e-b70b-6203680a750d";
const TEMP_TASK_ID = "mg-industry-backfill-20260914";
const BACKUP_PATH = "data/backup-asset71e25a40-v5-pre-backfill-20260914.xlsx";
const DATES = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
const CALIBER_LINE = "行业名称口径由你按当日复盘主线判断：申万一级或二级粒度均可，同一交易日内保持粒度一致；必须使用数据源的完整行业名，禁止截断、简写或自造合并名。";
const BACKFILL_INSTRUCTION = [
  `本次为补录任务：为 ${DATES.join("、")} 四个交易日各追加「当日涨幅前 10 名行业」的复盘行到绑定工作簿表尾（每个日期一组，严格使用现有 17 列表头与列序，含行业代码 pt 前缀与来源时间列）。`,
  "历史数据口径：行业资金流用行业资金流矩阵的对应日期窗口；涨停公司用涨停池按日期回查；板块涨幅榜历史快照可取每日头部行业；某列历史值确实不可得时该单元格如实写「数据缺失」，禁止用其他日期的值冒充当日值。",
  "涨停公司列无数据时写「无涨停 / 不适用」。",
  "写入前检查工作簿中已存在哪些复盘日期，只为缺失的日期补行，不重复、不改动任何已有历史行。",
  CALIBER_LINE,
].join("\n");

const { sqlite } = await import("../dist/db/index.js");
const { createAutomationTask, activateAutomationTask, pauseAutomationTask } = await import("../dist/services/automation-tasks.js");
const { readCurrentUserAsset } = await import("../dist/services/user-assets.js");
const { runGenericAutomationTaskNow } = await import("../dist/services/generic-automation-runner.js");

const taskRow = sqlite.prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_tasks WHERE task_id = ?").get(REAL_TASK_ID);
if (!taskRow) { console.error("[backfill] real task not found"); process.exit(2); }
const scope = { userId: taskRow.user_id, projectId: taskRow.project_id, instanceId: taskRow.instance_id };
const rev = sqlite.prepare("SELECT revision, output_json, inputs_json, schedule_json FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(REAL_TASK_ID);
const output = JSON.parse(rev.output_json || "{}");
const inputs = JSON.parse(rev.inputs_json || "[]");
const schedule = JSON.parse(rev.schedule_json || "{}");
console.log(`[backfill] real task rev${rev.revision} asset=${output.assetId} scope=${scope.userId}/${scope.instanceId}`);

// 跑前备份当前版本字节（直读 DB 元数据 + 磁盘文件，只读）。
const { readFileSync } = await import("node:fs");
const { resolve } = await import("node:path");
const av = sqlite.prepare("SELECT version_id, storage_path FROM user_asset_versions WHERE asset_id = ? AND version_id = (SELECT current_version_id FROM user_assets WHERE asset_id = ?)").get(output.assetId, output.assetId);
const ASSET_ROOT = "/home/claude/invest-agent-mastra/data/projects/0561c9d25755c148ce216525";
const backupBytes = readFileSync(resolve(ASSET_ROOT, av.storage_path));
writeFileSync(BACKUP_PATH, backupBytes);
console.log(`[backfill] backup ${backupBytes.length} bytes → ${BACKUP_PATH} (v=${av.version_id})`);

// 已存在日期统计（容忍列错位：扫全 17 列找日期串）。
const ExcelJS = (await import("exceljs")).default;
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(backupBytes);
const ws = wb.worksheets[0];
const existing = {};
for (let r = 1; r <= ws.rowCount; r += 1) {
  for (let c = 1; c <= ws.columnCount; c += 1) {
    const v = String(ws.getRow(r).getCell(c).value ?? "");
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) { existing[m[1]] = (existing[m[1]] ?? 0) + 1; break; }
  }
}
console.log(`[backfill] existing dates before: ${JSON.stringify(existing)} rows=${ws.rowCount}`);

// 幂等：临时任务已存在则拒绝重跑（防重复补录）。
const dup = sqlite.prepare("SELECT task_id, status FROM automation_tasks WHERE task_id = ?").get(TEMP_TASK_ID);
if (dup) { console.error(`[backfill] temp task already exists (${dup.status}) — refusing to run twice`); process.exit(2); }

const created = await createAutomationTask({
  ...scope, taskId: TEMP_TASK_ID, name: "行业复盘补录 9/08–9/11（一次性）",
  instruction: BACKFILL_INSTRUCTION, schedule,
  inputs, output, delivery: { mode: "none" },
  editSource: "script", editSourceRef: "mg-industry-backfill-20260914",
});
await activateAutomationTask({ ...scope, taskId: TEMP_TASK_ID, expectedRevision: created.currentRevision });
console.log(`[backfill] temp task created rev${created.currentRevision} delivery=none`);

try {
  const started = Date.now();
  const result = await runGenericAutomationTaskNow({
    scope, taskId: TEMP_TASK_ID, origin: "manual",
    idempotencyKey: `mg-industry-backfill-${new Date().toISOString().slice(0, 16)}`,
  });
  const run = result.run;
  console.log(`[backfill] run ${run.status} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`[backfill] err=${run.errorMessage?.slice(0, 300) ?? "none"} category=${run.errorCategory ?? "none"}`);
  console.log(`[backfill] output=${run.outputVersionId ?? "none"} summary=${run.resultSummary?.slice(0, 500) ?? "none"}`);
} finally {
  try {
    await pauseAutomationTask({ ...scope, taskId: TEMP_TASK_ID });
    console.log("[backfill] temp task paused");
  } catch (e) { console.log(`[backfill] pause failed: ${String(e).slice(0, 200)}`); }
}

// 跑后回读：目标四日行数 + 既有日期行数对照。
const current = await readCurrentUserAsset({ ...scope, assetId: output.assetId });
const wb2 = new ExcelJS.Workbook();
const buf = Buffer.from(current.bytes);
await wb2.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const ws2 = wb2.worksheets[0];
const after = {};
for (let r = 1; r <= ws2.rowCount; r += 1) {
  for (let c = 1; c <= ws2.columnCount; c += 1) {
    const v = String(ws2.getRow(r).getCell(c).value ?? "");
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) { after[m[1]] = (after[m[1]] ?? 0) + 1; break; }
  }
}
console.log(`[backfill] dates after: ${JSON.stringify(after)} rows=${ws2.rowCount} bytes=${current.bytes.length}`);
const added = DATES.map((d) => `${d}:${(after[d] ?? 0) - (existing[d] ?? 0)}`).join(" ");
const unchanged = Object.entries(existing).every(([d, n]) => (after[d] ?? 0) === n);
console.log(`[backfill] added rows — ${added}; existing dates unchanged: ${unchanged}`);
