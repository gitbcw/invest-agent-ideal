import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";

import { parseWorkbookPreview } from "../src/lib/workbook-preview";
import { isXlsxFile, XLSX_MIME_TYPE } from "../src/lib/xlsx";

test("XLSX detection supports canonical MIME and file extension", () => {
  assert.equal(isXlsxFile("report.bin", XLSX_MIME_TYPE), true);
  assert.equal(isXlsxFile("REPORT.XLSX", "application/octet-stream"), true);
  assert.equal(isXlsxFile("report.xls", "application/vnd.ms-excel"), false);
});

test("workbook preview preserves safe workbook layout without executing formulas", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("跟踪表", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.getCell("A1").value = "名称";
  sheet.getCell("A1").font = { bold: true, color: { argb: "FF235C3A" } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F2EA" } };
  sheet.getCell("B1").value = "数值";
  sheet.getCell("A2").value = "煤炭";
  sheet.getCell("B2").value = { formula: "1+2", result: 3 };
  sheet.getColumn(1).width = 24;
  sheet.mergeCells("A3:B3");
  sheet.getCell("A3").value = "合并说明";
  workbook.addWorksheet("说明").getCell("A1").value = "只读预览";

  const bytes = await workbook.xlsx.writeBuffer();
  const preview = await parseWorkbookPreview(new Uint8Array(bytes));
  assert.equal(preview.sheets.length, 2);
  assert.equal(preview.sheets[0].name, "跟踪表");
  assert.equal(preview.sheets[0].rows[1].cells[1].text, "3");
  assert.equal(preview.sheets[0].rows[0].cells[0].style?.bold, true);
  assert.equal(preview.sheets[0].rows[0].cells[0].style?.fillColor, "#E8F2EA");
  assert.equal(preview.sheets[0].columnWidths[0], 24);
  assert.deepEqual(preview.sheets[0].frozen, { xSplit: 0, ySplit: 1 });
  assert.deepEqual(preview.sheets[0].mergedRanges, ["A3:B3"]);
});

test("workbook preview rejects invalid XLSX bytes", async () => {
  await assert.rejects(
    parseWorkbookPreview(new TextEncoder().encode("not an xlsx workbook"))
  );
});
