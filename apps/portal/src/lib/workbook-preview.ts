import ExcelJS from "exceljs";

export type WorkbookCellPreview = {
  column: number;
  text: string;
  style?: {
    bold?: boolean;
    italic?: boolean;
    color?: string;
    fillColor?: string;
    horizontal?: "left" | "center" | "right";
    vertical?: "top" | "middle" | "bottom";
    wrapText?: boolean;
  };
};
export type WorkbookRowPreview = { index: number; height?: number; cells: WorkbookCellPreview[] };
export type WorkbookSheetPreview = {
  name: string;
  rowCount: number;
  columnCount: number;
  rows: WorkbookRowPreview[];
  columnWidths: number[];
  mergedRanges: string[];
  frozen?: { xSplit: number; ySplit: number };
  truncated: boolean;
};
export type WorkbookPreviewData = { sheets: WorkbookSheetPreview[]; truncated: boolean };

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SHEETS = 20;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 200;
const MAX_CELLS = 200_000;

export async function parseWorkbookPreview(bytes: Uint8Array): Promise<WorkbookPreviewData> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("Excel 文件超过预览大小限制");
  const workbook = new ExcelJS.Workbook();
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await (workbook.xlsx.load as unknown as (value: ArrayBuffer) => Promise<unknown>)(input);
  let remainingCells = MAX_CELLS;
  let truncated = workbook.worksheets.length > MAX_SHEETS;
  const sheets: WorkbookSheetPreview[] = [];
  for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const rowCount = Math.min(sheet.rowCount, MAX_ROWS);
    const columnCount = Math.min(sheet.columnCount, MAX_COLUMNS, remainingCells > 0 ? remainingCells : 0);
    const rows: WorkbookRowPreview[] = [];
    const allowedRows = columnCount ? Math.min(rowCount, Math.floor(remainingCells / columnCount)) : rowCount;
    for (let rowIndex = 1; rowIndex <= allowedRows; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      const cells: WorkbookCellPreview[] = [];
      for (let columnIndex = 1; columnIndex <= columnCount; columnIndex += 1) {
        const cell = row.getCell(columnIndex);
        cells.push({ column: columnIndex, text: displayText(cell), style: safeStyle(cell) });
      }
      rows.push({ index: rowIndex, height: bounded(row.height, 8, 200), cells });
    }
    remainingCells -= allowedRows * columnCount;
    const view = (sheet.views || []).find((item) => item.state === "frozen") as (ExcelJS.WorksheetView & { xSplit?: number; ySplit?: number }) | undefined;
    const sheetTruncated = sheet.rowCount > allowedRows || sheet.columnCount > columnCount;
    truncated ||= sheetTruncated;
    sheets.push({
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      rows,
      columnWidths: Array.from({ length: columnCount }, (_, index) => bounded(sheet.getColumn(index + 1).width, 6, 60) || 12),
      mergedRanges: ((sheet.model as { merges?: string[] }).merges || []).filter((range) => mergeFits(range, allowedRows, columnCount)).slice(0, 1_000),
      frozen: view ? { xSplit: Number(view.xSplit || 0), ySplit: Number(view.ySplit || 0) } : undefined,
      truncated: sheetTruncated,
    });
    if (remainingCells <= 0) break;
  }
  return { sheets, truncated };
}

function displayText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value && typeof value === "object" && "formula" in value) {
    const formula = value as ExcelJS.CellFormulaValue;
    if (formula.result === undefined || formula.result === null) return `=${formula.formula}`;
  }
  return cell.text || "";
}

function safeStyle(cell: ExcelJS.Cell): WorkbookCellPreview["style"] | undefined {
  const style: NonNullable<WorkbookCellPreview["style"]> = {};
  if (cell.font?.bold) style.bold = true;
  if (cell.font?.italic) style.italic = true;
  const color = safeColor(cell.font?.color);
  if (color) style.color = color;
  const fill = cell.fill?.type === "pattern" ? safeColor(cell.fill.fgColor) : undefined;
  if (fill) style.fillColor = fill;
  if (["left", "center", "right"].includes(String(cell.alignment?.horizontal))) style.horizontal = cell.alignment.horizontal as "left" | "center" | "right";
  if (["top", "middle", "bottom"].includes(String(cell.alignment?.vertical))) style.vertical = cell.alignment.vertical as "top" | "middle" | "bottom";
  if (cell.alignment?.wrapText) style.wrapText = true;
  return Object.keys(style).length ? style : undefined;
}

function safeColor(value: Partial<ExcelJS.Color> | undefined): string | undefined {
  const argb = "argb" in (value || {}) ? String((value as { argb?: string }).argb || "") : "";
  if (!/^[0-9A-Fa-f]{8}$/.test(argb)) return undefined;
  return `#${argb.slice(2)}`;
}

function bounded(value: number | undefined, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

function mergeFits(range: string, rowCount: number, columnCount: number): boolean {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
  if (!match) return false;
  return Number(match[2]) <= rowCount && Number(match[4]) <= rowCount
    && columnNumber(match[1]) <= columnCount && columnNumber(match[3]) <= columnCount;
}

function columnNumber(label: string): number {
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}
