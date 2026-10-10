"use client";

import { useEffect, useState } from "react";
import { Link2, Loader2, X } from "lucide-react";
import { listAssetReferences } from "./api";

const SOURCE_LABELS: Record<string, string> = {
  upload: "手动上传",
  conversation: "对话保存",
  automation: "自动化产物",
  system: "系统",
};

type WorkspaceUsage = {
  methods: Array<{ methodId: string; name: string; currentVersionId: string | null }>;
  skills: Array<{ skillId: string; name: string; slug: string; currentVersionId: string | null }>;
};

/**
 * 文件关联信息弹层（T-538 我的文件关联升级）：
 * 来源、被自动化引用、被方法/技能引用。方法/技能只提供跳转，
 * 不在本页形成第二编辑入口。
 */
export function AssetLinksDialog({ assetId, name, source, onClose }: { assetId: string; name: string; source?: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taskBindings, setTaskBindings] = useState<Array<{ taskId: string; role: string; versionPolicy: string; versionId: string | null }>>([]);
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [references, workspaceUsage] = await Promise.all([
          listAssetReferences(assetId),
          fetch(`/api/assets/${encodeURIComponent(assetId)}/workspace-usage`).then(async (response) => {
            const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: WorkspaceUsage } | null;
            if (!payload || payload.ok !== true) throw new Error("关联信息加载失败");
            return payload.data ?? { methods: [], skills: [] };
          }),
        ]);
        if (cancelled) return;
        setTaskBindings(references.taskBindings ?? []);
        setUsage(workspaceUsage);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "关联信息加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label={`关联信息：${name}`}>
      <div className="flex max-h-[75vh] w-full max-w-xl flex-col gap-3 overflow-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-base font-semibold"><Link2 size={17} className="text-[#52705f]" />关联信息</h2>
          <button type="button" className="rounded p-1 hover:bg-[#f0f5f0]" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="truncate text-xs text-[#7a827c]">{name}</p>
        <div className="text-xs">
          <span className="text-[#5f6660]">来源：</span>
          <span>{SOURCE_LABELS[source || ""] || source || "未知"}</span>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载关联…</div>
        ) : error ? (
          <div className="border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        ) : (
          <>
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">被定时任务引用（{taskBindings.length}）</h3>
              {taskBindings.length === 0 ? (
                <p className="text-xs text-[#7a827c]">暂无自动化读写该文件。</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {taskBindings.map((binding, index) => (
                    <li key={`${binding.taskId}-${index}`} className="flex items-center justify-between gap-2 text-xs">
                      <a className="truncate text-[#52705f] hover:underline" href={`/automations/${encodeURIComponent(binding.taskId)}`}>{binding.taskId}</a>
                      <span className="shrink-0 text-[#7a827c]">{binding.role === "input" ? "输入" : binding.role === "output" ? "输出" : binding.role}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-1.5 text-sm font-semibold">方法与技能引用</h3>
              {usage && (usage.methods.length > 0 || usage.skills.length > 0) ? (
                <ul className="flex flex-col gap-1">
                  {usage.methods.map((method) => (
                    <li key={method.methodId} className="text-xs">
                      方法 <a className="text-[#52705f] hover:underline" href="/workspace">{method.name}</a>
                    </li>
                  ))}
                  {usage.skills.map((skill) => (
                    <li key={skill.skillId} className="text-xs">
                      技能 <a className="text-[#52705f] hover:underline" href="/workspace#skills">{skill.name}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-[#7a827c]">该文件不是方法或技能的内容来源。</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
