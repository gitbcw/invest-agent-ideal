import { ShieldCheck } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { StrategiesPanel } from "@/components/workspace/StrategiesPanel";

export default function StrategiesPage() {
  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="strategies" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <ShieldCheck size={20} className="shrink-0 text-[#52705f]" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">我的策略</h1>
              <p className="truncate text-[11px] text-[#7a827c]">主策略常驻生效的规则与纪律；多个策略可并存，主策略唯一</p>
            </div>
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-7">
          <StrategiesPanel />
        </main>
      </div>
    </div>
  );
}
