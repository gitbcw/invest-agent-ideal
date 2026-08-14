"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, Loader2, X } from "lucide-react";
import type { WorkbookCellPreview, WorkbookPreviewData } from "@/lib/workbook-preview";

export function WorkbookPreview({ title, workbook, downloading, onDownload, onClose }: { title: string; workbook: WorkbookPreviewData; downloading: boolean; onDownload: () => void; onClose: () => void }) {
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[#e3e7e3] px-4 py-2 sm:px-5"><FileSpreadsheet size={19} className="shrink-0 text-[#52705f]" /><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold text-[#303632]">{title}</h2><p className="text-[11px] text-[#7a827c]">Excel 工作簿 · {workbook.sheets.length} 个工作表</p></div><button type="button" className="rounded-md p-2 text-[#667169] hover:bg-[#f0f4f0] disabled:opacity-50" onClick={onDownload} disabled={downloading} aria-label="下载 Excel 文件" title="下载文件">{downloading ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}</button><button type="button" className="rounded-md p-2 text-[#667169] hover:bg-[#f0f4f0]" onClick={onClose} aria-label="关闭 Excel 预览"><X size={18} /></button></header>
    <WorkbookPreviewBody workbook={workbook} />
  </div>;
}

export function WorkbookPreviewBody({ workbook }: { workbook: WorkbookPreviewData }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  useEffect(() => setSheetIndex(0), [workbook]);
  const sheet = workbook.sheets[Math.min(sheetIndex, Math.max(0, workbook.sheets.length - 1))];
  const merges = useMemo(() => mergeLayout(sheet?.mergedRanges || []), [sheet?.mergedRanges]);
  return <div className="flex h-full min-h-0 flex-col">
    {sheet ? <><div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#e6e9e6] bg-[#f8faf8] px-3 pt-2" role="tablist" aria-label="工作表">{workbook.sheets.map((item, index) => <button key={`${item.name}-${index}`} type="button" role="tab" aria-selected={index === sheetIndex} className={`max-w-48 shrink-0 truncate border-b-2 px-3 py-2 text-xs ${index === sheetIndex ? "border-[#52705f] bg-white font-medium text-[#36513e]" : "border-transparent text-[#727c75] hover:bg-white/70"}`} onClick={() => setSheetIndex(index)}>{item.name}</button>)}</div><div className="min-h-0 flex-1 overflow-auto bg-white"><table className="border-collapse text-left text-xs" style={{ tableLayout: "fixed", minWidth: `${Math.max(1, sheet.columnWidths.reduce((sum, width) => sum + width * 7, 0))}px` }}><colgroup>{sheet.columnWidths.map((width, index) => <col key={index} style={{ width: `${width * 7}px` }} />)}</colgroup><tbody>{sheet.rows.map((row) => <tr key={row.index} style={row.height ? { height: `${row.height}px` } : undefined}>{row.cells.map((cell) => { const key = `${row.index}:${cell.column}`; const merge = merges.get(key); if (merge?.hidden) return null; return <td key={cell.column} rowSpan={merge?.rowSpan} colSpan={merge?.colSpan} className={`border border-[#e5e8e5] px-2 py-1.5 align-top ${row.index <= (sheet.frozen?.ySplit || 0) ? "sticky top-0 z-10" : ""}`} style={cellStyle(cell)} title={cell.text}>{cell.text || "\u00a0"}</td>; })}</tr>)}</tbody></table></div>{workbook.truncated || sheet.truncated ? <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">工作簿较大，当前只显示部分内容；下载文件可查看完整数据。</div> : null}</> : <div className="flex flex-1 items-center justify-center text-sm text-[#727c75]">工作簿中没有可显示的工作表</div>}
  </div>;
}

function cellStyle(cell: WorkbookCellPreview): React.CSSProperties {
  return { fontWeight: cell.style?.bold ? 600 : undefined, fontStyle: cell.style?.italic ? "italic" : undefined, color: cell.style?.color, backgroundColor: cell.style?.fillColor, textAlign: cell.style?.horizontal, verticalAlign: cell.style?.vertical, whiteSpace: cell.style?.wrapText ? "pre-wrap" : "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
}

function mergeLayout(ranges: string[]) {
  const result = new Map<string, { rowSpan?: number; colSpan?: number; hidden?: boolean }>();
  for (const range of ranges) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range);
    if (!match) continue;
    const startColumn = columnNumber(match[1]); const startRow = Number(match[2]);
    const endColumn = columnNumber(match[3]); const endRow = Number(match[4]);
    result.set(`${startRow}:${startColumn}`, { rowSpan: endRow - startRow + 1, colSpan: endColumn - startColumn + 1 });
    for (let row = startRow; row <= endRow; row += 1) for (let column = startColumn; column <= endColumn; column += 1) if (row !== startRow || column !== startColumn) result.set(`${row}:${column}`, { hidden: true });
  }
  return result;
}

function columnNumber(label: string) { let value = 0; for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64; return value; }
