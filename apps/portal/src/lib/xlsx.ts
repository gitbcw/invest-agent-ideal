export const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function isXlsxFile(fileName: string, mimeType: string): boolean {
  return mimeType.trim().toLowerCase() === XLSX_MIME_TYPE
    || fileName.trim().toLowerCase().endsWith(".xlsx");
}
