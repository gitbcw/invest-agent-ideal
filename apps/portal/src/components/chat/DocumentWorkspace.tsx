"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, FolderOpen, PanelRightClose, RefreshCw, X } from "lucide-react";

import { ArtifactViewer } from "./ArtifactViewer";
import { ImageLightbox } from "./ImageLightbox";
import { LibraryTree } from "./LibraryTree";
import { fetchWorkspaceFile } from "./api";
import { base64ToBytes, sha256Hex, triggerBrowserDownload } from "./media-helpers";
import type { ArtifactCardView } from "./types";
import { openPinnedTab, openPreviewTab, pinTab } from "./workspace-tabs";
import type { WorkspaceFileItem } from "@/lib/protocol";

/**
 * Tab model. Each artifact id or known workspace path can only have one tab.
 * A legacy workspace link may publish a fresh artifact id on each click, so
 * the workspace path is the stable identity when available. Tabs remember
 * their own scroll position because ArtifactViewer keeps it internally while
 * mounted; we keep all opened tabs mounted (hidden via CSS) so scroll/object
 * URLs survive tab switches, matching the existing collapse-preservation
 * behaviour.
 */
interface WorkspaceTab {
  tabId: string;
  artifactId: string;
  title: string;
  pinned: boolean;
  // The ArtifactViewer consumes an ArtifactCardView. We synthesise a minimal
  // card view from either a message-card source or a library item.
  view: ArtifactCardView;
}

interface DocumentWorkspaceProps {
  /**
   * The artifact the parent wants open right now (from clicking an in-message
   * card or a legacy path link). When it changes, the workspace opens/activates
   * a tab for it. Null closes the workspace.
   */
  activeRequest: { view: ArtifactCardView } | null;
  /** Clears the parent's one-shot open request after it has been handled. */
  onRequestConsumed: () => void;
  onClose: () => void;
  onCollapse?: () => void;
  collapsed?: boolean;
  revealTreeNonce: number;
  refreshNonce: number;
  /** Connector capability flags (controls feature visibility). */
  capabilities: {
    workspaceFileList: boolean;
    attachmentGet: boolean;
  };
}

const MAX_TABS = 8;

/**
 * Right-side document workspace: a multi-tab viewer with a full-height,
 * collapsible read-only workspace file tree. The browser never edits or
 * deletes files; unsupported formats are download-only.
 */
export function DocumentWorkspace({
  activeRequest,
  onRequestConsumed,
  onClose,
  onCollapse,
  collapsed = false,
  revealTreeNonce,
  refreshNonce,
  capabilities
}: DocumentWorkspaceProps) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [treeExpanded, setTreeExpanded] = useState(false);
  const [manualRefreshNonce, setManualRefreshNonce] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [lightboxTarget, setLightboxTarget] = useState<WorkspaceFileItem | null>(null);

  // Open / activate a tab when the parent asks for an artifact.
  useEffect(() => {
    if (!activeRequest) return;
    const view = activeRequest.view;
    const tabId = workspaceTabId(view);
    setTabs((prev) => openPinnedTab(prev, {
      tabId,
      artifactId: view.artifactId,
      title: view.title,
      pinned: true,
      view
    }, MAX_TABS));
    setActiveTabId(tabId);
    onRequestConsumed();
  }, [activeRequest?.view, onRequestConsumed]);

  useEffect(() => {
    if (revealTreeNonce > 0) setTreeExpanded(true);
  }, [revealTreeNonce]);

  // A path-bearing artifact is known to be part of the user's workspace.
  // Reveal the tree so the active file can be located; ordinary conversation
  // artifacts intentionally leave the user's current tree state untouched.
  useEffect(() => {
    if (activeRequest?.view.workspacePath) setTreeExpanded(true);
  }, [activeRequest?.view]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.tabId === tabId);
      if (idx < 0) return prev;
      const next = prev.filter((tab) => tab.tabId !== tabId);
      // If we closed the active tab, move focus to the neighbour.
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        const neighbour = next[idx] ?? next[idx - 1] ?? null;
        return neighbour ? neighbour.tabId : null;
      });
      return next;
    });
  }, []);

  const closeAll = useCallback(() => {
    setTabs([]);
    setActiveTabId(null);
    onClose();
  }, [onClose]);

  const handleOpenDocumentFromTree = useCallback((item: WorkspaceFileItem, pinned: boolean) => {
    if (item.previewMode === "image" || item.mimeType.startsWith("image/")) {
      setLightboxTarget(item);
      return;
    }
    setTabs((prev) => {
      const view: ArtifactCardView = workspaceFileToCardView(item);
      const incoming: WorkspaceTab = {
        tabId: item.relativePath,
        artifactId: item.fileId,
        title: item.fileName,
        pinned,
        view
      };
      return pinned
        ? openPinnedTab(prev, incoming, MAX_TABS)
        : openPreviewTab(prev, incoming, MAX_TABS);
    });
    setActiveTabId(item.relativePath);
    if (window.matchMedia("(max-width: 639px)").matches) setTreeExpanded(false);
  }, []);

  const handleDownloadFromTree = useCallback(async (item: WorkspaceFileItem) => {
    setDownloadError(null);
    const outcome = await fetchWorkspaceFile(item.relativePath);
    if (!outcome.ok) {
      setDownloadError(outcome.message || "下载失败");
      return;
    }
    const bytes = base64ToBytes(outcome.payload.base64);
    if (outcome.payload.checksum) {
      const actual = await sha256Hex(bytes);
      if (actual !== outcome.payload.checksum) {
        setDownloadError("文件校验失败，请重试。");
        return;
      }
    }
    triggerBrowserDownload(bytes, outcome.payload.mimeType, outcome.payload.fileName);
  }, []);

  // Esc closes the active tab (or the workspace if no tabs remain).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || collapsed) return;
      if (activeTabId) closeTab(activeTabId);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTabId, closeTab, onClose, collapsed]);

  const activeTab = useMemo(() => tabs.find((tab) => tab.tabId === activeTabId) ?? null, [tabs, activeTabId]);
  const refreshTree = useCallback(() => {
    setManualRefreshNonce((nonce) => nonce + 1);
  }, []);
  const treeToggle = (
    <button
      type="button"
      className={`flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-black/5 ${treeExpanded ? "bg-[#f1f5f3] text-[#343b36]" : "text-[#737b76]"}`}
      onClick={() => setTreeExpanded((expanded) => !expanded)}
      aria-label={treeExpanded ? "收起工作空间目录" : "展开工作空间目录"}
      aria-pressed={treeExpanded}
      title={treeExpanded ? "收起工作空间目录" : "展开工作空间目录"}
    >
      {treeExpanded ? <FolderOpen size={17} strokeWidth={1.8} aria-hidden="true" /> : <Folder size={17} strokeWidth={1.8} aria-hidden="true" />}
    </button>
  );

  return (
    <>
      <aside
        className="relative flex h-full w-full overflow-hidden bg-white"
        aria-label="文档工作区"
        hidden={collapsed}
      >
        <section
          className={`absolute inset-y-0 left-0 z-20 flex h-full shrink-0 flex-col overflow-hidden bg-[#f7f8f7] shadow-lg transition-[width] duration-200 ease-out sm:static sm:z-auto sm:shadow-none ${
            treeExpanded ? "w-[min(88vw,320px)] border-r border-[#e3e5e4] sm:w-[clamp(240px,32%,320px)]" : "w-0"
          }`}
          aria-label="工作空间"
          aria-hidden={!treeExpanded}
        >
          <div className="flex h-14 min-w-[240px] shrink-0 items-center justify-between border-b border-[#e3e5e4] px-3">
            <span className="truncate text-sm font-semibold text-[#343b36]">
              工作空间
            </span>
            {treeExpanded ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[#737b76] hover:bg-black/5"
                  onClick={refreshTree}
                  aria-label="刷新工作空间"
                  title="刷新工作空间"
                >
                  <RefreshCw size={16} aria-hidden="true" />
                </button>
                {treeToggle}
              </div>
            ) : null}
          </div>
          <div className="min-h-0 min-w-[240px] flex-1 overflow-hidden">
            <div className="h-full min-w-[240px] overflow-auto">
              <LibraryTree
                enabled={capabilities.workspaceFileList}
                refreshNonce={refreshNonce + manualRefreshNonce}
                onOpenFile={handleOpenDocumentFromTree}
                onDownload={(item) => void handleDownloadFromTree(item)}
                activePath={activeTab?.view.workspacePath}
              />
              {downloadError ? <div className="px-3 pb-2 text-xs text-red-600">{downloadError}</div> : null}
            </div>
          </div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Tab bar */}
          {tabs.length > 0 ? (
            <div className="flex h-14 shrink-0 items-stretch overflow-x-auto border-b border-[#e3e5e4] bg-[#fafbfa]">
            <div className="flex shrink-0 items-center gap-1 px-2">
              {!treeExpanded ? treeToggle : null}
              {onCollapse ? (
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-[#737b76] hover:bg-black/5"
                  onClick={onCollapse}
                  aria-label="折叠工作区"
                  title="折叠工作区"
                >
                  <PanelRightClose size={17} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            {tabs.map((tab) => {
              const active = tab.tabId === activeTabId;
              return (
                <div
                  key={tab.tabId}
                  className={`group flex max-w-[200px] items-center gap-1 border-r border-[#eceeec] px-3 text-xs ${
                    active ? "bg-white font-medium text-[#202123]" : "text-[#5f6368] hover:bg-white/60"
                  }`}
                >
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left ${tab.pinned ? "" : "italic"}`}
                    title={tab.title}
                    onClick={() => setActiveTabId(tab.tabId)}
                    onDoubleClick={() => setTabs((prev) => pinTab(prev, tab.tabId))}
                  >
                    {tab.title}
                  </button>
                  <button
                    type="button"
                    className="rounded px-1 text-[#8e8ea0] hover:bg-black/10 hover:text-red-600"
                    aria-label={`关闭标签 ${tab.title}`}
                    title="关闭标签"
                    onClick={() => closeTab(tab.tabId)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <div className="ml-auto flex shrink-0 items-center gap-1 px-2">
              <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-[#737b76] hover:bg-black/5" onClick={closeAll} aria-label="关闭全部并退出工作区" title="关闭全部">
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            </div>
          ) : (
            <div className="flex h-14 shrink-0 items-center justify-start gap-1 border-b border-[#e3e5e4] bg-[#fafbfa] px-2">
              {!treeExpanded ? treeToggle : null}
              {onCollapse ? (
                <button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-[#737b76] hover:bg-black/5" onClick={onCollapse} aria-label="折叠工作区" title="折叠工作区">
                  <PanelRightClose size={17} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          )}

          {/* Tab bodies. All mounted tabs are rendered; inactive ones are hidden
              via CSS so their ArtifactViewer state (object URL, scroll) survives
              tab switches. */}
          <div className="relative flex-1 overflow-hidden">
            {tabs.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-xs text-[#8e8ea0]">
                从工作空间或对话中的报告卡片打开文件
              </div>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.tabId}
                  className="absolute inset-0"
                  hidden={tab.tabId !== activeTabId}
                >
                  <ArtifactViewer
                    artifact={tab.view}
                    onClose={() => closeTab(tab.tabId)}
                    collapsed={collapsed || tab.tabId !== activeTabId}
                  />
                </div>
              ))
            )}
          </div>
        </section>
      </aside>

      {lightboxTarget ? (
        <ImageLightbox
          workspacePath={lightboxTarget.relativePath}
          title={lightboxTarget.fileName}
          onClose={() => setLightboxTarget(null)}
        />
      ) : null}

    </>
  );
}

function workspaceTabId(view: ArtifactCardView): string {
  return view.workspacePath || view.artifactId;
}

function workspaceFileToCardView(item: WorkspaceFileItem): ArtifactCardView {
  // The ArtifactViewer only reads a subset of ArtifactCardView; synthesise a
  // minimal but well-typed view from the library item. messageId/conversationId
  // are empty because library items are not bound to a specific message.
  return {
    artifactId: item.fileId,
    title: item.fileName,
    fileName: item.fileName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    kind: "document",
    previewMode: item.previewMode,
    createdAt: item.updatedAt,
    messageId: "",
    conversationId: "",
    workspacePath: item.relativePath
  };
}
