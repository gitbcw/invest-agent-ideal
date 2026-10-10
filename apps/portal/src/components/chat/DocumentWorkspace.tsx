"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelRightClose, X } from "lucide-react";

import { ArtifactViewer } from "./ArtifactViewer";
import type { ArtifactCardView } from "./types";
import { openPinnedTab, pinTab } from "./workspace-tabs";

/**
 * Tab model. Each artifact id can only have one tab. Tabs remember their own
 * scroll position because ArtifactViewer keeps it internally while mounted;
 * we keep all opened tabs mounted (hidden via CSS) so scroll/object URLs
 * survive tab switches, matching the existing collapse-preservation behaviour.
 */
interface WorkspaceTab {
  tabId: string;
  artifactId: string;
  title: string;
  pinned: boolean;
  // The ArtifactViewer consumes an ArtifactCardView.
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
}

const MAX_TABS = 8;

/**
 * Right-side document workspace: a multi-tab preview viewer for conversation
 * artifacts. The browser never edits or deletes files; unsupported formats
 * are download-only.
 */
export function DocumentWorkspace({
  activeRequest,
  onRequestConsumed,
  onClose,
  onCollapse,
  collapsed = false
}: DocumentWorkspaceProps) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Open / activate a tab when the parent asks for an artifact.
  useEffect(() => {
    if (!activeRequest) return;
    const view = activeRequest.view;
    const tabId = view.artifactId;
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

  return (
    <aside
      className="relative flex h-full w-full overflow-hidden bg-white"
      aria-label="文档工作区"
      hidden={collapsed}
    >
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Tab bar */}
        {tabs.length > 0 ? (
          <div className="flex h-14 shrink-0 items-stretch overflow-x-auto border-b border-[#e3e5e4] bg-[#fafbfa]">
          <div className="flex shrink-0 items-center gap-1 px-2">
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
              从对话中的报告卡片打开文件
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
  );
}
