"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppNavigate } from "@/lib/app-navigation";
import { BookOpenCheck, Crown, FileText, Loader2, Pencil, Plus, RefreshCw, ShieldCheck } from "lucide-react";

interface StrategyCard {
  strategyId: string;
  name: string;
  status: string;
  kind: "framework" | "strategy";
  isPrimary: boolean;
  currentVersionId: string | null;
  currentVersionStatus: string | null;
  updated_at: string;
  taskBindingCount: number;
}

interface StrategyDetail {
  method: { methodId: string; name: string; status: string; currentVersionId: string | null };
  versions: Array<{ versionId: string; versionNumber: number; status: string; createdAt: string }>;
  content: { versionId: string; versionNumber: number; text: string } | null;
}

type Tab = "strategies" | "framework";
type DialogState =
  | { mode: "closed" }
  | { mode: "view"; strategy: StrategyCard }
  | { mode: "edit"; strategy: StrategyCard }
  | { mode: "create" };

export function StrategiesPanel() {
  const appNavigate = useAppNavigate();
  const [items, setItems] = useState<StrategyCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("strategies");
  const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
  const [detail, setDetail] = useState<StrategyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftName, setDraftName] = useState("");

  const reload = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/strategies", { cache: "no-store" });
      const payload = await response.json();
      const body = payload?.data ?? payload;
      if (!response.ok) throw new Error(body?.error ?? payload?.error ?? "加载失败");
      setItems(body.items ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const loadDetail = useCallback(async (strategyId: string): Promise<StrategyDetail | null> => {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/strategies/${strategyId}`, { cache: "no-store" });
      const payload = await response.json();
      const body = payload?.data ?? payload;
      if (!response.ok) throw new Error(body?.error ?? payload?.error ?? "加载失败");
      setDetail(body);
      return body as StrategyDetail;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
      return null;
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openView = useCallback(async (strategy: StrategyCard) => {
    setDialog({ mode: "view", strategy });
    setDetail(null);
    await loadDetail(strategy.strategyId);
  }, [loadDetail]);

  const openEdit = useCallback(async (strategy: StrategyCard) => {
    setDialog({ mode: "edit", strategy });
    setDetail(null);
    const loaded = await loadDetail(strategy.strategyId);
    setDraftText(loaded?.content?.text ?? "");
  }, [loadDetail]);

  const setPrimary = useCallback(async (strategy: StrategyCard) => {
    if (!window.confirm(`把「${strategy.name}」设为主策略？主策略规则将在助手每轮判断中常驻生效。`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/strategies/${strategy.strategyId}`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "操作失败");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const saveDialog = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (dialog.mode === "create") {
        const response = await fetch("/api/strategies", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: draftName, text: draftText }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? "保存失败");
      } else if (dialog.mode === "edit") {
        const response = await fetch(`/api/strategies/${dialog.strategy.strategyId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: draftText }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? "保存失败");
      }
      setDialog({ mode: "closed" });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }, [dialog, draftName, draftText, reload]);

  const strategies = useMemo(() => items?.filter((item) => item.kind !== "framework") ?? [], [items]);
  const frameworks = useMemo(() => items?.filter((item) => item.kind === "framework") ?? [], [items]);
  const primary = strategies.find((item) => item.isPrimary) ?? null;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-[#edf0ed] bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[#edf0ed] px-5 py-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <ShieldCheck size={18} className="shrink-0 text-[#52705f]" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">我的策略</h2>
              <p className="text-xs text-[#7a827c]">主策略唯一常驻；其余策略在对话中点名使用。</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void reload()} className="flex h-8 w-8 items-center justify-center rounded-md text-[#6d776f] transition hover:bg-[#f0f5f0]" aria-label="刷新" title="刷新">
              <RefreshCw size={15} className={busy ? "animate-spin" : undefined} />
            </button>
            {/* 2026-10-09 owner 裁决：新建策略对齐技能管理的 agent 式创建——
                跳到对话里由助手引导整理方案，确认后保存；不再手填表单。 */}
            <button
              type="button"
              onClick={() => appNavigate("/chat?new=1&guide=strategy-create")}
              className="flex h-8 items-center gap-1.5 rounded-md bg-[#365b40] px-3 text-xs font-medium text-white transition hover:bg-[#2c4c35]"
            >
              <Plus size={14} /> 新建策略
            </button>
          </div>
        </header>

        <div className="flex gap-1 border-b border-[#edf0ed] px-5 pt-3 sm:px-7" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "strategies"}
            onClick={() => setTab("strategies")}
            className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm transition ${tab === "strategies" ? "border-[#365b40] font-medium text-[#365b40]" : "border-transparent text-[#6d776f] hover:text-[#303632]"}`}
          >
            我的策略（{strategies.length}）
          </button>
          {/* 2026-10-09 owner 裁决：框架 tab 只在有存量框架时显示——分析方法
              归属技能域后新用户不再播种框架，空 tab 只添噪音；存量框架
              （111/mg 等用户的个性化纪律）照常在此管理。 */}
          {frameworks.length > 0 ? (
            <button
              type="button"
              role="tab"
              aria-selected={tab === "framework"}
              onClick={() => setTab("framework")}
              className={`-mb-px flex items-center gap-1.5 rounded-t-lg border-b-2 px-4 py-2 text-sm transition ${tab === "framework" ? "border-[#365b40] font-medium text-[#365b40]" : "border-transparent text-[#6d776f] hover:text-[#303632]"}`}
            >
              <BookOpenCheck size={14} /> 投资框架（{frameworks.length}）
            </button>
          ) : null}
        </div>

        <div className="px-5 py-4 sm:px-7">
          {error ? <p className="mb-3 rounded-md bg-[#fdf0ef] px-3 py-2 text-xs text-[#a1443a]">{error}</p> : null}
          {items === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" /> 加载中…</div>
          ) : tab === "strategies" || frameworks.length === 0 ? (
            strategies.length === 0 ? (
              <p className="py-6 text-sm text-[#7a827c]">还没有策略。在对话里让助手把确认过的规则保存为策略，或点右上角新建。</p>
            ) : (
              <ul className="space-y-2">
                {strategies.map((strategy) => (
                  <li key={strategy.strategyId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#edf0ed] px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openView(strategy)}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-[#303632]">{strategy.name}</span>
                        {strategy.isPrimary ? (
                          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#edf6ef] px-2 py-0.5 text-[10px] font-medium text-[#365b40]">
                            <Crown size={10} /> 主策略
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs text-[#8a918d]">
                        更新于 {new Date(strategy.updated_at).toLocaleString("zh-CN", { hour12: false })}
                        {strategy.taskBindingCount > 0 ? ` · 被 ${strategy.taskBindingCount} 个定时任务引用` : ""}
                        {strategy.currentVersionId ? "" : " · 未采用版本"}
                      </p>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button type="button" onClick={() => void openEdit(strategy)} className="flex h-8 w-8 items-center justify-center rounded-md text-[#6d776f] transition hover:bg-[#f0f5f0]" aria-label={`编辑 ${strategy.name}`} title="编辑">
                        <Pencil size={15} />
                      </button>
                      {!strategy.isPrimary ? (
                        <button type="button" onClick={() => void setPrimary(strategy)} className="h-8 rounded-md border border-[#dfe3df] px-3 text-xs text-[#365b40] transition hover:bg-[#f0f5f0]">
                          设为主策略
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
                {!primary ? (
                  <li className="rounded-md bg-[#fdf6e7] px-3 py-2 text-xs text-[#8a6d3b]">当前没有主策略：策略不会被常驻装配。选择一个策略设为主策略，或新建第一个策略（自动成为主策略）。</li>
                ) : null}
              </ul>
            )
          ) : (
            <ul className="space-y-2">
              {frameworks.map((framework) => (
                  <li key={framework.strategyId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#edf0ed] px-4 py-3">
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openView(framework)}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-[#303632]">{framework.name}</span>
                        <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#eef1f7] px-2 py-0.5 text-[10px] font-medium text-[#4a5578]">常驻</span>
                      </div>
                      <p className="mt-1 text-xs text-[#8a918d]">更新于 {new Date(framework.updated_at).toLocaleString("zh-CN", { hour12: false })}</p>
                    </button>
                    <button type="button" onClick={() => void openEdit(framework)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#6d776f] transition hover:bg-[#f0f5f0]" aria-label={`编辑 ${framework.name}`} title="编辑">
                      <Pencil size={15} />
                    </button>
                  </li>
                ))}
              </ul>
          )}
        </div>
      </section>

      {dialog.mode !== "closed" ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label={dialog.mode === "view" ? `查看：${dialog.strategy.name}` : dialog.mode === "edit" ? `编辑：${dialog.strategy.name}` : "新建策略"} onClick={() => setDialog({ mode: "closed" })}>
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-xl" onClick={(event) => event.stopPropagation()}>
            <header className="flex items-center justify-between gap-2 border-b border-[#edf0ed] px-5 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <FileText size={15} className="shrink-0 text-[#52705f]" />
                <h3 className="truncate text-sm font-semibold">
                  {dialog.mode === "create" ? "新建策略" : dialog.strategy.name}
                  {dialog.mode === "view" && dialog.strategy.kind !== "framework" && dialog.strategy.isPrimary ? "（主策略）" : ""}
                </h3>
              </div>
              <button type="button" onClick={() => setDialog({ mode: "closed" })} className="rounded p-1 text-[#6d776f] transition hover:bg-[#f0f5f0]" aria-label="关闭">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </header>
            <div className="flex-1 overflow-auto px-5 py-4">
              {dialog.mode === "view" ? (
                detailLoading || !detail ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-[#7a827c]"><Loader2 size={15} className="animate-spin" /> 加载中…</div>
                ) : detail.content ? (
                  <pre className="whitespace-pre-wrap break-words rounded-lg bg-[#f7f8f7] p-4 text-[13px] leading-6 text-[#303632]">{detail.content.text}</pre>
                ) : (
                  <p className="text-sm text-[#7a827c]">没有已采用的版本。</p>
                )
              ) : (
                <div className="space-y-3">
                  {dialog.mode === "create" ? (
                    <>
                      <input
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                        placeholder="策略名称，如：均线+放量突破策略"
                        className="w-full rounded-lg border border-[#dfe3df] px-3 py-2 text-sm outline-none focus:border-[#52705f]"
                      />
                      <p className="text-xs text-[#8a918d]">首个策略会自动成为主策略（若当前没有主策略）。</p>
                    </>
                  ) : (
                    <p className="text-xs text-[#8a918d]">
                      {dialog.strategy.kind === "framework"
                        ? "编辑投资框架：保存即成为采用版本，下一轮对话起常驻生效。"
                        : dialog.strategy.isPrimary
                          ? "编辑主策略：保存即成为采用版本，下一轮对话起常驻规则更新。"
                          : "编辑策略：保存即成为采用版本。"}
                    </p>
                  )}
                  <textarea
                    value={draftText}
                    onChange={(event) => setDraftText(event.target.value)}
                    placeholder={dialog.mode === "create" ? "策略规则：买入/卖出条件、口径、纪律、边界……" : "策略/框架内容（markdown）"}
                    rows={14}
                    className="w-full resize-y rounded-lg border border-[#dfe3df] px-3 py-2 text-sm leading-6 outline-none focus:border-[#52705f]"
                  />
                </div>
              )}
            </div>
            {dialog.mode !== "view" ? (
              <footer className="flex justify-end gap-2 border-t border-[#edf0ed] px-5 py-3">
                <button type="button" onClick={() => setDialog({ mode: "closed" })} className="h-9 rounded-md border border-[#dfe3df] px-4 text-sm text-[#303632] transition hover:bg-[#f0f5f0]">取消</button>
                <button
                  type="button"
                  disabled={busy || (dialog.mode === "create" ? !draftName.trim() : false) || !draftText.trim()}
                  onClick={() => void saveDialog()}
                  className="h-9 rounded-md bg-[#365b40] px-4 text-sm font-medium text-white transition hover:bg-[#2c4c35] disabled:opacity-40"
                >
                  保存
                </button>
              </footer>
            ) : (
              <footer className="flex justify-end border-t border-[#edf0ed] px-5 py-3">
                {dialog.strategy.kind === "framework" ? null : !dialog.strategy.isPrimary ? (
                  <button
                    type="button"
                    onClick={() => { setDialog({ mode: "closed" }); void setPrimary(dialog.strategy); }}
                    className="h-9 rounded-md border border-[#dfe3df] px-4 text-sm text-[#365b40] transition hover:bg-[#f0f5f0]"
                  >
                    设为主策略
                  </button>
                ) : null}
              </footer>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
