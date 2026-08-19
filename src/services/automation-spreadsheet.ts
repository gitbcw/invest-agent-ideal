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
 * Structured sheet changes accepted by both the staged ACP helper script and
 * the in-process spreadsheet.transform service tool. Data only — never code.
 */
export interface AutomationSheetChanges {
  createSheets?: Array<{ name?: string }>;
  renameSheets?: Array<{ sheet?: string; name?: string }>;
  setCells?: Array<{
    sheet?: string; row?: number; column?: number; value?: unknown; formula?: string; result?: unknown;
    numberFormat?: string; font?: { bold?: boolean; italic?: boolean; color?: string };
    fillColor?: string; alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  }>;
  appendRows?: Array<{ sheet?: string; values?: unknown[] }>;
  setColumnWidths?: Array<{ sheet?: string; column?: number; width?: number }>;
  setRowHeights?: Array<{ sheet?: string; row?: number; height?: number }>;
  mergeCells?: Array<{ sheet?: string; range?: string }>;
  freezePanes?: Array<{ sheet?: string; xSplit?: number; ySplit?: number }>;
  autoFilters?: Array<{ sheet?: string; range?: string }>;
}

function argbColor(value: unknown): { argb: string } {
  const text = String(value || "").replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(text)) throw new Error("invalid color");
  return { argb: "FF" + text };
}

/** Compact expected-shape cheat sheet embedded in validation errors so the
 * calling agent can self-correct in one retry instead of guessing (the
 * 2026-08-19 mg industry-review loss came from blind parameter guessing). */
export const SHEET_OPERATION_SHAPES: Record<string, string> = {
  createSheets: '{name:"新工作表名"}',
  renameSheets: '{sheet:"旧工作表名", name:"新工作表名"}',
  setCells: '{sheet:"工作表名", row:2, column:3, value:"单元格值"}（row/column 是从 1 开始的整数）',
  appendRows: '{sheet:"工作表名", values:[["a",1],["b",2]]}（values 必须是二维数组：外层=行，内层=单元格）',
  setColumnWidths: '{sheet:"工作表名", column:1, width:20}',
  setRowHeights: '{sheet:"工作表名", row:1, height:20}',
  mergeCells: '{sheet:"工作表名", range:"A1:B2"}',
  freezePanes: '{sheet:"工作表名", xSplit:0, ySplit:1}',
  autoFilters: '{sheet:"工作表名", range:"A1:N99"}',
};

function expectedShapeHint(operation: string, index?: number): string {
  const shape = SHEET_OPERATION_SHAPES[operation] || "{}";
  return index === undefined ? `expected ${shape}` : `expected item #${index + 1}: ${shape}`;
}

/** Apply the shared change set to a loaded workbook in place. */
export function applyAutomationSheetChanges(workbook: ExcelJS.Workbook, changes: AutomationSheetChanges): void {
  const getSheet = (name: unknown) => {
    const key = String(name || "");
    // 未指定表名且工作簿只有一个工作表时自动定位；报错时列出可用表名，
    // 让调用方（执行代理）能一次重试自纠。
    const sheet = key
      ? workbook.getWorksheet(key)
      : workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined;
    if (!sheet) {
      throw new Error(`worksheet not found: ${key || "(unspecified)"}; available sheets: ${workbook.worksheets.map((item) => item.name).join(", ")}`);
    }
    return sheet;
  };
  for (const [index, change] of (Array.isArray(changes.createSheets) ? changes.createSheets : []).entries()) {
    const name = String(change.name || "").trim();
    if (!name || name.length > 31 || workbook.getWorksheet(name)) throw new Error(`invalid createSheets item: ${expectedShapeHint("createSheets", index)}`);
    workbook.addWorksheet(name);
  }
  for (const [index, change] of (Array.isArray(changes.renameSheets) ? changes.renameSheets : []).entries()) {
    const sheet = getSheet(change.sheet);
    const name = String(change.name || "").trim();
    if (!name || name.length > 31 || workbook.getWorksheet(name)) throw new Error(`invalid renameSheets item: ${expectedShapeHint("renameSheets", index)}`);
    sheet.name = name;
  }
  for (const [index, change] of (Array.isArray(changes.setCells) ? changes.setCells : []).entries()) {
    const sheet = getSheet(change.sheet);
    const row = Number(change.row);
    const column = Number(change.column);
    if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) {
      throw new Error(`invalid setCells item: ${expectedShapeHint("setCells", index)}`);
    }
    const cell = sheet.getCell(row, column);
    cell.value = (typeof change.formula === "string"
      ? { formula: change.formula, result: change.result ?? undefined }
      : change.value ?? null) as ExcelJS.CellValue;
    if (change.numberFormat !== undefined) cell.numFmt = String(change.numberFormat);
    if (change.font && typeof change.font === "object") cell.font = {
      bold: change.font.bold === true,
      italic: change.font.italic === true,
      color: change.font.color ? argbColor(change.font.color) : undefined,
    };
    if (change.fillColor) cell.fill = { type: "pattern", pattern: "solid", fgColor: argbColor(change.fillColor) };
    if (change.alignment && typeof change.alignment === "object") cell.alignment = {
      horizontal: (["left", "center", "right"] as const).includes(change.alignment.horizontal as "left" | "center" | "right") ? change.alignment.horizontal as "left" | "center" | "right" : undefined,
      vertical: (["top", "middle", "bottom"] as const).includes(change.alignment.vertical as "top" | "middle" | "bottom") ? change.alignment.vertical as "top" | "middle" | "bottom" : undefined,
      wrapText: change.alignment.wrapText === true,
    };
  }
  for (const [index, change] of (Array.isArray(changes.appendRows) ? changes.appendRows : []).entries()) {
    const sheet = getSheet(change.sheet);
    if (!Array.isArray(change.values)) throw new Error(`invalid appendRows item: ${expectedShapeHint("appendRows", index)}`);
    // 兼容两种自然形态：values 为一行的单元格数组，或为多行的二维数组
    // （模型经常把多行整体放进一个 appendRows 项）。对象单元格字符串化，
    // 避免整行被压进一个单元格。
    const rows = change.values.length > 0 && change.values.every((cell) => Array.isArray(cell))
      ? (change.values as unknown[][])
      : [change.values];
    for (const row of rows) {
      sheet.addRow(row.map((cell) => (cell === null || cell === undefined ? "" : typeof cell === "object" ? JSON.stringify(cell) : cell)) as ExcelJS.CellValue[]);
    }
  }
  for (const [index, change] of (Array.isArray(changes.setColumnWidths) ? changes.setColumnWidths : []).entries()) {
    const sheet = getSheet(change.sheet);
    const column = Number(change.column);
    const width = Number(change.width);
    if (!Number.isInteger(column) || column < 1 || !Number.isFinite(width) || width < 1 || width > 100) throw new Error(`invalid setColumnWidths item: ${expectedShapeHint("setColumnWidths", index)}`);
    sheet.getColumn(column).width = width;
  }
  for (const [index, change] of (Array.isArray(changes.setRowHeights) ? changes.setRowHeights : []).entries()) {
    const sheet = getSheet(change.sheet);
    const row = Number(change.row);
    const height = Number(change.height);
    if (!Number.isInteger(row) || row < 1 || !Number.isFinite(height) || height < 1 || height > 300) throw new Error(`invalid setRowHeights item: ${expectedShapeHint("setRowHeights", index)}`);
    sheet.getRow(row).height = height;
  }
  for (const [index, change] of (Array.isArray(changes.mergeCells) ? changes.mergeCells : []).entries()) {
    const sheet = getSheet(change.sheet);
    const range = String(change.range || "").toUpperCase();
    if (!/^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$/.test(range)) throw new Error(`invalid mergeCells item: ${expectedShapeHint("mergeCells", index)}`);
    sheet.mergeCells(range);
  }
  for (const [index, change] of (Array.isArray(changes.freezePanes) ? changes.freezePanes : []).entries()) {
    const sheet = getSheet(change.sheet);
    const xSplit = Number(change.xSplit || 0);
    const ySplit = Number(change.ySplit || 0);
    if (!Number.isInteger(xSplit) || xSplit < 0 || !Number.isInteger(ySplit) || ySplit < 0) throw new Error(`invalid freezePanes item: ${expectedShapeHint("freezePanes", index)}`);
    sheet.views = xSplit || ySplit ? [{ state: "frozen", xSplit, ySplit }] : [];
  }
  for (const [index, change] of (Array.isArray(changes.autoFilters) ? changes.autoFilters : []).entries()) {
    const sheet = getSheet(change.sheet);
    const range = String(change.range || "").toUpperCase();
    if (!/^[A-Z]{1,3}[1-9][0-9]*:[A-Z]{1,3}[1-9][0-9]*$/.test(range)) throw new Error(`invalid autoFilters item: ${expectedShapeHint("autoFilters", index)}`);
    sheet.autoFilter = range;
  }
  if (workbook.worksheets.length === 0) throw new Error("workbook requires at least one worksheet");
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

/** Load XLSX bytes, apply the shared change set deterministically, and return
 * validated output bytes. Both the spreadsheet.transform service tool and the
 * generic runner's declarative appendRows commit ride this one path. */
export async function transformXlsxBytes(bytes: Uint8Array, changes: AutomationSheetChanges): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const input = Buffer.from(bytes);
  await (workbook.xlsx.load as unknown as (input: ArrayBuffer) => Promise<unknown>)(
    input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer,
  );
  applyAutomationSheetChanges(workbook, changes);
  const output = Buffer.from(await workbook.xlsx.writeBuffer());
  await validateAutomationSpreadsheet({ extension: ".xlsx", bytes: output });
  return output;
}

export type AppendRowsOutcome =
  | { kind: "appended"; bytes: Buffer; sheetName: string; appendedRows: number }
  | { kind: "skipped"; sheetName: string; matchedRow: number };

function normalizeCellText(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object" && "result" in value) return normalizeCellText((value as { result?: unknown }).result);
  return String(value ?? "").trim();
}

/**
 * Deterministic row-append for update-mode automation output: the agent only
 * supplies the row data, the service owns the workbook mechanics. When
 * skipIfCellMatches finds an existing cell equal to the marker value, the
 * append is skipped so a retried run cannot duplicate the day's row.
 */
export async function appendRowsToXlsxBytes(input: {
  bytes: Uint8Array;
  sheet?: string;
  rows: unknown[][];
  skipIfCellMatches?: { column: number; value: string };
}): Promise<AppendRowsOutcome> {
  if (!Array.isArray(input.rows) || input.rows.length === 0 || !input.rows.every((row) => Array.isArray(row))) {
    throw new Error(`appendRows rows must be a non-empty 2D array (one inner array per row); expected ${SHEET_OPERATION_SHAPES.appendRows}`);
  }
  if (input.skipIfCellMatches && (!Number.isInteger(input.skipIfCellMatches.column) || input.skipIfCellMatches.column < 1 || typeof input.skipIfCellMatches.value !== "string")) {
    throw new Error("skipIfCellMatches must be {column: integer>=1, value: string}");
  }
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(input.bytes);
  await (workbook.xlsx.load as unknown as (loaded: ArrayBuffer) => Promise<unknown>)(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const key = String(input.sheet || "");
  const sheet = key
    ? workbook.getWorksheet(key)
    : workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined;
  if (!sheet) {
    throw new Error(`worksheet not found: ${key || "(unspecified)"}; available sheets: ${workbook.worksheets.map((item) => item.name).join(", ")}`);
  }
  if (input.skipIfCellMatches) {
    const target = input.skipIfCellMatches.value.trim();
    const values = sheet.getColumn(input.skipIfCellMatches.column).values as unknown[];
    for (let rowIndex = 1; rowIndex < values.length; rowIndex++) {
      if (values[rowIndex] !== null && values[rowIndex] !== undefined && normalizeCellText(values[rowIndex]) === target) {
        return { kind: "skipped", sheetName: sheet.name, matchedRow: rowIndex };
      }
    }
  }
  const output = await transformXlsxBytes(input.bytes, { appendRows: [{ sheet: sheet.name, values: input.rows }] });
  return { kind: "appended", bytes: output, sheetName: sheet.name, appendedRows: input.rows.length };
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
