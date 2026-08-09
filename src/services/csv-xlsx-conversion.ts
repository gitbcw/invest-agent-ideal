import ExcelJS from "exceljs";

export class CsvXlsxConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvXlsxConversionError";
  }
}

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 1_000;

export async function convertCsvBytesToXlsx(bytes: Uint8Array): Promise<Buffer> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CsvXlsxConversionError("CSV 必须为有效 UTF-8 文本");
  }
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Invest Agent";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet("数据", { views: [{ state: "frozen", ySplit: rows.length ? 1 : 0 }] });
  for (const row of rows) sheet.addRow(row);

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length && columnCount) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length, column: columnCount } };
    const header = sheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: "FF243129" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F0E8" } };
    header.alignment = { vertical: "middle", wrapText: true };
    header.eachCell((cell) => {
      cell.border = { bottom: { style: "thin", color: { argb: "FFC8D3CA" } } };
    });

    for (let rowIndex = 2; rowIndex <= rows.length; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      row.alignment = { vertical: "top", wrapText: true };
      if (rowIndex % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAF8" } };
    }
    for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
      let width = 10;
      for (let rowIndex = 0; rowIndex < Math.min(rows.length, 500); rowIndex += 1) {
        width = Math.max(width, displayWidth(rows[rowIndex][columnIndex - 1] || "") + 2);
      }
      sheet.getColumn(columnIndex).width = Math.min(40, width);
    }
  }

  const output = await workbook.xlsx.writeBuffer();
  return Buffer.from(output);
}

export function parseCsv(text: string): string[][] {
  if (!text) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;

  const finishRow = () => {
    row.push(field);
    if (row.length > MAX_COLUMNS) throw new CsvXlsxConversionError(`CSV 列数不能超过 ${MAX_COLUMNS}`);
    rows.push(row);
    if (rows.length > MAX_ROWS) throw new CsvXlsxConversionError(`CSV 行数不能超过 ${MAX_ROWS}`);
    row = [];
    field = "";
    justClosedQuote = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else { quoted = false; justClosedQuote = true; }
      } else field += char;
      continue;
    }
    if (justClosedQuote && char !== "," && char !== "\n" && char !== "\r") {
      if (char === " " || char === "\t") continue;
      throw new CsvXlsxConversionError("CSV 引号字段后存在无效字符");
    }
    if (char === '"' && field.length === 0 && !justClosedQuote) { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; justClosedQuote = false; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
      continue;
    }
    field += char;
  }
  if (quoted) throw new CsvXlsxConversionError("CSV 包含未闭合的引号字段");
  if (field.length || row.length || !/[\r\n]$/.test(text)) finishRow();
  return rows;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char.codePointAt(0)! > 0xff ? 2 : 1;
  return Math.min(width, 80);
}
