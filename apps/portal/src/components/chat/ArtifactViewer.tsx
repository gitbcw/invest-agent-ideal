"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchArtifact,
  fetchWorkspaceFile,
  recordArtifactEvent,
  type ArtifactFetchOutcome,
  type ArtifactPayload
} from "./api";
import { MarkdownLite } from "./MarkdownLite";
import { sha256Hex } from "./media-helpers";
import type { ArtifactCardView } from "./types";
import { WorkbookPreviewBody } from "@/components/file-panel/WorkbookPreview";

interface ArtifactViewerProps {
  artifact: ArtifactCardView;
  /**
   * A caller that has already read bytes (for example, the user's file
   * library) can reuse this viewer without issuing an artifact request.
   */
  payload?: ArtifactPayload;
  /** Render inside a surrounding dialog rather than as its own side panel. */
  embedded?: boolean;
  onClose: () => void;
  onCollapse?: () => void;
  /**
   * When true, the viewer is logically collapsed: it stays mounted so the
   * loaded preview and its scroll position are preserved, but it is hidden
   * visually via CSS (width 0 / display none). Re-expanding restores the
   * exact preview and scroll position. The viewer is also responsible for
   * tracking its own preview scroll position; the chat scroll is a separate
   * concern handled by the parent.
   */
  collapsed?: boolean;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; payload: ArtifactPayload; objectUrl: string; decodedText?: string }
  | { kind: "missing"; reason: string }
  // `payload` is optional on `unsupported` / `oversize` because the state
  // arises in two distinct ways:
  //   1. The runtime refused to serve bytes (ARTIFACT_UNSUPPORTED /
  //      ARTIFACT_TOO_LARGE) — no payload, download not offered.
  //   2. The runtime served bytes but our viewer can't render them, or they
  //      exceed the inline preview threshold — payload present, download
  //      still offered.
  | { kind: "unsupported"; reason: string; payload?: ArtifactPayload }
  | { kind: "unsafe"; reason: string }
  | { kind: "oversize"; reason: string; payload?: ArtifactPayload }
  | { kind: "stale"; reason: string }
  | { kind: "error"; reason: string; retryable: boolean };

/**
 * Preview-side limits. These are intentionally distinct from the runtime's
 * publish/transfer limits — an artifact that is too large to render inline
 * can still be downloaded (subject to the runtime's own size gate).
 */
const MAX_INLINE_TEXT_BYTES = 1_500_000;
const MAX_INLINE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_PDF_BYTES = 12 * 1024 * 1024;

/**
 * Download-side limits. The runtime will reject artifact reads above
 * MAX_RUNTIME_DOWNLOAD_BYTES at the connector boundary, so we don't even
 * try to issue a download for anything larger here. Files between
 * MAX_INLINE_* and MAX_RUNTIME_DOWNLOAD_BYTES are download-only.
 */
const MAX_RUNTIME_DOWNLOAD_BYTES = 15 * 1024 * 1024;

export function ArtifactViewer({ artifact, payload: initialPayload, embedded = false, onClose, onCollapse, collapsed = false }: ArtifactViewerProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  // Persist the preview scroll position across collapse/expand cycles.
  // Collapsing does not unmount the viewer (the parent keeps it mounted
  // while hidden), so the ref survives, but we still keep an explicit
  // number so that re-expansion can restore the exact scrollTop even if
  // the inner DOM was scrolled programmatically by other effects.
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const savedScrollPositionRef = useRef<number | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  // Track scroll position while the user scrolls the preview. We capture
  // it on every change so that collapsing at any moment preserves the
  // right offset, not just the latest known programmatic scroll.
  const handlePreviewScroll = useCallback(() => {
    const el = previewScrollRef.current;
    if (!el) return;
    savedScrollPositionRef.current = el.scrollTop;
  }, []);

  // Capture the scroll position whenever we are about to collapse.
  useEffect(() => {
    if (!collapsed) return;
    const el = previewScrollRef.current;
    if (el) savedScrollPositionRef.current = el.scrollTop;
  }, [collapsed]);

  // Re-apply the saved scroll position whenever we re-expand.
  useEffect(() => {
    if (collapsed) return;
    if (savedScrollPositionRef.current === null) return;
    const el = previewScrollRef.current;
    if (!el) return;
    // Defer until the DOM has been re-shown. requestAnimationFrame runs
    // after the next paint so the element has non-zero clientHeight.
    const raf = requestAnimationFrame(() => {
      if (!previewScrollRef.current) return;
      previewScrollRef.current.scrollTop = savedScrollPositionRef.current ?? 0;
    });
    return () => cancelAnimationFrame(raf);
  }, [collapsed]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    (async () => {
      try {
        const outcome: ArtifactFetchOutcome = initialPayload
          ? { ok: true, payload: initialPayload }
          : artifact.workspacePath
            ? await fetchWorkspaceFile(artifact.workspacePath)
            : await fetchArtifact(artifact.artifactId);
        if (cancelled) return;
        const next = await deriveLoadState(outcome, artifact);
        if (cancelled) {
          if (next.kind === "ready") URL.revokeObjectURL(next.objectUrl);
          return;
        }
        releaseObjectUrl();
        if (next.kind === "ready") objectUrlRef.current = next.objectUrl;
        setState(next);
        // Only the "ready" terminal state counts as a client success event.
        // Failure states are already captured on the connector side when it
        // rejects the artifact read.
        if (next.kind === "ready" && !artifact.workspacePath && !initialPayload) {
          void recordArtifactEvent(artifact.artifactId, "success");
        }
      } catch (error) {
        if (cancelled) return;
        setState({
          kind: "error",
          reason: error instanceof Error ? error.message : "读取制品失败",
          retryable: true
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // retryNonce lets the retry button trigger a fresh load without
    // unmounting the viewer.
  }, [artifact.artifactId, artifact.previewMode, artifact.sizeBytes, artifact.workspacePath, initialPayload, releaseObjectUrl, retryNonce]);

  useEffect(() => {
    return () => releaseObjectUrl();
  }, [releaseObjectUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleDownload = useCallback(async () => {
    // Allow download from any state that carries payload bytes: "ready"
    // (normal preview), "oversize" (preview too large but bytes loaded)
    // and "unsupported" (previewer doesn't handle the MIME but bytes are
    // available). States like "missing" / "unsafe" / "stale", or
    // `unsupported` / `oversize` reached via a runtime refusal (no payload),
    // have no trustworthy bytes to offer.
    if (state.kind !== "ready" && state.kind !== "oversize" && state.kind !== "unsupported") return;
    if (!state.payload) return;
    const bytes = base64ToBytes(state.payload.base64);
    if (state.payload.checksum) {
      const verify = await sha256Hex(bytes);
      if (verify !== state.payload.checksum) {
        setState({ kind: "stale", reason: "checksum mismatch after download" });
        if (!artifact.workspacePath) void recordArtifactEvent(artifact.artifactId, "failure", {
          status: "failure",
          reason: "checksum_mismatch_download"
        });
        return;
      }
    }
    triggerBrowserDownload(bytes, state.payload.mimeType, state.payload.fileName || artifact.fileName);
    if (!artifact.workspacePath) void recordArtifactEvent(artifact.artifactId, "download");
  }, [artifact.artifactId, artifact.fileName, artifact.workspacePath, state]);

  const handleRetry = useCallback(() => {
    // In-place retry: clear object URLs and bump the effect's dependency
    // so we re-fetch the artifact without reloading the page.
    releaseObjectUrl();
    setRetryNonce((n) => n + 1);
  }, [releaseObjectUrl]);

  // `downloadAvailable` is true only when the current state actually carries
  // payload bytes that can be downloaded. `unsupported` / `oversize` reached
  // via a runtime refusal (no payload) are NOT downloadable.
  const downloadAvailable =
    (state.kind === "ready" || state.kind === "oversize" || state.kind === "unsupported") && !!state.payload;

  return (
    <aside
      className={`flex h-full w-full flex-col bg-white ${embedded ? "" : "border-l border-black/10"}`}
      aria-label="制品预览"
      // Hide entirely when collapsed. We still keep the component mounted
      // so that the loaded preview bytes, object URL and scroll position
      // are preserved. Setting `hidden` also removes the panel from the
      // accessibility tree while collapsed.
      hidden={collapsed}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-black/10 px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[#343541]">{artifact.title}</div>
          <div className="truncate text-[11px] text-[#8e8ea0]">
            {artifact.fileName} · {formatBytes(artifact.sizeBytes)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {downloadAvailable ? (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs font-medium text-[#5f6368] transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleDownload}
              title={
                state.kind === "unsupported" || state.kind === "oversize"
                  ? "下载 (此格式暂不支持在线预览,但文件可下载)"
                  : "下载"
              }
            >
              下载
            </button>
          ) : null}
          {onCollapse ? (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs font-medium text-[#5f6368] transition hover:bg-black/5"
              onClick={onCollapse}
              aria-label="折叠制品预览"
              title="折叠(保留当前选择)"
            >
              ›
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-[#5f6368] transition hover:bg-black/5"
            onClick={onClose}
            aria-label="关闭制品预览"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </header>
      <div
        ref={previewScrollRef}
        onScroll={handlePreviewScroll}
        className="flex-1 overflow-auto bg-[#fafafa]"
      >
        {state.kind === "loading" ? <LoadingPanel /> : null}
        {state.kind === "missing" ? (
          <NoticePanel tone="warn" title="制品不存在" body={state.reason} />
        ) : null}
        {state.kind === "unsupported" ? (
          <NoticePanel
            tone="info"
            title="暂不支持预览"
            body={state.payload ? `${state.reason}。可使用下载按钮获取原始文件。` : state.reason}
            downloadOffered={!!state.payload}
            onDownload={handleDownload}
          />
        ) : null}
        {state.kind === "unsafe" ? (
          <NoticePanel tone="danger" title="制品未通过安全校验" body={state.reason} />
        ) : null}
        {state.kind === "oversize" ? (
          <NoticePanel
            tone="warn"
            title="制品过大"
            body={state.payload ? `${state.reason}。请使用下载按钮查看完整内容。` : state.reason}
            downloadOffered={!!state.payload}
            onDownload={handleDownload}
          />
        ) : null}
        {state.kind === "stale" ? (
          <NoticePanel tone="warn" title="内容已变更" body={`${state.reason}。请让助手重新生成该报告。`} />
        ) : null}
        {state.kind === "error" ? (
          <ErrorPanel reason={state.reason} retryable={state.retryable} onRetry={handleRetry} />
        ) : null}
        {state.kind === "ready" ? (
          <ReadyPanel state={state} />
        ) : null}
      </div>
    </aside>
  );
}

function ReadyPanel({ state }: { state: Extract<LoadState, { kind: "ready" }> }) {
  const { payload, objectUrl, decodedText } = state;
  if (payload.workbook) {
    return <WorkbookPreviewBody workbook={payload.workbook} />;
  }
  switch (payload.previewMode) {
    case "markdown":
      return (
        <div className="mx-auto max-w-3xl px-6 py-6">
          <MarkdownLite text={decodedText ?? ""} />
        </div>
      );
    case "html":
      return (
        <iframe
          title={payload.title || payload.fileName}
          srcDoc={decodedText ?? ""}
          sandbox=""
          className="h-full min-h-[80vh] w-full border-0 bg-white"
        />
      );
    case "text":
      return (
        <pre className="whitespace-pre-wrap break-words px-6 py-6 font-mono text-xs leading-5 text-[#202123]">
          {decodedText ?? ""}
        </pre>
      );
    case "table":
      return <CsvTable text={decodedText ?? ""} />;
    case "image":
      return (
        <div className="flex min-h-full items-center justify-center p-6">
          {/* objectUrl is built from a mime-validated blob whose bytes
              were checked against the artifact checksum. SVG payloads are
              rendered via the same blob image path so they cannot execute
              in the Portal's script context. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={objectUrl}
            alt={payload.title || payload.fileName}
            className="max-h-[80vh] max-w-full object-contain"
          />
        </div>
      );
    case "pdf":
      return (
        <object data={objectUrl} type="application/pdf" className="h-full min-h-[80vh] w-full">
          <NoticePanel
            tone="info"
            title="无法内嵌 PDF"
            body="当前浏览器不支持内嵌 PDF 预览,请使用下载按钮查看。"
          />
        </object>
      );
    case "unsupported":
    default:
      return (
        <NoticePanel
          tone="info"
          title="暂不支持预览"
          body={`${payload.fileName} (${payload.mimeType}) 暂不支持在浏览器内查看,请使用下载按钮。`}
        />
      );
  }
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) {
    return (
      <NoticePanel
        tone="info"
        title="空表格"
        body="该 CSV 没有可显示的数据。"
      />
    );
  }
  return (
    <div className="responsive-data-table-scroll overflow-auto px-4 py-4">
      <table className="responsive-data-table border-collapse text-left text-xs">
        <thead className="bg-[#f4f4f4]">
          <tr>
            {rows[0].map((cell, idx) => (
              <th key={idx} className="break-words border border-black/5 px-2 py-1 font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, rIdx) => (
            <tr key={rIdx} className="even:bg-[#fafafa]">
              {row.map((cell, cIdx) => (
                <td key={cIdx} className="break-words border border-black/5 px-2 py-1 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseCsv(text: string): string[][] {
  if (!text) return [];
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function LoadingPanel() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[#8e8ea0]">
      <div className="flex items-center gap-3">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-500/60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent-500" />
        </span>
        加载制品中...
      </div>
    </div>
  );
}

function NoticePanel({
  tone,
  title,
  body,
  downloadOffered,
  onDownload
}: {
  tone: "info" | "warn" | "danger";
  title: string;
  body: string;
  downloadOffered?: boolean;
  onDownload?: () => void;
}) {
  const palette =
    tone === "danger"
      ? "border-red-200 bg-red-50 text-red-700"
      : tone === "warn"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-zinc-200 bg-zinc-50 text-zinc-700";
  return (
    <div className="flex h-full items-center justify-center px-6 py-12">
      <div className={`max-w-md rounded-lg border px-4 py-3 text-sm ${palette}`}>
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-xs leading-5 opacity-90">{body}</div>
        {downloadOffered && onDownload ? (
          <button
            type="button"
            className="mt-3 rounded-md bg-white px-2 py-1 text-xs font-semibold text-[#343541] ring-1 ring-black/10 hover:bg-black/5"
            onClick={onDownload}
          >
            下载文件
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ErrorPanel({
  reason,
  retryable,
  onRetry
}: {
  reason: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center px-6 py-12">
      <div className="max-w-md rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <div className="text-sm font-semibold">无法加载制品</div>
        <div className="mt-1 text-xs leading-5">{reason}</div>
        {retryable ? (
          <button
            type="button"
            className="mt-3 rounded-md bg-white px-2 py-1 text-xs font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100"
            onClick={onRetry}
          >
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}

async function deriveLoadState(
  outcome: ArtifactFetchOutcome,
  _artifact: ArtifactCardView
): Promise<LoadState> {
  if (!outcome.ok) {
    if (outcome.code === "ARTIFACT_NOT_FOUND") return { kind: "missing", reason: "该制品可能已被删除或下线" };
    if (outcome.code === "ARTIFACT_SCOPE_MISMATCH") return { kind: "missing", reason: "该制品不属于当前账号或助手" };
    if (outcome.code === "ARTIFACT_UNSUPPORTED") return { kind: "unsupported", reason: outcome.message };
    if (outcome.code === "ARTIFACT_UNSAFE") return { kind: "unsafe", reason: outcome.message };
    if (outcome.code === "ARTIFACT_TOO_LARGE") return { kind: "oversize", reason: outcome.message };
    if (outcome.code === "CONNECTOR_OFFLINE")
      return { kind: "error", reason: "助手暂时离线,无法读取该制品", retryable: true };
    if (outcome.code === "TIMEOUT") return { kind: "error", reason: "读取超时", retryable: true };
    return { kind: "error", reason: outcome.message || "未知错误", retryable: false };
  }
  const payload = outcome.payload;
  const bytes = base64ToBytes(payload.base64);

  if (payload.checksum) {
    const verify = await sha256Hex(bytes);
    if (verify !== payload.checksum) {
      return { kind: "stale", reason: "checksum mismatch" };
    }
  }
  // Preview-mode size gates are intentionally separate from the runtime's
  // publish/transfer size gate. When the bytes are too large for inline
  // preview we keep them in the LoadState so the user can still download
  // the file (the runtime has already agreed to serve these bytes by
  // returning them in the payload).
  if (payload.previewMode === "text" || payload.previewMode === "table" || payload.previewMode === "markdown" || payload.previewMode === "html") {
    if (bytes.length > MAX_INLINE_TEXT_BYTES) {
      return { kind: "oversize", reason: `文本内容 ${formatBytes(bytes.length)} 超过 ${formatBytes(MAX_INLINE_TEXT_BYTES)}`, payload };
    }
  }
  if (payload.previewMode === "image" && bytes.length > MAX_INLINE_IMAGE_BYTES) {
    return { kind: "oversize", reason: `图片 ${formatBytes(bytes.length)} 超过 ${formatBytes(MAX_INLINE_IMAGE_BYTES)}`, payload };
  }
  if (payload.previewMode === "pdf" && bytes.length > MAX_INLINE_PDF_BYTES) {
    return { kind: "oversize", reason: `PDF ${formatBytes(bytes.length)} 超过 ${formatBytes(MAX_INLINE_PDF_BYTES)}`, payload };
  }
  if (payload.sizeBytes && bytes.length !== payload.sizeBytes) {
    return { kind: "stale", reason: "size mismatch" };
  }

  // Portal-side workbook parsing upgrades XLSX descriptors emitted by older
  // runtimes whose durable previewMode is still "unsupported".
  if (payload.workbook) {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: payload.mimeType });
    return { kind: "ready", payload, objectUrl: URL.createObjectURL(blob) };
  }
  if (payload.workbookPreviewError) {
    return { kind: "unsupported", reason: payload.workbookPreviewError, payload };
  }

  // If the runtime hands us bytes for a MIME the viewer can't preview,
  // keep the payload so the user can still download it.
  if (payload.previewMode === "unsupported") {
    return { kind: "unsupported", reason: `当前预览器不支持 ${payload.mimeType}`, payload };
  }

  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: payload.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const decodedText =
    payload.previewMode === "markdown" || payload.previewMode === "html" || payload.previewMode === "text" || payload.previewMode === "table"
      ? new TextDecoder("utf-8").decode(bytes)
      : undefined;
  return { kind: "ready", payload, objectUrl, decodedText };
}

function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/\s+/g, "");
  const binary = atob(cleaned);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function triggerBrowserDownload(bytes: Uint8Array, mimeType: string, fileName: string) {
  const safeMime = isDownloadableMime(mimeType) ? mimeType : "application/octet-stream";
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: safeMime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  // Referrer-policy on a synthetic anchor is moot since we trigger a
  // programmatic click, but setting rel=noopener is a harmless extra
  // defence-in-depth for any future change that navigates instead of
  // downloads.
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * HTML and JavaScript MIME types are intentionally excluded from the
 * download path: even downloaded files of these types can be reopened in
 * the browser and reach the Portal origin if the user double-clicks them
 * in their Downloads folder (some browsers preserve the origin for
 * file:// navigations). Forcing these to `application/octet-stream`
 * makes the browser save the bytes without interpreting them.
 */
function isDownloadableMime(mimeType: string): boolean {
  const lowered = (mimeType || "").toLowerCase();
  if (lowered === "text/html" || lowered === "application/xhtml+xml") return false;
  if (lowered === "application/javascript" || lowered === "text/javascript") return false;
  return true;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// Kept referenced for future telemetry; mirrors the runtime's own
// download-side gate so we never attempt to download bytes the connector
// is unwilling to serve.
export const VIEWER_MAX_RUNTIME_DOWNLOAD_BYTES = MAX_RUNTIME_DOWNLOAD_BYTES;
