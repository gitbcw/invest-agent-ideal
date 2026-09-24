"use client";

import { Layers } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { SkillsPanel } from "./SkillsPanel";

export function WorkspaceShell() {
  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="workspace" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Layers size={20} className="shrink-0 text-[#52705f]" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">技能管理</h1>
              <p className="truncate text-[11px] text-[#7a827c]">管理你的 Skills 安装与目录；方法文件在「我的文件」中直接管理</p>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-7">
          <SkillsPanel />
        </main>
      </div>
    </div>
  );
}
