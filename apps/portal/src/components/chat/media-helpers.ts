import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Shared browser-side media helpers used by the artifact viewer, image
 * lightbox and attachment cards. Extracted so the file-retention governance
 * UI does not duplicate the base64 / checksum / download / size-formatting
 * logic that already lived inside ArtifactViewer.
 */

export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Use a pure-JS implementation instead of crypto.subtle: the production
  // Portal intentionally runs on a fixed-IP HTTP origin, which is not a
  // secure context and does not expose Web Crypto's SubtleCrypto API.
  return bytesToHex(sha256(bytes));
}

export function triggerBrowserDownload(bytes: Uint8Array, mimeType: string, fileName: string): void {
  const safeMime = isDownloadableMime(mimeType) ? mimeType : "application/octet-stream";
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: safeMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Referrer-policy on a synthetic anchor is moot since we trigger a
  // programmatic click, but rel=noopener is harmless defence-in-depth.
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * HTML and JavaScript MIME types are intentionally excluded from the download
 * path: even downloaded files of these types can be reopened in the browser
 * and reach the Portal origin if the user double-clicks them in their
 * Downloads folder. Forcing these to `application/octet-stream` makes the
 * browser save the bytes without interpreting them.
 */
export function isDownloadableMime(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    !lower.startsWith("text/html") &&
    !lower.startsWith("application/javascript") &&
    !lower.startsWith("text/javascript") &&
    lower !== "application/xhtml+xml"
  );
}

/**
 * Builds a data: URL for a sanitized SVG string so it can be rendered through
 * an <img> element (never inline DOM).
 */
export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Rasterizes a sanitized inline SVG into PNG bytes at 2x its viewBox size,
 * composited onto a white background so transparent diagrams stay readable in
 * chat apps (WeChat cannot display SVG). Works on the plain-HTTP production
 * origin: only Image + canvas, no Web Crypto or other secure-context APIs.
 * The SVG is same-origin (data URL) and the server sanitizer forbids external
 * references, so the canvas is not tainted.
 */
export async function svgToPngBytes(svg: string, scale = 2): Promise<Uint8Array> {
  const { width, height } = svgViewBoxSize(svg);
  const img = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("SVG 图片加载失败"));
  });
  img.src = svgToDataUrl(svg);
  await loaded;

  const naturalWidth = width || img.naturalWidth || 800;
  const naturalHeight = height || img.naturalHeight || 600;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(naturalWidth * scale);
  canvas.height = Math.round(naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前浏览器不支持图片转换");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG 生成失败");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Extracts "0 0 w h" from the viewBox; the runtime validator guarantees it. */
function svgViewBoxSize(svg: string): { width: number; height: number } {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']/i);
  if (!match) return { width: 0, height: 0 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * Formats an ISO timestamp as a friendly local date+time for display on
 * attachment cards ("保留至 2026-08-01 10:00"). Returns an empty string for
 * unparseable input so callers can omit the line cleanly.
 */
export function formatExpiry(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
