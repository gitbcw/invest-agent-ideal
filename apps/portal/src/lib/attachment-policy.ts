export const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];

export const DOCUMENT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain"
];

const CSV_MIME_ALIASES = new Set(["text/csv", "application/vnd.ms-excel"]);

export function canonicalAttachmentMime(fileName: string, mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (CSV_MIME_ALIASES.has(normalized) || fileName.toLowerCase().endsWith(".csv")) return "text/csv";
  return normalized || "application/octet-stream";
}

export function isCsvFile(fileName: string, mimeType: string): boolean {
  return canonicalAttachmentMime(fileName, mimeType) === "text/csv";
}
