import ExcelJS from "exceljs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export type AutomationSpreadsheetExtension = ".csv" | ".xlsx";

/**
 * Small, deterministic workbook facts injected into a generic automation
 * prompt.  Do not include arbitrary rows here: the model only needs the
 * schema and the current dedupe marker to produce an appendRows envelope.
 */
export interface AutomationSpreadsheetSheetSummary {
  name: string;
  headerRow: number;
  headers: unknown[];
  columnCount: number;
  rowCount: number;
  dedupeColumn: number;
  lastDedupeValue?: unknown;
}

export interface AutomationSpreadsheetInspection {
  sheets: AutomationSpreadsheetSheetSummary[];
}

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
  // A title row is commonly merged across the future header columns. When a
  // change explicitly targets a non-master cell in that merged range, keeping
  // the merge would redirect every assignment to the master cell and the last
  // value would overwrite the whole header. Unmerge only ranges whose
  // non-master cells are explicitly addressed; writing the master alone keeps
  // the original merge intact.
  const unmergedRanges = new Set<string>();
  for (const change of Array.isArray(changes.setCells) ? changes.setCells : []) {
    const sheet = getSheet(change.sheet);
    const row = Number(change.row);
    const column = Number(change.column);
    if (!Number.isInteger(row) || row < 1 || !Number.isInteger(column) || column < 1) continue;
    const cell = sheet.getCell(row, column);
    if (!cell.isMerged || cell.address === cell.master.address) continue;
    const mergeRange = sheet.model.merges.find((range) => sheet.getCell(range.split(":", 1)[0]).address === cell.master.address);
    if (mergeRange && !unmergedRanges.has(`${sheet.id}:${mergeRange}`)) {
      sheet.unMergeCells(mergeRange);
      unmergedRanges.add(`${sheet.id}:${mergeRange}`);
    }
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

function promptCellValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if ("result" in value) return promptCellValue((value as { result?: unknown }).result);
  if ("text" in value && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function rowValues(row: ExcelJS.Row): unknown[] {
  return (row.values as unknown[]).slice(1).map(promptCellValue);
}

function hasCellValue(value: unknown): boolean {
  return value !== null && value !== undefined && normalizeCellText(value) !== "";
}

function resolveDedupeColumn(headers: unknown[]): number {
  const index = headers.findIndex((header) => /日期|交易日|date|day/i.test(normalizeCellText(header)));
  if (index >= 0) return index + 1;
  return 1;
}

/** 解码 "A1:Q1" 风格区间为行列范围（ExcelJS sheet.model.merges 的存储形态）。 */
function decodeMergeRange(range: string): { startRow: number; endRow: number; startCol: number; endCol: number } | null {
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range.trim().toUpperCase());
  if (!match) return null;
  const col = (letters: string) => letters.split("").reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0);
  const startRow = Number(match[2]);
  const startCol = col(match[1]);
  return {
    startRow,
    endRow: match[4] ? Number(match[4]) : startRow,
    startCol,
    endCol: match[3] ? col(match[3]) : startCol,
  };
}

/** 该行被合并单元格覆盖的列集合。ExcelJS 对合并行会把主单元格值铺满整个
 * 合并区，一个跨 17 列的标题行读起来像 17 个非空格——不剔除会把标题行
 * 误判成表头（2026-09-11 rev21 空 schema 事故：header 17 项全是文件名）。 */
function mergedColumnsOnRow(sheet: ExcelJS.Worksheet, rowNumber: number): Set<number> {
  const covered = new Set<number>();
  const merges = sheet.model?.merges;
  if (!Array.isArray(merges)) return covered;
  for (const range of merges) {
    const decoded = decodeMergeRange(String(range));
    if (!decoded || rowNumber < decoded.startRow || rowNumber > decoded.endRow) continue;
    if (decoded.startCol === decoded.endCol && decoded.startRow === decoded.endRow) continue;
    for (let column = decoded.startCol; column <= decoded.endCol; column += 1) covered.add(column);
  }
  return covered;
}

function countEffectiveCells(sheet: ExcelJS.Worksheet, rowNumber: number): number {
  const merged = mergedColumnsOnRow(sheet, rowNumber);
  const values = rowValues(sheet.getRow(rowNumber));
  let count = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (merged.has(index + 1)) continue;
    if (hasCellValue(values[index])) count += 1;
  }
  return count;
}

function findLikelyHeaderRow(sheet: ExcelJS.Worksheet): number {
  if (countEffectiveCells(sheet, 1) >= 2) return 1;
  // A title-only first row is common in manually maintained workbooks. Pick
  // the first following row with at least two populated cells as the schema
  // row; keep row 1 as the conservative fallback for one-column sheets.
  const limit = Math.min(sheet.rowCount, 10);
  for (let rowNumber = 2; rowNumber <= limit; rowNumber += 1) {
    if (countEffectiveCells(sheet, rowNumber) >= 2) return rowNumber;
  }
  return 1;
}

function sheetSchema(sheet: ExcelJS.Worksheet): { headerRow: number; headers: unknown[]; columnCount: number; dedupeColumn: number } {
  const headerRow = findLikelyHeaderRow(sheet);
  const headers = rowValues(sheet.getRow(headerRow));
  const lastHeaderColumn = headers.reduce<number>((last, value, index) => hasCellValue(value) ? index + 1 : last, 0);
  const columnCount = Math.max(1, sheet.columnCount, lastHeaderColumn);
  return { headerRow, headers, columnCount, dedupeColumn: resolveDedupeColumn(headers) };
}

/**
 * Inspect only the workbook structure needed by a generic update task.  The
 * first row is treated as the header row and the dedupe marker is taken from
 * the last non-empty data row in the date-like column (or column 1 when no
 * date-like header exists).  This intentionally avoids returning row data.
 */
export async function inspectAutomationXlsx(bytes: Uint8Array): Promise<AutomationSpreadsheetInspection> {
  const workbook = new ExcelJS.Workbook();
  const input = Buffer.from(bytes);
  await (workbook.xlsx.load as unknown as (loaded: ArrayBuffer) => Promise<unknown>)(
    input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer,
  );
  return {
    sheets: workbook.worksheets.map((sheet) => {
      const schema = sheetSchema(sheet);
      let lastDedupeValue: unknown;
      for (let rowNumber = sheet.rowCount; rowNumber > schema.headerRow; rowNumber -= 1) {
        const values = rowValues(sheet.getRow(rowNumber));
        if (values.some(hasCellValue)) {
          const candidate = values[schema.dedupeColumn - 1];
          if (hasCellValue(candidate)) lastDedupeValue = candidate;
          break;
        }
      }
      return {
        name: sheet.name,
        ...schema,
        rowCount: sheet.rowCount,
        ...(lastDedupeValue === undefined ? {} : { lastDedupeValue }),
      };
    }),
  };
}

/** Persisted workbook schema contract bound to an update-mode task revision
 * (T-480). columnCount uses the same derivation as the appendRows guard
 * (max of physical columns and the header row's last non-empty column). */
export interface AutomationWorkbookSchema {
  columnCount: number;
  headerRow: number;
  header?: string[];
  /** 可选列语义规则（2026-09-11）：键为 1 基列号。列数校验只防多/少列，
   * 防不住「17 列但整体错位/口径漂移」（9-4 列错位、9-7 申万二级宇宙）。
   * 规则由任务 revision 显式携带，快照推导不自动生成。 */
  columnRules?: Record<string, AutomationColumnRule>;
}

export interface AutomationColumnRule {
  /** 期望值形态；缺省只做非空/枚举检查。 */
  kind?: "number" | "date" | "text";
  /** 枚举白名单：通用能力，供真正封闭取值域的列选用。口径类取值不绑枚举
   * （2026-09-11 owner 晚间二次裁决：行业复盘「行业名称」的一级/二级粒度
   * 属 agent 判断区，rev24 起该列从枚举降级为 kind=text 格式级规则——
   * 枚举词表会随分类调整腐化，且把业务口径判断硬编码进服务层违反
   * 「服务层只接管格式类不变量」）。匹配除精确相等外还接受注释形态：
   * 尾部括号注释按主体或括号内取值比对（「元件(PCB)」→元件；
   * 「兵装(地面兵装)」→地面兵装），比较忽略尾部版本后缀 Ⅱ/II/2。 */
  enumValues?: string[];
  /** 允许的显式缺失标注（如「数据缺失」）；命中时不按 kind/required 追究。 */
  allowMissing?: string[];
  /** 该列必须非空（allowMissing 优先）。 */
  required?: boolean;
  /** kind=text：归一空白后的字符数上限（防串列/整段粘贴，非内容判断）。 */
  maxLength?: number;
  /** kind=text：要求括号成对闭合（截断特征检测，如「元件(PCB」）。 */
  balancedBrackets?: boolean;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : normalizeCellText(value);
}

function isNumericCell(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return /^[+-]?\d+(?:\.\d+)?%?$/.test(value.trim());
}

function isDateCell(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== "string") return false;
  const text = value.trim();
  return ISO_DATE.test(text) || /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text);
}

/** 枚举比对的形态归一：去空白、去尾部版本后缀（Ⅱ/II/2）。 */
function normalizeEnumName(text: string): string {
  return text.replace(/\s+/g, "").replace(/[ⅡII2]+$/u, "");
}

/** 候选形态：原值 + 尾部括号注释的主体与括号内取值。 */
function enumNameVariants(text: string): string[] {
  const trimmed = text.trim();
  const variants = [trimmed];
  const annotated = /^(.*?)\s*[（(]([^()（）]*)[)）]\s*$/.exec(trimmed);
  if (annotated) variants.push(annotated[1], annotated[2]);
  return variants.map(normalizeEnumName).filter(Boolean);
}

function matchesEnumValue(text: string, enumValues: string[]): boolean {
  const normalized = new Set(enumValues.map((value) => normalizeEnumName(value)));
  return enumNameVariants(text).some((variant) => normalized.has(variant));
}

/** 截断特征：任一括号类型开闭数量不等（中英文圆括号/方括号各算一类）。 */
function hasBalancedBrackets(text: string): boolean {
  const pairs: Array<readonly [string, string]> = [["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"]];
  for (const [open, close] of pairs) {
    let opens = 0;
    let closes = 0;
    for (const ch of text) {
      if (ch === open) opens += 1;
      else if (ch === close) closes += 1;
    }
    if (opens !== closes) return false;
  }
  return true;
}

/** 追加行按 columnRules 逐格校验；null=通过，否则返回可执行的差异描述
 * （会作为 AUTOMATION_RUN_INVALID_RESULT 回喂模型触发自纠重试）。 */
export function validateRowsAgainstColumnRules(rows: unknown[][], schema: AutomationWorkbookSchema): string | null {
  const rules = schema.columnRules;
  if (!rules || Object.keys(rules).length === 0) return null;
  const problems: string[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnKey, rule] of Object.entries(rules)) {
      const columnIndex = Number(columnKey) - 1;
      if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= schema.columnCount) continue;
      const label = schema.header?.[columnIndex] || `第 ${columnKey} 列`;
      const value = row[columnIndex];
      const text = cellText(value);
      if ((rule.allowMissing ?? []).map((marker) => marker.trim()).includes(text)) continue;
      if (!text) {
        if (rule.required) problems.push(`第 ${rowIndex + 1} 行「${label}」为空（必填列）`);
        continue;
      }
      if (rule.enumValues && !matchesEnumValue(text, rule.enumValues)) {
        problems.push(`第 ${rowIndex + 1} 行「${label}」值「${text.slice(0, 24)}」不在约定取值集内（取值可带尾部括号注释，如「元件(PCB)」；疑似口径漂移或截断）`);
        continue;
      }
      if (rule.kind === "number" && !isNumericCell(value)) {
        problems.push(`第 ${rowIndex + 1} 行「${label}」值「${text.slice(0, 24)}」不是数值`);
      } else if (rule.kind === "date" && !isDateCell(value)) {
        problems.push(`第 ${rowIndex + 1} 行「${label}」值「${text.slice(0, 24)}」不是日期（YYYY-MM-DD）`);
      } else if (rule.kind === "text") {
        const collapsed = text.replace(/\s+/g, "");
        if (rule.maxLength !== undefined && collapsed.length > rule.maxLength) {
          problems.push(`第 ${rowIndex + 1} 行「${label}」值超过 ${rule.maxLength} 字上限（疑似串列或整段粘贴）`);
        }
        if (rule.balancedBrackets && !hasBalancedBrackets(text)) {
          problems.push(`第 ${rowIndex + 1} 行「${label}」值「${text.slice(0, 24)}」括号未成对闭合（疑似名称截断）`);
        }
      }
    }
    if (problems.length >= 5) break;
  }
  if (!problems.length) return null;
  return `追加行未通过列语义校验：${problems.join("；")}。请严格按表头列序输出 ${schema.columnCount} 列（表头：${(schema.header ?? []).filter(Boolean).join("、")}），字段取值遵守任务口径约定`;
}

/** Snapshot the first worksheet's schema as a revision-bindable contract.
 * Text labels are normalized the same way the runtime guard compares them. */
export async function snapshotWorkbookSchema(bytes: Uint8Array): Promise<AutomationWorkbookSchema> {
  const inspection = await inspectAutomationXlsx(bytes);
  const sheet = inspection.sheets[0];
  if (!sheet) throw new AutomationSpreadsheetValidationError("workbook has no worksheets");
  const header = sheet.headers.map((value) => normalizeCellText(value));
  // columnCount counts physical/last-header columns which can exceed the
  // header row's populated cells; pad so the persisted contract always has
  // one label per column (empty labels compare as empty).
  while (header.length < sheet.columnCount) header.push("");
  return { columnCount: sheet.columnCount, headerRow: sheet.headerRow, header };
}

/** null when compatible; otherwise a deterministic, human-actionable diff. */
export function describeSchemaMismatch(expected: AutomationWorkbookSchema, actual: AutomationWorkbookSchema): string | null {
  const diffs: string[] = [];
  if (expected.columnCount !== actual.columnCount) {
    diffs.push(`列数不符：任务契约 ${expected.columnCount} 列，工作簿实际 ${actual.columnCount} 列`);
  }
  if (expected.headerRow !== actual.headerRow) {
    diffs.push(`表头行不符：任务契约第 ${expected.headerRow} 行，工作簿实际第 ${actual.headerRow} 行`);
  }
  if (expected.header) {
    const actualHeader = actual.header ?? [];
    const limit = Math.max(expected.header.length, actualHeader.length);
    const moved: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      const want = expected.header[i] ?? "";
      const got = actualHeader[i] ?? "";
      if (want !== got) moved.push(`第 ${i + 1} 列期望「${want}」实际「${got}」`);
    }
    if (moved.length) diffs.push(`表头标签不符：${moved.slice(0, 3).join("；")}${moved.length > 3 ? `（共 ${moved.length} 处）` : ""}`);
  }
  if (!diffs.length) return null;
  return `AUTOMATION_SCHEMA_MISMATCH: ${diffs.join("；")}。若这是已知合法的表结构变更，请在 Portal 编辑该任务并重新保存以更新契约快照；否则请检查绑定的工作簿资产版本。`;
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
  const schema = sheetSchema(sheet);
  for (const [index, row] of input.rows.entries()) {
    if (row.length !== schema.columnCount) {
      throw new Error(`appendRows row #${index + 1} has ${row.length} columns; expected exactly ${schema.columnCount} columns matching header row ${schema.headerRow}`);
    }
  }
  if (input.skipIfCellMatches) {
    const target = input.skipIfCellMatches.value.trim();
    const values = sheet.getColumn(input.skipIfCellMatches.column).values as unknown[];
    if (input.skipIfCellMatches.column > schema.columnCount) {
      throw new Error(`skipIfCellMatches column ${input.skipIfCellMatches.column} exceeds sheet columnCount ${schema.columnCount}`);
    }
    for (let rowIndex = schema.headerRow + 1; rowIndex < values.length; rowIndex++) {
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
