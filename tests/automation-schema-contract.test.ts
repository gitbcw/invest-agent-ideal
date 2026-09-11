import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-schema-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const baseScope = { userId: "schema-user", projectId: "invest-agent", instanceId: "schema-instance" };
const HEADERS_17 = ["序号", "复盘日期", "行业代码", "行业名称", "当日涨跌幅(%)", "主力净流入(亿元)", "5日主力净流入(亿元)", "成交额(亿元)", "涨跌家数", "涨停公司", "已删除：公司涨幅(%)", "资金流入较强公司", "公司主力净流入(亿元)", "趋势判断", "主要原因", "验证条件/风险", "来源与时间"];

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const userAssets = await import("../src/services/user-assets.js");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  await registerTestProject(baseScope);
  return { db, automation, runner, userAssets };
})();

/** 标题行 r1（合并大标题，复刻 mg 复盘形态）+ 表头 r2 + 数据行。 */
async function makeWorkbookBytes(columnCount: number, titleRow: boolean, dataRows = 1): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("数据");
  let row = 1;
  if (titleRow) {
    ws.getCell(row, 1).value = "2026年测试复盘表";
    ws.mergeCells(row, 1, row, columnCount);
    row += 1;
  }
  ws.getRow(row).values = HEADERS_17.slice(0, columnCount);
  row += 1;
  for (let i = 0; i < dataRows; i += 1) {
    ws.getRow(row + i).values = Array.from({ length: columnCount }, (_, c) => `v${i}-${c}`);
  }
  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data);
}

async function createUpdateTask(taskId: string, assetId: string, extra: Record<string, unknown> = {}) {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId,
    name: `schema测试-${taskId}`,
    instruction: "更新表格。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: { mode: "update" as const, assetId, versionPolicy: "latest" as const, ...extra },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });
  return task;
}

test("creating an xlsx update task snapshots expectedSchema from the bound asset (contract compatible path)", async () => {
  const { db, automation, userAssets } = await fixture;
  const bytes = await makeWorkbookBytes(17, true);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "2026年09月行业复盘表_序号分段版.xlsx", bytes, source: "upload" });
  const task = await createUpdateTask("schema-compatible", asset.assetId);

  const outputJson = db.sqlite.prepare("SELECT output_json FROM automation_task_revisions WHERE task_id = ? AND revision = 1").get(task.taskId) as { output_json: string };
  const output = JSON.parse(outputJson.output_json);
  assert.equal(output.expectedSchema.columnCount, 17);
  // 2026-09-11 修复：合并标题行（A1:Q1）会被 ExcelJS 铺满 17 格，此前
  // findLikelyHeaderRow 因此把标题行当表头，契约 header 17 项全是文件名
  //（rev21 空 schema）。修复后剔除合并覆盖格再计数，真实表头行 r2 胜出。
  assert.equal(output.expectedSchema.headerRow, 2);
  assert.deepEqual(output.expectedSchema.header, HEADERS_17);

  // 契约兼容：17 列 appendRows 正常执行。
  const result = await (await fixture).runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "sc-run-1",
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: {
        summary: "今日行业复盘完成，数据已追加。",
        shouldNotify: false,
        stagedOutput: { operation: "appendRows" as const, rows: [Array.from({ length: 17 }, (_, c) => `r-${c}`)], skipIfCellMatches: { column: 1, value: "r-0" } },
      },
    }),
  });
  assert.equal(result.run.status, "succeeded");
  assert.ok(automation.getAutomationTask);
});

test("bound workbook drifting to 18 columns fails fast before model execution with an actionable message", async () => {
  const { db, userAssets, runner } = await fixture;
  const bytes17 = await makeWorkbookBytes(17, true);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "drift-table.xlsx", bytes: bytes17, source: "upload" });
  const task = await createUpdateTask("schema-drift", asset.assetId);

  // 资产被追加 18 列新版本（模拟人工改表/漂移）。
  const bytes18 = await makeWorkbookBytes(18, true);
  await userAssets.uploadUserAssetVersion({ ...baseScope, assetId: asset.assetId, fileName: "drift-table.xlsx", bytes: bytes18, source: "upload" });

  let executorCalls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "sd-run-1",
    executor: async () => { executorCalls += 1; throw new Error("must not be reached"); },
  });
  assert.equal(result.run.status, "failed");
  assert.equal(executorCalls, 0, "schema mismatch must block before any model call");
  const runRow = db.sqlite.prepare("SELECT error_message, error_category FROM automation_task_runs WHERE run_id = ?").get(result.run.runId) as { error_message: string; error_category: string };
  assert.ok(runRow.error_message.includes("AUTOMATION_SCHEMA_MISMATCH"), runRow.error_message);
  assert.ok(runRow.error_message.includes("17") && runRow.error_message.includes("18"), runRow.error_message);
  assert.ok(runRow.error_message.includes("编辑"), "must tell the user how to act");
  assert.equal(runRow.error_category, "invalid_input");
});

test("known upgrade path: re-saving the task re-snapshots the drifted schema and the run succeeds", async () => {
  const { db, automation, userAssets, runner } = await fixture;
  const bytes17 = await makeWorkbookBytes(17, true);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "upgrade-table.xlsx", bytes: bytes17, source: "upload" });
  const task = await createUpdateTask("schema-upgrade", asset.assetId);
  const bytes18 = await makeWorkbookBytes(18, true);
  await userAssets.uploadUserAssetVersion({ ...baseScope, assetId: asset.assetId, fileName: "upgrade-table.xlsx", bytes: bytes18, source: "upload" });

  // 用户在 Portal 重新保存任务（output 原样重发，不带 expectedSchema）→ 新
  // revision 自动快照 18 列（已知合法升级的确认动作）。
  await automation.updateAutomationTask({
    ...baseScope,
    taskId: task.taskId,
    expectedRevision: 1,
    instruction: "更新表格。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: { mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const },
    delivery: { mode: "none" },
  });
  const rev2 = db.sqlite.prepare("SELECT output_json FROM automation_task_revisions WHERE task_id = ? AND revision = 2").get(task.taskId) as { output_json: string };
  assert.equal(JSON.parse(rev2.output_json).expectedSchema.columnCount, 18);
  // 编辑产生新 revision 后任务回到 paused，需重新激活（生产 Portal 编辑流程同型）。
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 2 });

  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "su-run-1",
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: {
        summary: "升级后的表结构复盘完成，数据已追加。",
        shouldNotify: false,
        stagedOutput: { operation: "appendRows" as const, rows: [Array.from({ length: 18 }, (_, c) => `u-${c}`)], skipIfCellMatches: { column: 1, value: "u-0" } },
      },
    }),
  });
  assert.ok(result.run.status === "succeeded", JSON.stringify(result.run.errorMessage));
});

test("legacy revisions without expectedSchema keep today's behavior (no schema gate)", async () => {
  const { db, userAssets, runner } = await fixture;
  const bytes17 = await makeWorkbookBytes(17, true);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "legacy-table.xlsx", bytes: bytes17, source: "upload" });
  const task = await createUpdateTask("schema-legacy", asset.assetId);
  // 模拟存量 revision：直接抹掉快照（T-480 之前的历史任务形态）。
  db.sqlite.prepare(`
    UPDATE automation_task_revisions SET output_json = json_remove(output_json, '$.expectedSchema')
    WHERE task_id = ? AND revision = 1
  `).run(task.taskId);

  const bytes18 = await makeWorkbookBytes(18, true);
  await userAssets.uploadUserAssetVersion({ ...baseScope, assetId: asset.assetId, fileName: "legacy-table.xlsx", bytes: bytes18, source: "upload" });

  let executorCalls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "sl-run-1",
    executor: async () => {
      executorCalls += 1;
      return {
        content: { type: "text" as const, text: "ok" }, finished: true,
        data: {
          summary: "无契约任务照常执行，结果已生成。",
          shouldNotify: false,
          stagedOutput: { operation: "appendRows" as const, rows: [Array.from({ length: 18 }, (_, c) => `l-${c}`)], skipIfCellMatches: { column: 1, value: "l-0" } },
        },
      };
    },
  });
  assert.ok(result.run.status === "succeeded", JSON.stringify(result.run.errorMessage));
  assert.equal(executorCalls, 1, "no contract means no pre-model gate (appendRows guard still applies)");
});

test("monthly rollover create with a drifted schema is rejected at the service layer", async () => {
  const { db, automation, userAssets, runner } = await fixture;
  const bytes17 = await makeWorkbookBytes(17, true);
  // 绑定“上个月”的文件名，本月目标不存在 → rollover create 激活。
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "2025年12月schema测试表.xlsx", bytes: bytes17, source: "upload" });
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId: "schema-rollover",
    name: "rollover测试",
    instruction: "月度滚动更新。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: {
      mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const,
      rollover: { kind: "monthly" as const, fileNamePattern: "{YYYY}年{MM}月schema测试表.xlsx" },
    },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });
  assert.equal(JSON.parse(db.sqlite.prepare("SELECT output_json o FROM automation_task_revisions WHERE task_id=? AND revision=1").get(task.taskId).o).expectedSchema.columnCount, 17);

  const now = new Date();
  const target = `${now.getFullYear()}年${String(now.getMonth() + 1).padStart(2, "0")}月schema测试表.xlsx`;
  const wrongBytes = await makeWorkbookBytes(16, true, 0); // 16 列新文件 vs 17 列契约
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "sr-run-1",
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: {
        summary: "新月表已生成，结构沿用上月。",
        shouldNotify: false,
        stagedOutput: { operation: "create", fileName: target, base64: wrongBytes.toString("base64") },
      },
    }),
  });
  assert.equal(result.run.status, "failed");
  const runRow = db.sqlite.prepare("SELECT error_message FROM automation_task_runs WHERE run_id = ?").get(result.run.runId) as { error_message: string };
  assert.ok(runRow.error_message.includes("AUTOMATION_SCHEMA_MISMATCH"), runRow.error_message);
  assert.ok(runRow.error_message.includes("16"), runRow.error_message);
});

test("columnRules: misaligned rows (2026-09-04) and secondary-universe names (2026-09-07) are rejected with teaching messages", async () => {
  const { automation, userAssets, runner } = await fixture;
  const bytes = await makeWorkbookBytes(17, true, 1);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "rules-table.xlsx", bytes, source: "upload" });
  const SW1 = ["农林牧渔", "基础化工", "钢铁", "有色金属", "电子", "家用电器", "食品饮料", "纺织服饰", "轻工制造", "医药生物", "公用事业", "交通运输", "房地产", "商贸零售", "社会服务", "综合", "建筑材料", "建筑装饰", "电力设备", "国防军工", "计算机", "传媒", "通信", "银行", "非银金融", "汽车", "机械设备", "环保", "美容护理", "石油石化", "煤炭"];
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId: "schema-column-rules",
    name: "列语义规则任务",
    instruction: "按 17 列契约追加当日行业复盘行。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: {
      mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const,
      expectedSchema: {
        columnCount: 17,
        headerRow: 2,
        header: HEADERS_17,
        columnRules: {
          "2": { kind: "date", required: true },
          "4": { required: true, enumValues: SW1 },
          "5": { kind: "number" },
          "6": { kind: "number", allowMissing: ["数据缺失"] },
          "7": { kind: "number", allowMissing: ["数据缺失"] },
          "8": { kind: "number", allowMissing: ["数据缺失"] },
        },
      },
    },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });

  // 2026-09-07 形态：日期串漂到第 1 列、序号落第 2 列、申万二级名+截断名、资金流「数据缺失」。
  const driftedRow = ["2026-09-07", "8", "农产品加", "农产品加", "+3.74%", "数据缺失", "数据缺失", "1. 金健米业", "强势反弹", "粮油安全", "", "", "", "", "", "", ""];
  let repairCalls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "rules-run-1",
    executor: async (input) => {
      if (input.repairContext) {
        repairCalls += 1;
        return {
          content: { type: "text" as const, text: "ok" },
          finished: true,
          data: {
            summary: "修复后按 17 列对齐追加。",
            shouldNotify: false,
            stagedOutput: {
              operation: "appendRows" as const,
              rows: [[9, "2026-09-07", "pt01801230", "综合", "1.23", "2.5", "-1.5", "120.4", "10涨/5跌", "无涨停", "", "", "", "观察", "原因", "风险", "来源 19:31"]],
              skipIfCellMatches: { column: 2, value: "2026-09-07" },
            },
          },
        };
      }
      return {
        content: { type: "text" as const, text: "ok" },
        finished: true,
        data: {
          summary: "已追加。",
          shouldNotify: false,
          stagedOutput: { operation: "appendRows" as const, rows: [driftedRow], skipIfCellMatches: { column: 1, value: "2026-09-07" } },
        },
      };
    },
  });
  assert.equal(result.run.status, "succeeded", "violating rows must be rejected, repaired rows must commit");
  assert.equal(repairCalls, 1, "the column-rule violation must trigger exactly one self-repair round");
  const runRow = (await fixture).db.sqlite.prepare("SELECT error_message FROM automation_task_runs WHERE run_id = ?").get(result.run.runId) as { error_message: string };
  void runRow;
  // 违规信息只存在于日志/自纠上下文；成功 run 不留 error。规则命中的核心断言：
  // repair 轮被触发（否则 driftedRow 会直接入库），且入库行是修复后的对齐行。
  const ExcelJS = (await import("exceljs")).default;
  const current = await userAssets.readCurrentUserAsset({ ...baseScope, assetId: asset.assetId });
  const wb = new ExcelJS.Workbook();
  const buf = Buffer.from(current.bytes);
  await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const sheet = wb.getWorksheet("数据")!;
  const lastRow = (sheet.getRow(sheet.rowCount).values as unknown[]).slice(1);
  assert.equal(lastRow[1], "2026-09-07", "date lands in column 2 after repair");
  assert.equal(lastRow[3], "综合", "SW-L1 name lands in column 4 after repair");
});

test("columnRules violations that survive repair fail the run instead of committing garbage", async () => {
  const { automation, userAssets, runner } = await fixture;
  const bytes = await makeWorkbookBytes(17, true, 1);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "rules-table-2.xlsx", bytes, source: "upload" });
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId: "schema-column-rules-fail",
    name: "列语义规则失败任务",
    instruction: "按 17 列契约追加当日行业复盘行。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: {
      mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const,
      expectedSchema: {
        columnCount: 17,
        headerRow: 2,
        header: HEADERS_17,
        columnRules: { "4": { required: true, enumValues: ["银行", "煤炭"] } },
      },
    },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });
  const badRow = ["1", "2026-09-04", "pt01801780", "金融", "0.87", "280.75", "0.27", "-0.43", "35涨", "无涨停", "", "", "", "观察", "原因", "风险", "来源"];
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "rules-fail-1",
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: {
        summary: "已追加。",
        shouldNotify: false,
        stagedOutput: { operation: "appendRows" as const, rows: [badRow], skipIfCellMatches: { column: 2, value: "2026-09-04" } },
      },
    }),
  });
  assert.equal(result.run.status, "failed", "enum drift must fail the run after the wasted repair round");
  const current = await userAssets.readCurrentUserAsset({ ...baseScope, assetId: asset.assetId });
  assert.equal(current.descriptor.versionId, asset.currentVersionId, "no version may be committed for rule-violating rows");
});

test("text-kind column rules survive the task-edit boundary intact (2026-09-12 caliber-to-agent fix)", async () => {
  const { automation, userAssets } = await fixture;
  const bytes = await makeWorkbookBytes(17, true, 1);
  const asset = await userAssets.createUserAsset({ ...baseScope, fileName: "text-rules-table.xlsx", bytes, source: "upload" });
  // rev24 形态：行业名称列不绑词表，只带格式级字段。归一化若逐字段白名单
  // 拷贝漏掉 maxLength/balancedBrackets，规则会静默降级为纯必填。
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId: "schema-text-rules",
    name: "文本格式规则任务",
    instruction: "按 17 列契约追加当日行业复盘行。",
    schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
    output: {
      mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const,
      expectedSchema: {
        columnCount: 17,
        headerRow: 2,
        header: HEADERS_17,
        columnRules: {
          "2": { kind: "date", required: true },
          "4": { kind: "text", required: true, maxLength: 30, balancedBrackets: true },
        },
      },
    },
    delivery: { mode: "none" },
  });
  const persisted = task.revision.output.mode === "update"
    ? task.revision.output.expectedSchema?.columnRules?.["4"]
    : undefined;
  assert.deepEqual(persisted, { kind: "text", required: true, maxLength: 30, balancedBrackets: true }, "format-level fields must persist, not be stripped by normalization");

  // 编辑边界同一条链路：updateAutomationTask 也不能剥字段。
  const updated = await automation.updateAutomationTask({
    ...baseScope, taskId: task.taskId, editSource: "test",
    instruction: "按 17 列契约追加当日行业复盘行（编辑后）。",
  });
  const afterEdit = updated.revision.output.mode === "update"
    ? updated.revision.output.expectedSchema?.columnRules?.["4"]
    : undefined;
  assert.deepEqual(afterEdit, { kind: "text", required: true, maxLength: 30, balancedBrackets: true }, "edit must preserve format-level fields");

  // 非法取值在边界拒绝。
  await assert.rejects(
    automation.createAutomationTask({
      ...baseScope,
      taskId: "schema-text-rules-bad",
      name: "非法文本规则",
      instruction: "更新表格。",
      schedule: { frequency: "trading_days" as const, time: "19:30", timezone: "Asia/Shanghai" },
      output: {
        mode: "update" as const, assetId: asset.assetId, versionPolicy: "latest" as const,
        expectedSchema: { columnCount: 17, headerRow: 2, header: HEADERS_17, columnRules: { "4": { kind: "text", maxLength: 0 } } },
      },
      delivery: { mode: "none" },
    }),
    /maxLength must be an integer in \[1,500\]/,
  );
});
