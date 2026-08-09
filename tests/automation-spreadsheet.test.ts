import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

import { writeAutomationSpreadsheetHelper } from "../src/services/automation-spreadsheet.js";

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
