"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchArtifact, fetchAttachment, fetchWorkspaceFile, recordArtifactEvent, type ArtifactPayload } from "./api";
import {
  base64ToBytes,
  formatBytes,
  sha256Hex,
  triggerBrowserDownload
} from "./media-helpers";

interface ImageLightboxProps {
  artifactId?: string;
  attachmentId?: string;
  workspacePath?: string;
  title?: string;
  onClose: () => void;
  /**
   * Optional caption shown under the image (e.g. the curated display path).
   * Purely informational; never an absolute path.
   */
  caption?: string;
}

type ImagePayload = Pick<ArtifactPayload, "base64" | "checksum" | "mimeType" | "fileName" | "sizeBytes">;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; payload: ImagePayload; objectUrl: string }
  | { kind: "expired" }
  | { kind: "deleted" }
  | { kind: "missing"; reason: string }
  | { kind: "error"; reason: string; retryable: boolean };

/**
 * Fullscreen overlay that renders a durable image artifact. Reuses the same
 * fetch + checksum + object-URL pipeline as the inline ArtifactViewer so SVG
 * payloads still go through a blob image (never inline in the Portal script
 * context). Esc / overlay click / ✕ close. Deleted / expired artifacts show
 * a stable notice instead of a perpetual spinner.
 */
export function ImageLightbox({ artifactId, attachmentId, workspacePath, title, onClose, caption }: ImageLightboxProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [retryNonce, setRetryNonce] = useState(0);
  const objectUrlRef = useRef<string | null>(null);

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      let payload: ImagePayload;
      if (attachmentId) {
        const outcome = await fetchAttachment(attachmentId);
        if (cancelled) return;
        if (!outcome.ok) {
          setState(loadFailureState(outcome.code, outcome.message));
          return;
        }
        if (outcome.data.status !== "active") {
          setState({ kind: outcome.data.status === "deleted" ? "deleted" : "expired" });
          return;
        }
        payload = outcome.data;
      } else {
        const outcome = workspacePath
          ? await fetchWorkspaceFile(workspacePath)
          : artifactId
            ? await fetchArtifact(artifactId)
            : null;
        if (!outcome) {
          setState({ kind: "error", reason: "图片路径无效", retryable: false });
          return;
        }
        if (cancelled) return;
        if (!outcome.ok) {
          setState(loadFailureState(outcome.code, outcome.message));
          return;
        }
        payload = outcome.payload;
      }
      const bytes = base64ToBytes(payload.base64);
      if (payload.checksum) {
        const verify = await sha256Hex(bytes);
        if (verify !== payload.checksum) {
          setState({ kind: "error", reason: "checksum mismatch", retryable: false });
          return;
        }
      }
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: payload.mimeType });
      const objectUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      releaseObjectUrl();
      objectUrlRef.current = objectUrl;
      setState({ kind: "ready", payload, objectUrl });
      if (artifactId) void recordArtifactEvent(artifactId, "success");
    })();
    return () => {
      cancelled = true;
    };
  }, [artifactId, attachmentId, releaseObjectUrl, retryNonce, workspacePath]);

  useEffect(() => () => releaseObjectUrl(), [releaseObjectUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // Lock background scroll while the lightbox is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const handleDownload = useCallback(async () => {
    if (state.kind !== "ready") return;
    const bytes = base64ToBytes(state.payload.base64);
    if (state.payload.checksum) {
      const verify = await sha256Hex(bytes);
      if (verify !== state.payload.checksum) {
        setState({ kind: "error", reason: "checksum mismatch after download", retryable: false });
        return;
      }
    }
    triggerBrowserDownload(bytes, state.payload.mimeType, state.payload.fileName || title || "image");
    if (artifactId) void recordArtifactEvent(artifactId, "download");
  }, [artifactId, state, title]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `图片预览：${title}` : "图片预览"}
      onClick={onClose}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="min-w-0 truncate text-sm">
          {title || "图片"}
          {state.kind === "ready" ? (
            <span className="ml-2 text-xs text-white/60">· {formatBytes(state.payload.sizeBytes)}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {state.kind === "ready" ? (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                void handleDownload();
              }}
              title="下载"
            >
              下载
            </button>
          ) : null}
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label="关闭 (Esc)"
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>
      <div
        className="flex flex-1 items-center justify-center px-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        {state.kind === "loading" ? (
          <div className="text-sm text-white/70">加载中…</div>
        ) : null}
        {state.kind === "ready" ? (
          <div className="flex max-h-full max-w-full flex-col items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={state.objectUrl}
              alt={title || state.payload.fileName}
              className="max-h-[82vh] max-w-full object-contain"
            />
            {caption ? <div className="mt-2 text-xs text-white/60">{caption}</div> : null}
          </div>
        ) : null}
        {state.kind === "expired" ? (
          <LightboxNotice tone="warn" title="图片已过期" body="该图片已超过保留期,无法查看。" />
        ) : null}
        {state.kind === "deleted" ? (
          <LightboxNotice tone="warn" title="图片已删除" body="该图片已从文档库删除。" />
        ) : null}
        {state.kind === "missing" ? (
          <LightboxNotice tone="warn" title="图片不存在" body={state.reason} />
        ) : null}
        {state.kind === "error" ? (
          <LightboxNotice
            tone="error"
            title="无法加载图片"
            body={state.reason}
            retryable={state.retryable}
            onRetry={() => {
              releaseObjectUrl();
              setRetryNonce((n) => n + 1);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function loadFailureState(code: string, message: string): Exclude<LoadState, { kind: "loading" } | { kind: "ready"; payload: ImagePayload; objectUrl: string }> {
  if (code === "ARTIFACT_EXPIRED" || code === "ATTACHMENT_EXPIRED") return { kind: "expired" };
  if (code === "ARTIFACT_DELETED" || code === "ATTACHMENT_DELETED") return { kind: "deleted" };
  if (code === "ARTIFACT_NOT_FOUND" || code === "ARTIFACT_SCOPE_MISMATCH") {
    return { kind: "missing", reason: "该图片可能已被删除或下线" };
  }
  if (code === "CONNECTOR_OFFLINE") {
    return { kind: "error", reason: "助手暂时离线,无法读取该图片", retryable: true };
  }
  return { kind: "error", reason: message || "未知错误", retryable: false };
}

function LightboxNotice({
  tone,
  title,
  body,
  retryable,
  onRetry
}: {
  tone: "warn" | "error";
  title: string;
  body: string;
  retryable?: boolean;
  onRetry?: () => void;
}) {
  const palette =
    tone === "error" ? "border-red-300/40 bg-red-900/40 text-red-100" : "border-amber-300/40 bg-amber-900/40 text-amber-100";
  return (
    <div className={`max-w-sm rounded-lg border px-4 py-3 text-sm ${palette}`}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-xs leading-5">{body}</div>
      {retryable && onRetry ? (
        <button
          type="button"
          className="mt-3 rounded-md bg-white/10 px-2 py-1 text-xs font-semibold text-white ring-1 ring-white/20 hover:bg-white/20"
          onClick={onRetry}
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
