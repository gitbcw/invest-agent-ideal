"use client";

import { useEffect, useState } from "react";
import { isXlsxFile } from "@/lib/xlsx";
import type { ArtifactCardView } from "./types";

interface ArtifactCardProps {
  artifact: ArtifactCardView;
  onOpen: (artifact: ArtifactCardView) => void;
  onSave?: (artifact: ArtifactCardView) => Promise<{ ok: boolean; message?: string }>;
  /**
   * When true the underlying library file was deleted by the user. The card
   * becomes non-interactive and shows "文件已删除" so history stays consistent
   * with the file tree (work package §8.2).
   */
  deleted?: boolean;
}

const KIND_LABEL: Record<ArtifactCardView["kind"], string> = {
  report: "复盘",
  chart: "图表",
  data: "数据",
  document: "文档"
};

const MODE_LABEL: Record<ArtifactCardView["previewMode"], string> = {
  markdown: "Markdown",
  html: "HTML",
  image: "图片",
  pdf: "PDF",
  text: "文本",
  table: "表格",
  unsupported: "不支持预览"
};

/**
 * Clickable artifact descriptor rendered inside an assistant message bubble.
 * The actual preview is rendered in the right-hand ArtifactViewer; this card
 * only triggers `onOpen`.
 */
export function ArtifactCard({ artifact, onOpen, onSave, deleted = false }: ArtifactCardProps) {
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveToastVisible, setSaveToastVisible] = useState(false);
  useEffect(() => {
    if (!saveToastVisible) return;
    const timer = window.setTimeout(() => setSaveToastVisible(false), 3200);
    return () => window.clearTimeout(timer);
  }, [saveToastVisible]);
  if (deleted) {
    return (
      <div
        className="flex w-full max-w-md items-center gap-3 rounded-xl border border-black/5 bg-[#f7f7f8] px-3 py-2 text-left text-xs text-[#b4b4b8]"
        aria-label={`制品已删除 ${artifact.title}`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#ededed] text-[10px] font-semibold text-[#b4b4b8]">
          {extensionLabel(artifact.fileName)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{artifact.title}</span>
          <span className="mt-0.5 block text-[11px]">文件已删除</span>
        </span>
      </div>
    );
  }
  return <div className="flex w-full max-w-md items-center gap-2 rounded-xl border border-black/10 bg-white/90 px-3 py-2 text-left text-xs transition hover:border-accent-400 hover:bg-accent-50">
    <button type="button" onClick={() => onOpen(artifact)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none focus:ring-2 focus:ring-accent-300" aria-label={`打开制品 ${artifact.title}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-50 text-[10px] font-semibold text-accent-700">{extensionLabel(artifact.fileName)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[#343541]">{artifact.title}</span><span className="mt-0.5 block text-[11px] text-[#8e8ea0]">{KIND_LABEL[artifact.kind]} · {isXlsxFile(artifact.fileName, artifact.mimeType) ? "Excel" : MODE_LABEL[artifact.previewMode]} · {formatBytes(artifact.sizeBytes)}</span></span>
      <span className="shrink-0 text-[#5f6368]" aria-hidden>↗</span>
    </button>
    {artifact.savedToMyFiles ? <span className="shrink-0 text-[11px] text-[#68726b]">已保存到我的文件</span> : onSave ? <div className="flex shrink-0 flex-col items-end gap-1"><button type="button" className="rounded-md px-2 py-1 text-[11px] font-medium text-accent-700 hover:bg-accent-100 disabled:opacity-60" disabled={saveState === "saving" || saveState === "saved"} onClick={async () => { setSaveState("saving"); const result = await onSave(artifact); setSaveState(result.ok ? "saved" : "error"); setSaveMessage(result.ok ? "已保存" : (result.message || "保存失败")); if (result.ok) setSaveToastVisible(true); }}>{saveState === "saving" ? "保存中..." : saveState === "saved" ? "已保存" : "保存"}</button>{saveState === "error" ? <span className="text-[10px] text-red-600">{saveMessage}</span> : null}</div> : null}
    {saveToastVisible ? <div className="fixed right-5 top-5 z-[70] rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm text-[#365b40] shadow-lg" role="status" aria-live="polite">已保存到“我的文件”</div> : null}
  </div>;
}

function extensionLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.slice(0, 4).toUpperCase();
  return ext || "FILE";
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}
