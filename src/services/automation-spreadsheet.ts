import ExcelJS from "exceljs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export type AutomationSpreadsheetExtension = ".csv" | ".xlsx";

export class AutomationSpreadsheetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomationSpreadsheetValidationError";
  }
}

/**
 * Validates the two explicitly supported automation asset formats before the
 * service persists them. This deliberately happens at the service boundary
 * (including ACP output commits), rather than relying on the model prompt.
 */
export async function validateAutomationSpreadsheet(input: {
  extension: AutomationSpreadsheetExtension;
  bytes: Uint8Array;
}): Promise<void> {
  if (input.extension === ".csv") {
    validateCsv(input.bytes);
    return;
  }
  await validateXlsx(input.bytes);
}

/**
 * The ACP works in a disposable staging directory, so give it a small,
 * explicit XLSX utility instead of inviting it to treat an OOXML archive as a
 * text file. The helper uses this deployed application's validated ExcelJS
 * dependency; it never receives a canonical Workspace path.
 */
export async function writeAutomationSpreadsheetHelper(stagingPath: string): Promise<string> {
  const helperPath = path.join(stagingPath, "automation-sheet.mjs");
  // Runtime and PM2 both start the service from the deployed application
  // root. Keeping this as a package root, rather than a Workspace path,
  // prevents the helper from loading arbitrary user-controlled modules.
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const source = `import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(${JSON.stringify(packageJsonPath)});
const ExcelJS = require("exceljs");
const [command, workbookPath, payloadPath] = process.argv.slice(2);
if (!command || !workbookPath || !["create", "inspect", "apply"].includes(command)) {
  throw new Error("usage: node automation-sheet.mjs create <workbook.xlsx> <changes.json> | inspect <workbook.xlsx> | apply <workbook.xlsx> <changes.json>");
}
const workbook = new ExcelJS.Workbook();
if (command !== "create") await workbook.xlsx.readFile(workbookPath);
if (command === "inspect") {
  const sheets = workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    columnWidths: Array.from({ length: sheet.columnCount }, (_, index) => sheet.getColumn(index + 1).width ?? null),
    mergedRanges: sheet.model.merges || [],
    views: sheet.views || [],
    rows: sheet.getSheetValues().slice(1, 31).map((row) => Array.isArray(row) ? row.slice(1) : row),
  }));
  process.stdout.write(JSON.stringify({ sheets }));
  process.exit(0);
}
if (!payloadPath) throw new Error(command + " requires <changes.json>");
const changes = JSON.parse(await readFile(payloadPath, "utf8"));
const getSheet = (name) => {
  const sheet = workbook.getWorksheet(String(name || ""));
  if (!sheet) throw new Error("worksheet not found");
  return sheet;
};
const color = (value) => {
  const text = String(value || "").replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(text)) throw new Error("invalid color");
  return { argb: "FF" + text };
};
for (const change of Array.isArray(changes.createSheets) ? changes.createSheets : []) {
  const name = String(change.name || "").trim();
  if (!name || name.length > 31 || workbook.getWorksheet(name)) throw new Error("invalid createSheets item");
  workbook.addWorksheet(name);
}
for (const change of Array.isArray(changes.renameSheets) ? changes.renameSheets : []) {
  const sheet = getSheet(change.sheet);
  const name = String(change.name || "").trim();
  if (!name || name.length > 31 || workbook.getWorksheet(name)) throw new Error("invalid renameSheets item");
  sheet.name = name;
}
for (const change of Array.isArray(changes.setCells) ? changes.setCells : []) {
  const sheet = getSheet(change.sheet);
  const row = Number(change.row);
  const column = Number(change.column);
  if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) {
    throw new Error("invalid setCells item");
  }
  const cell = sheet.getCell(row, column);
  cell.value = typeof change.formula === "string" ? { formula: change.formula, result: change.result ?? undefined } : change.value ?? null;
  if (change.numberFormat !== undefined) cell.numFmt = String(change.numberFormat);
  if (change.font && typeof change.font === "object") cell.font = {
    bold: change.font.bold === true,
    italic: change.font.italic === true,
    color: change.font.color ? color(change.font.color) : undefined,
  };
  if (change.fillColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: color(change.fillColor) };
  if (change.alignment && typeof change.alignment === "object") cell.alignment = {
    horizontal: ["left", "center", "right"].includes(change.alignment.horizontal) ? change.alignment.horizontal : undefined,
    vertical: ["top", "middle", "bottom"].includes(change.alignment.vertical) ? change.alignment.vertical : undefined,
    wrapText: change.alignment.wrapText === true,
  };
}
for (const change of Array.isArray(changes.appendRows) ? changes.appendRows : []) {
  const sheet = getSheet(change.sheet);
  if (!Array.isArray(change.values)) throw new Error("invalid appendRows item");
  sheet.addRow(change.values);
}
for (const change of Array.isArray(changes.setColumnWidths) ? changes.setColumnWidths : []) {
  const sheet = getSheet(change.sheet);
  const column = Number(change.column);
  const width = Number(change.width);
  if (!Number.isInteger(column) || column < 1 || !Number.isFinite(width) || width < 1 || width > 100) throw new Error("invalid setColumnWidths item");
  sheet.getColumn(column).width = width;
}
for (const change of Array.isArray(changes.setRowHeights) ? changes.setRowHeights : []) {
  const sheet = getSheet(change.sheet);
  const row = Number(change.row);
  const height = Number(change.height);
  if (!Number.isInteger(row) || row < 1 || !Number.isFinite(height) || height < 1 || height > 300) throw new Error("invalid setRowHeights item");
  sheet.getRow(row).height = height;
}
for (const change of Array.isArray(changes.mergeCells) ? changes.mergeCells : []) {
  const sheet = getSheet(change.sheet);
  const range = String(change.range || "").toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$/.test(range)) throw new Error("invalid mergeCells item");
  sheet.mergeCells(range);
}
for (const change of Array.isArray(changes.freezePanes) ? changes.freezePanes : []) {
  const sheet = getSheet(change.sheet);
  const xSplit = Number(change.xSplit || 0);
  const ySplit = Number(change.ySplit || 0);
  if (!Number.isInteger(xSplit) || xSplit < 0 || !Number.isInteger(ySplit) || ySplit < 0) throw new Error("invalid freezePanes item");
  sheet.views = xSplit || ySplit ? [{ state: "frozen", xSplit, ySplit }] : [];
}
for (const change of Array.isArray(changes.autoFilters) ? changes.autoFilters : []) {
  const sheet = getSheet(change.sheet);
  const range = String(change.range || "").toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$/.test(range)) throw new Error("invalid autoFilters item");
  sheet.autoFilter = range;
}
if (workbook.worksheets.length === 0) throw new Error("workbook requires at least one worksheet");
await workbook.xlsx.writeFile(workbookPath);
`;
  await writeFile(helperPath, source, { flag: "wx", mode: 0o600 });
  return path.basename(helperPath);
}

function validateCsv(bytes: Uint8Array) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AutomationSpreadsheetValidationError("CSV 必须为有效 UTF-8 文本");
  }
  if (text.includes("\u0000")) {
    throw new AutomationSpreadsheetValidationError("CSV 不得包含 NUL 字节");
  }

  // A small RFC-4180 structural check. The ACP can decide the business
  // change, but it cannot silently persist an unterminated quoted table.
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '"') continue;
    if (quoted && text[index + 1] === '"') {
      index += 1;
      continue;
    }
    quoted = !quoted;
  }
  if (quoted) {
    throw new AutomationSpreadsheetValidationError("CSV 包含未闭合的引号字段");
  }
}

async function validateXlsx(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new AutomationSpreadsheetValidationError("XLSX 必须是有效的 Office Open XML 工作簿");
  }
  try {
    const workbook = new ExcelJS.Workbook();
    const workbookBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    // exceljs@4 exposes an old global Buffer declaration that conflicts with
    // Node 25's generic Buffer type. Its runtime accepts an ArrayBuffer.
    await (workbook.xlsx.load as unknown as (input: ArrayBuffer) => Promise<unknown>)(workbookBytes);
    if (workbook.worksheets.length === 0) {
      throw new AutomationSpreadsheetValidationError("XLSX 至少需要一个工作表");
    }
  } catch (error) {
    if (error instanceof AutomationSpreadsheetValidationError) throw error;
    throw new AutomationSpreadsheetValidationError("XLSX 无法按结构化工作簿读取");
  }
}
