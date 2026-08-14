"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ArtifactPreviewMode, UserAssetVersionPayload } from "@/lib/protocol";
import { downloadAsset, getAssetVersion, listAssetVersions } from "@/components/assets/api";
import { fetchArtifact, type ArtifactPayload } from "@/components/chat/api";
import { ArtifactViewer } from "@/components/chat/ArtifactViewer";
import type { ArtifactCardView } from "@/components/chat/types";
import type { WorkbookPreviewData } from "@/lib/workbook-preview";
import { WorkbookPreview } from "./WorkbookPreview";

export type FilePanelMode = "none" | "asset-preview" | "workspace";
type PreviewTarget =
  | { kind: "asset"; assetId: string; versionId: string | null; title: string }
  | { kind: "artifact"; artifactId: string; title: string }
  | { kind: "report"; mappingId: string; title: string };
type FilePanelState = { mode: "none" } | { mode: "asset-preview"; target: PreviewTarget } | { mode: "workspace" };
type FilePanelContextValue = {
  state: FilePanelState;
  openAssetPreview: (target: PreviewTarget) => void;
  openWorkspace: () => void;
  close: () => void;
};

const FilePanelContext = createContext<FilePanelContextValue | null>(null);

export function FilePanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FilePanelState>({ mode: "none" });
  const openAssetPreview = useCallback((target: PreviewTarget) => setState({ mode: "asset-preview", target }), []);
  const openWorkspace = useCallback(() => setState({ mode: "workspace" }), []);
  const close = useCallback(() => setState({ mode: "none" }), []);
  return <FilePanelContext.Provider value={{ state, openAssetPreview, openWorkspace, close }}>{children}<FilePanel state={state} onClose={close} /></FilePanelContext.Provider>;
}

export function useFilePanel(): FilePanelContextValue {
  const value = useContext(FilePanelContext);
  if (!value) throw new Error("useFilePanel must be used inside FilePanelProvider");
  return value;
}

function FilePanel({ state, onClose }: { state: FilePanelState; onClose: () => void }) {
  const [payload, setPayload] = useState<ArtifactPayload | null>(null);
  const [workbook, setWorkbook] = useState<WorkbookPreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (state.mode === "none") return;
    let cancelled = false;
    setLoadError(null);
    if (state.mode === "asset-preview") {
      setLoading(true); setPayload(null); setWorkbook(null);
      void (async () => {
        try {
          if (state.target.kind === "asset") {
            const { assetId, versionId } = state.target;
            if (!versionId) throw new Error("该文件没有可预览的版本");
            const versions = await listAssetVersions(assetId);
            const descriptor = versions.find((item) => item.versionId === versionId);
            if (!descriptor) throw new Error("该文件版本不存在");
            if (descriptor.format === "xlsx" || descriptor.fileName.toLowerCase().endsWith(".xlsx")) {
              const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(versionId)}/workbook`);
              const body = await response.json() as { ok?: boolean; data?: WorkbookPreviewData; error?: { message?: string } };
              if (!response.ok || !body.ok || !body.data) throw new Error(body.error?.message || "Excel 工作簿无法读取");
              if (!cancelled) setWorkbook(body.data);
            } else {
              const version = await getAssetVersion(assetId, versionId);
              if (!cancelled) setPayload(toArtifactPayload(version, state.target.title));
            }
          } else if (state.target.kind === "artifact") {
            const result = await fetchArtifact(state.target.artifactId);
            if (result.ok) {
              if (!cancelled) setPayload(result.payload);
            } else if (!cancelled) {
              setLoadError(result.message || "文件内容不可用");
            }
          } else {
            const response = await fetch(`/api/reports/mappings/${encodeURIComponent(state.target.mappingId)}`);
            const body = await response.json() as { ok?: boolean; data?: UserAssetVersionPayload };
            if (!cancelled && body.ok && body.data) setPayload(toArtifactPayload(body.data, state.target.title));
            else if (!cancelled) setLoadError("文件内容不可用");
          }
        } catch (cause) {
          if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "文件内容不可用");
        } finally { if (!cancelled) setLoading(false); }
      })();
    } else {
      setPayload(null);
      setWorkbook(null);
      setLoading(false);
    }
    return () => { cancelled = true; };
  }, [state]);
  useEffect(() => {
    if (state.mode !== "asset-preview") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [state.mode]);
  if (state.mode === "none") return null;
  // The established DocumentWorkspace remains the workspace renderer. It is
  // driven by the same global state, so opening it still closes any preview.
  if (state.mode === "workspace") return null;
  const title = state.mode === "asset-preview" ? state.target.title : "文件工作区";
  const handleWorkbookDownload = async () => {
    if (state.mode !== "asset-preview" || state.target.kind !== "asset" || !state.target.versionId) return;
    setDownloading(true);
    try { downloadAsset(await getAssetVersion(state.target.assetId, state.target.versionId)); }
    catch (cause) { setLoadError(cause instanceof Error ? cause.message : "文件下载失败"); }
    finally { setDownloading(false); }
  };
  const view: ArtifactCardView | null = payload ? { artifactId: payload.artifactId, title, fileName: payload.fileName, mimeType: payload.mimeType, sizeBytes: payload.sizeBytes, kind: payload.kind, previewMode: payload.previewMode, createdAt: payload.createdAt, checksum: payload.checksum, messageId: "", conversationId: "" } : null;
  return <div data-file-panel-mode={state.mode} className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-8 backdrop-blur-[1px] max-sm:p-0">
    <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="关闭文件预览" />
    <aside className="relative flex h-[min(900px,calc(100vh-4rem))] w-[min(1200px,calc(100vw-4rem))] flex-col overflow-hidden rounded-xl border border-[#dfe3df] bg-white shadow-2xl max-sm:h-full max-sm:w-full max-sm:rounded-none" role="dialog" aria-modal="true" aria-label={`${title} 文件预览`}>
      {loading ? <div className="flex min-h-[280px] items-center justify-center text-sm text-[#68726b]">正在打开文件...</div> : null}
      {loadError ? <div className="m-5 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</div> : null}
      {workbook ? <WorkbookPreview title={title} workbook={workbook} downloading={downloading} onDownload={() => void handleWorkbookDownload()} onClose={onClose} /> : null}
      {view && payload ? <ArtifactViewer artifact={view} payload={payload} embedded onClose={onClose} /> : null}
    </aside>
  </div>;
}

function toArtifactPayload(version: UserAssetVersionPayload, title: string): ArtifactPayload {
  return { artifactId: version.versionId, title, fileName: version.fileName, mimeType: version.mimeType, sizeBytes: version.sizeBytes, kind: "document", previewMode: previewModeFor(version), createdAt: version.createdAt, checksum: version.checksum, base64: version.base64, sanitized: true };
}

function previewModeFor(version: UserAssetVersionPayload): ArtifactPreviewMode {
  const mime = version.mimeType.toLowerCase();
  const name = version.fileName.toLowerCase();
  if (mime === "text/csv" || name.endsWith(".csv")) return "table";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime === "text/markdown" || name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (mime === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (mime.startsWith("text/") || mime === "application/json" || name.endsWith(".json")) return "text";
  return "unsupported";
}
