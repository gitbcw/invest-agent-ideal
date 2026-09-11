import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

import { appendRowsToXlsxBytes, inspectAutomationXlsx, transformXlsxBytes, writeAutomationSpreadsheetHelper } from "../src/services/automation-spreadsheet.js";

const execFileAsync = promisify(execFile);

test("automation spreadsheet helper applies workbook structure and formatting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-sheet-helper-"));
  try {
    const workbookPath = path.join(directory, "tracking.xlsx");
    const changesPath = path.join(directory, "changes.json");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("数据").addRow(["名称", "数值"]);
    await workbook.xlsx.writeFile(workbookPath);
    const helper = await writeAutomationSpreadsheetHelper(directory);
    await writeFile(changesPath, JSON.stringify({
      setCells: [
        { sheet: "数据", row: 2, column: 1, value: "煤炭", font: { bold: true, color: "#235C3A" }, fillColor: "E8F2EA", alignment: { horizontal: "center", wrapText: true } },
        { sheet: "数据", row: 2, column: 2, formula: "1+2", result: 3, numberFormat: "0.00" },
      ],
      setColumnWidths: [{ sheet: "数据", column: 1, width: 24 }],
      setRowHeights: [{ sheet: "数据", row: 2, height: 28 }],
      mergeCells: [{ sheet: "数据", range: "A3:B3" }],
      freezePanes: [{ sheet: "数据", ySplit: 1 }],
      autoFilters: [{ sheet: "数据", range: "A1:B2" }],
      createSheets: [{ name: "说明" }],
    }));
    await execFileAsync(process.execPath, [path.join(directory, helper), "apply", workbookPath, changesPath]);

    const updated = new ExcelJS.Workbook();
    await updated.xlsx.readFile(workbookPath);
    const sheet = updated.getWorksheet("数据")!;
    assert.equal(sheet.getCell("A2").value, "煤炭");
    assert.equal(sheet.getCell("A2").font.bold, true);
    assert.deepEqual(sheet.getCell("B2").value, { formula: "1+2", result: 3 });
    assert.equal(sheet.getColumn(1).width, 24);
    assert.equal(sheet.getRow(2).height, 28);
    assert.equal(sheet.getCell("B3").isMerged, true);
    assert.equal(sheet.views[0]?.state, "frozen");
    assert.ok(updated.getWorksheet("说明"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automation spreadsheet helper creates a new structured workbook", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-sheet-create-"));
  try {
    const helper = await writeAutomationSpreadsheetHelper(directory);
    const workbookPath = path.join(directory, "created.xlsx");
    const changesPath = path.join(directory, "changes.json");
    await writeFile(changesPath, JSON.stringify({
      createSheets: [{ name: "数据" }],
      setCells: [
        { sheet: "数据", row: 1, column: 1, value: "名称", font: { bold: true } },
        { sheet: "数据", row: 2, column: 1, value: "煤炭" },
      ],
      setColumnWidths: [{ sheet: "数据", column: 1, width: 18 }],
      freezePanes: [{ sheet: "数据", ySplit: 1 }],
    }));
    await execFileAsync(process.execPath, [path.join(directory, helper), "create", workbookPath, changesPath]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);
    const sheet = workbook.getWorksheet("数据");
    assert.equal(sheet?.getCell("A1").value, "名称");
    assert.equal(sheet?.getCell("A1").font.bold, true);
    assert.equal(sheet?.getColumn(1).width, 18);
    assert.equal(sheet?.views[0]?.state, "frozen");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automation XLSX inspection returns schema and the last dedupe marker without row dumps", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("行业复盘");
  sheet.addRow(["交易日", "序号", "行业"]);
  sheet.addRow(["2026-08-21", 1, "通信"]);
  sheet.addRow(["2026-08-22", 2, "煤炭"]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  const inspection = await inspectAutomationXlsx(bytes);
  assert.deepEqual(inspection.sheets, [{
    name: "行业复盘",
    headerRow: 1,
    headers: ["交易日", "序号", "行业"],
    columnCount: 3,
    rowCount: 3,
    dedupeColumn: 1,
    lastDedupeValue: "2026-08-22",
  }]);
  assert.equal(JSON.stringify(inspection).includes("通信"), false, "inspection must not dump row contents");

  const titled = new ExcelJS.Workbook();
  const titledSheet = titled.addWorksheet("带标题");
  titledSheet.addRow(["2026 年行业复盘"]);
  titledSheet.addRow(["交易日", "行业"]);
  titledSheet.addRow(["2026-08-22", "煤炭"]);
  const titledInspection = await inspectAutomationXlsx(Buffer.from(await titled.xlsx.writeBuffer()));
  assert.equal(titledInspection.sheets[0]?.headerRow, 2);
  assert.deepEqual(titledInspection.sheets[0]?.headers, ["交易日", "行业"]);
  assert.equal(titledInspection.sheets[0]?.lastDedupeValue, "2026-08-22");

  await assert.rejects(
    () => appendRowsToXlsxBytes({ bytes, sheet: "行业复盘", rows: [["2026-08-23", "行业列多余", "煤炭", "越界"]] }),
    /expected exactly 3 columns/,
  );
});

test("spreadsheet transform expands a merged title row when distinct header cells are assigned", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("行业复盘");
  sheet.addRow(["行业复盘标题"]);
  sheet.mergeCells("A1:C1");
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  const transformed = await transformXlsxBytes(bytes, {
    setCells: [
      { sheet: "行业复盘", row: 1, column: 1, value: "序号" },
      { sheet: "行业复盘", row: 1, column: 2, value: "复盘日期" },
      { sheet: "行业复盘", row: 1, column: 3, value: "行业代码" },
    ],
  });
  const inspection = await inspectAutomationXlsx(transformed);
  assert.deepEqual(inspection.sheets[0]?.headers, ["序号", "复盘日期", "行业代码"]);

  const reopened = new ExcelJS.Workbook();
  await (reopened.xlsx.load as unknown as (input: ArrayBuffer) => Promise<unknown>)(
    transformed.buffer.slice(transformed.byteOffset, transformed.byteOffset + transformed.byteLength) as ArrayBuffer,
  );
  assert.equal(reopened.getWorksheet("行业复盘")!.getCell("B1").isMerged, false);
});

/** 2026-09-11 rev21 空 schema 事故：合并标题行（A1:Q1）被 ExcelJS 铺满 17 格，
 * 旧推导把标题行当表头。修复后剔除合并覆盖格，真实表头行胜出。 */
test("merged title row no longer hijacks header detection (rev21 hollow-schema fix)", async () => {
  const { snapshotWorkbookSchema } = await import("../src/services/automation-spreadsheet.js");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("数据");
  ws.getCell(1, 1).value = "2026年09月行业复盘表_序号分段版";
  ws.mergeCells(1, 1, 1, 17);
  const headers = ["序号", "复盘日期", "行业代码", "行业名称", "当日涨跌幅(%)", "主力净流入(亿元)", "5日主力净流入(亿元)", "成交额(亿元)", "涨跌家数", "涨停公司", "已删除：公司涨幅(%)", "资金流入较强公司", "公司主力净流入(亿元)", "趋势判断", "主要原因", "验证条件/风险", "来源与时间"];
  ws.getRow(2).values = headers;
  ws.getRow(3).values = [1, "2026-09-03", "pt01801790", "非银金融", "1.33", "21.25", "-21.87", "511.83", "48涨/25跌/6平", "无涨停 / 不适用", "", "", "", "观察", "行业当日上涨", "关注后续", "腾讯板块"];
  ws.getRow(4).values = ["备注：仅记录当日涨幅前10"];
  ws.mergeCells(4, 1, 4, 17);
  const data = await wb.xlsx.writeBuffer();
  const schema = await snapshotWorkbookSchema(Buffer.from(data));
  assert.equal(schema.headerRow, 2, "merged title row must be skipped");
  assert.deepEqual(schema.header, headers, "real column labels become the contract");
});

test("validateRowsAgainstColumnRules: 9-4 misalignment, 9-7 universe drift, sentinels, numbers", async () => {
  const { validateRowsAgainstColumnRules } = await import("../src/services/automation-spreadsheet.js");
  const SW1 = ["银行", "煤炭", "非银金融"];
  const schema = {
    columnCount: 17,
    headerRow: 2,
    header: ["序号", "复盘日期", "行业代码", "行业名称", "当日涨跌幅(%)", "主力净流入(亿元)", "5日主力净流入(亿元)", "成交额(亿元)", "涨跌家数", "涨停公司", "已删除：公司涨幅(%)", "资金流入较强公司", "公司主力净流入(亿元)", "趋势判断", "主要原因", "验证条件/风险", "来源与时间"],
    columnRules: {
      "2": { kind: "date" as const, required: true },
      "4": { required: true, enumValues: SW1 },
      "5": { kind: "number" as const },
      "6": { kind: "number" as const, allowMissing: ["数据缺失"] },
    },
  };
  const aligned = [1, "2026-09-04", "pt01801780", "银行", "0.87", "-0.43", "数据缺失", "280.75", "35涨/4跌", "无涨停", "", "", "", "温和上涨", "防御性", "无", "来源"];
  assert.equal(validateRowsAgainstColumnRules([aligned], schema), null, "aligned rows pass");
  // 9-4 形态：日期串占第 1 列（序号列），整行左移两格。
  const misaligned = ["2026-09-04", "银行", "0.87", "280.75", "0.27", "-0.43", "无涨停", "不适用", "温和上涨", "行业防御性上涨", "腾讯板块", "", "", "", "", "", ""];
  const mismatch = validateRowsAgainstColumnRules([misaligned], schema)!;
  assert.match(mismatch, /第 4 列|行业名称/, "misalignment is caught at the enum column");
  // 9-7 形态：截断名不在白名单（截断检测由枚举承担）。
  const drift = [8, "2026-09-07", "pt01801130", "农产品加", "+3.74%", "数据缺失", "数据缺失", "数据缺失", "1. 封板", "金健米业", "", "", "", "强势反弹", "粮油", "无", "东财"];
  const driftError = validateRowsAgainstColumnRules([drift], schema)!;
  assert.match(driftError, /不在约定取值集内/, "truncated names are rejected");
  // 2026-09-11 owner 裁决：申万二级行业名合法（当晚行业复盘 5 行被一级白名单
  // 误拦）。二级名及「主体(注释)」/括号内取值/去Ⅱ 形态均应放行。
  const sw2Schema = { ...schema, columnRules: { ...schema.columnRules, "4": { required: true, enumValues: ["银行", "通信设备", "元件", "地面兵装Ⅱ", "玻璃玻纤"] } } };
  const sw2Row = (name: string) => [1, "2026-09-11", "pt01801770", name, "1.41", "48.46", "254.14", "1858.35", "39涨/79跌", "无涨停", "", "", "", "观察", "行业当日上涨", "关注后续", "腾讯板块"];
  assert.equal(validateRowsAgainstColumnRules([sw2Row("通信设备")], sw2Schema), null, "exact SW2 name passes");
  assert.equal(validateRowsAgainstColumnRules([sw2Row("元件(PCB)")], sw2Schema), null, "annotated form matches its base name");
  assert.equal(validateRowsAgainstColumnRules([sw2Row("兵装(地面兵装)")], sw2Schema), null, "annotated form matches the parenthesized value");
  assert.equal(validateRowsAgainstColumnRules([sw2Row("地面兵装")], sw2Schema), null, "roman-numeral suffix on the whitelist entry is ignored");
  assert.match(validateRowsAgainstColumnRules([sw2Row("通信设")], sw2Schema)!, /不在约定取值集内/, "truncated SW2 name is still rejected");
  // 必填缺失与显式缺失标注。
  assert.match(validateRowsAgainstColumnRules([[1, "", "pt", "银行", "1", "2", "", "", "", "", "", "", "", "", "", "", ""]], schema)!, /复盘日期.*为空/);
  assert.equal(validateRowsAgainstColumnRules([aligned], { columnCount: 17, headerRow: 2 }), null, "no rules → no semantic gate (backward compatible)");
});
