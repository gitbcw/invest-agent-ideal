"use client";

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { getAsset } from "@/components/assets/api";
import { useFilePanel } from "@/components/file-panel/FilePanelProvider";
import { MethodsPanel } from "./MethodsPanel";
import { SkillsPanel } from "./SkillsPanel";

type WorkspaceTab = "methods" | "skills";

export function WorkspaceShell() {
  const [tab, setTab] = useState<WorkspaceTab>("methods");
  const filePanel = useFilePanel();

  // 工作空间默认进入「我的方法」（需求确认书导航裁决）。
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (hash === "skills") setTab("skills");
  }, []);

  const openAsset = async (assetId: string) => {
    try {
      const asset = await getAsset(assetId);
      if (!asset.currentVersionId) return;
      filePanel.openAssetPreview({ kind: "asset", assetId: asset.assetId, versionId: asset.currentVersionId, title: asset.name });
    } catch {
      // The preview panel reports content errors; a missing asset is simply not opened.
    }
  };

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="workspace" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Layers size={20} className="shrink-0 text-[#52705f]" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">工作空间</h1>
              <p className="truncate text-[11px] text-[#7a827c]">管理你的正式方法与 Skills；版本保存与运行生效相互独立</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 rounded-lg bg-[#eceeeb] p-1">
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-medium transition ${tab === "methods" ? "bg-white shadow-sm" : "text-[#5f6660] hover:text-[#202123]"}`}
              onClick={() => setTab("methods")}
            >
              我的方法
            </button>
            <button
              type="button"
              className={`rounded px-3 py-1.5 text-xs font-medium transition ${tab === "skills" ? "bg-white shadow-sm" : "text-[#5f6660] hover:text-[#202123]"}`}
              onClick={() => setTab("skills")}
            >
              我的 Skills
            </button>
          </nav>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-7">
          {tab === "methods" ? <MethodsPanel onOpenAsset={openAsset} /> : <SkillsPanel />}
        </main>
      </div>
    </div>
  );
}
