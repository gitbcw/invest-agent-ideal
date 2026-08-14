"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, Image as ImageIcon } from "lucide-react";
import { fetchWorkspaceFiles, type ApiOutcome } from "./api";
import type { WorkspaceFileItem, WorkspaceFileListResult } from "@/lib/protocol";

interface LibraryTreeProps {
  enabled: boolean;
  refreshNonce: number;
  onOpenFile: (item: WorkspaceFileItem, pinned: boolean) => void;
  onDownload: (item: WorkspaceFileItem) => void;
  activePath?: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: WorkspaceFileItem[] }
  | { kind: "offline" }
  | { kind: "error"; reason: string };

/** Read-only tree of user-owned workspace project files. */
export function LibraryTree({ enabled, refreshNonce, onOpenFile, onDownload, activePath }: LibraryTreeProps) {
  const [state, setState] = useState<LoadState>(enabled ? { kind: "loading" } : { kind: "offline" });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const fileRefs = useRef(new Map<string, HTMLDivElement>());

  const load = useCallback(async () => {
    const outcome: ApiOutcome<WorkspaceFileListResult> = await fetchWorkspaceFiles();
    if (!outcome.ok) {
      setState(outcome.code === "CONNECTOR_OFFLINE" ? { kind: "offline" } : { kind: "error", reason: outcome.message || "加载失败" });
      return;
    }
    setState({ kind: "ready", items: outcome.data.items.filter(isVisibleWorkspaceFile) });
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ kind: "offline" });
      return;
    }
    setState({ kind: "loading" });
    void load();
  }, [enabled, load, refreshNonce]);

  const groups = useMemo(() => groupByDirectory(state.kind === "ready" ? state.items : []), [state]);

  useEffect(() => {
    if (!activePath) return;
    const directory = directoryForPath(activePath);
    setCollapsed((prev) => prev[directory] === false ? prev : { ...prev, [directory]: false });
  }, [activePath]);

  useEffect(() => {
    if (!activePath || collapsed[directoryForPath(activePath)] !== false) return;
    const frame = window.requestAnimationFrame(() => {
      fileRefs.current.get(activePath)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePath, collapsed, state]);

  if (!enabled || state.kind === "offline") return <div className="px-3 py-4 text-xs text-[#8e8ea0]">工作空间暂时不可用</div>;
  if (state.kind === "loading") return <div className="px-3 py-4 text-xs text-[#8e8ea0]">加载工作空间…</div>;
  if (state.kind === "error") return <div className="px-3 py-4 text-xs text-red-600">{state.reason}</div>;

  return (
    <nav className="flex h-full flex-col overflow-hidden" aria-label="工作空间文件">
      <div className="flex-1 overflow-auto py-1 text-sm">
        {state.items.length === 0 ? <div className="px-3 py-4 text-xs text-[#8e8ea0]">暂无可查看文件</div> : null}
        {Object.entries(groups).map(([directory, items]) => {
          const isCollapsed = collapsed[directory] ?? true;
          return (
            <div key={directory} className="mb-1">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-3 py-1 text-left text-[11px] font-semibold text-[#8e8ea0] hover:bg-black/5"
                onClick={() => setCollapsed((prev) => ({ ...prev, [directory]: !isCollapsed }))}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
                <span className="truncate">{directory || "根目录"}</span>
                <span className="text-[#b4b4b8]">({items.length})</span>
              </button>
              {!isCollapsed ? (
                <ul>
                  {items.map((item) => {
                    const previewable = item.previewMode !== "unsupported" && item.sizeBytes <= 15 * 1024 * 1024;
                    return (
                      <li key={item.fileId}>
                        <div
                          ref={(node) => {
                            if (node) fileRefs.current.set(item.relativePath, node);
                            else fileRefs.current.delete(item.relativePath);
                          }}
                          className={`flex items-center gap-1 px-3 py-1 text-[13px] ${activePath === item.relativePath ? "bg-black/5 font-medium" : "hover:bg-black/5"}`}
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left"
                            title={item.relativePath}
                            onClick={() => (previewable ? onOpenFile(item, false) : onDownload(item))}
                            onDoubleClick={() => {
                              if (previewable) onOpenFile(item, true);
                            }}
                          >
                            <span className="mr-1 inline-flex align-[-2px] text-[#7d847f]">{iconFor(item)}</span>
                            {item.fileName}
                          </button>
                          {!previewable && item.downloadable ? (
                            <button type="button" className="shrink-0 px-1 text-[11px] text-[#5f6368] hover:bg-black/10" onClick={() => onDownload(item)} title="下载">下载</button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function groupByDirectory(items: WorkspaceFileItem[]): Record<string, WorkspaceFileItem[]> {
  const groups: Record<string, WorkspaceFileItem[]> = {};
  for (const item of items) {
    const parts = item.relativePath.split("/");
    const directory = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
    (groups[directory] ??= []).push(item);
  }
  return groups;
}

function directoryForPath(relativePath: string): string {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function iconFor(item: WorkspaceFileItem) {
  if (item.previewMode === "image") return <ImageIcon size={13} aria-hidden="true" />;
  if (item.previewMode === "html") return <FileCode2 size={13} aria-hidden="true" />;
  return <FileText size={13} aria-hidden="true" />;
}

export function isVisibleWorkspaceFile(item: WorkspaceFileItem): boolean {
  return item.previewMode === "markdown"
    || item.previewMode === "html"
    || item.previewMode === "image"
    || item.mimeType === "application/yaml";
}
