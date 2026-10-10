"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, BellRing, CheckCircle2, Lightbulb, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { useAppNavigate } from "@/lib/app-navigation";

interface AttentionItem {
  itemId: string;
  kind: string;
  taskId: string | null;
  runId: string | null;
  title: string;
  impactSummary: string;
  systemStatus: string;
  errorCategory: string | null;
  status: string;
  failureCount: number;
  wechatNotified: boolean;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
  resolvedRunId: string | null;
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

async function fetchAttention(status: "open" | "resolved", limit?: number): Promise<{ items: AttentionItem[]; openCount: number }> {
  const params = new URLSearchParams({ status });
  if (limit) params.set("limit", String(limit));
  const response = await fetch(`/api/attention?${params.toString()}`);
  const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: { items: AttentionItem[]; openCount: number } } | null;
  if (!payload || payload.ok !== true) throw new Error("待处理列表加载失败");
  return payload.data ?? { items: [], openCount: 0 };
}

/** 全局待处理（首版仅失败告知）。收口历史分「已恢复」（任务自动恢复）与「已关闭」（用户手动关闭）两栏。 */
export function AttentionShell() {
  const appNavigate = useAppNavigate();
  const [view, setView] = useState<"open" | "resolved">("open");
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [resolvedItems, setResolvedItems] = useState<AttentionItem[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [resolvedLimit, setResolvedLimit] = useState(20);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [candidateBusy, setCandidateBusy] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);

  // 手动关闭的行服务端直接丢弃，不再保留；这里只维护自动恢复历史。
  const recoveredItems = resolvedItems;
  const visibleItems = view === "open" ? items : recoveredItems;

  const closeItem = async (item: AttentionItem) => {
    setClosing(item.itemId);
    try {
      const response = await fetch(`/api/attention/${encodeURIComponent(item.itemId)}/resolve`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message: string } } | null;
      if (!payload || payload.ok !== true) throw new Error(payload?.error?.message || "关闭失败");
      setItems((current) => current.filter((entry) => entry.itemId !== item.itemId));
      setOpenCount((count) => Math.max(0, count - 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "关闭失败");
    } finally {
      setClosing(null);
    }
  };

  interface CandidateView {
    objectId: string;
    kind: "lesson" | "workflow";
    title: string;
    status: string;
    surface: "conversation" | "task";
    versionId: string;
    content: Record<string, unknown>;
    previouslyRejected: boolean;
    updatedAt: string;
  }
  const refreshCandidates = useCallback(async () => {
    try {
      const response = await fetch("/api/state-candidates");
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: { items: CandidateView[] } } | null;
      if (payload?.ok === true) setCandidates(payload.data?.items ?? []);
    } catch {
      /* 候选区加载失败不阻塞失败事项列表 */
    }
  }, []);
  useEffect(() => {
    void refreshCandidates();
  }, [refreshCandidates]);

  const actCandidate = async (candidate: CandidateView, action: "approve" | "reject") => {
    setCandidateBusy(candidate.objectId);
    try {
      const response = await fetch("/api/state-candidates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "approve"
            ? { action, objectId: candidate.objectId, kind: candidate.kind, versionId: candidate.versionId }
            : { action, objectId: candidate.objectId, kind: candidate.kind },
        ),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: { message: string } } | null;
      if (!payload || payload.ok !== true) throw new Error(payload?.error?.message || "操作失败");
      await refreshCandidates();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setCandidateBusy(null);
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "open") {
        const data = await fetchAttention("open");
        setItems(data.items);
        setOpenCount(data.openCount);
      } else {
        const data = await fetchAttention("resolved", resolvedLimit);
        setResolvedItems(data.items);
        setOpenCount(data.openCount);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [view, resolvedLimit]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const nextLimit = resolvedLimit + 20;
      const data = await fetchAttention("resolved", nextLimit);
      setResolvedItems(data.items);
      setResolvedLimit(nextLimit);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoadingMore(false);
    }
  }, [resolvedLimit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="attention" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <BellRing size={20} className="shrink-0 text-[#52705f]" />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">待处理</h1>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-0.5 rounded-lg bg-[#eceeeb] p-1 text-xs">
              <button type="button" className={`rounded px-2.5 py-1 font-medium ${view === "open" ? "bg-white shadow-sm" : "text-[#5f6660]"}`} onClick={() => setView("open")}>
                未处理{openCount > 0 ? `（${openCount}）` : ""}
              </button>
              <button type="button" className={`rounded px-2.5 py-1 font-medium ${view === "resolved" ? "bg-white shadow-sm" : "text-[#5f6660]"}`} onClick={() => setView("resolved")}>
                已恢复{recoveredItems.length > 0 ? `（${recoveredItems.length}）` : ""}
              </button>
            </div>
            <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
            </button>
          </div>
        </header>
        {error ? (
          <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button>
          </div>
        ) : null}
        <main className="min-w-0 flex-1 p-4 sm:p-7">
          {loading ? (
            <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载待处理事项…</div>
          ) : visibleItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#dfe3df] bg-white px-6 py-12 text-center text-sm text-[#7a827c]">
              {view === "open" ? "没有需要处理的失败事项。" : "还没有自动恢复的记录。"}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visibleItems.map((item) => (
                <article key={item.itemId} className="flex flex-col gap-3 rounded-xl border border-[#e5e8e5] bg-white p-4 shadow-[0_1px_2px_rgba(35,55,40,0.04)]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      {view === "open" ? <AlertTriangle size={17} className="shrink-0 text-amber-600" /> : <CheckCircle2 size={17} className="shrink-0 text-emerald-600" />}
                      <h2 className="truncate text-sm font-semibold">{item.title}</h2>
                      {item.failureCount > 1 ? <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">连续 {item.failureCount} 次</span> : null}
                    </div>
                    <span className="shrink-0 text-[11px] text-[#89948c]">{formatTime(item.lastFailedAt)}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-[#303632]">{item.impactSummary}</span>
                    <span className="rounded-full bg-[#f1f4f1] px-2 py-0.5 text-[11px] text-[#66736a]">{item.systemStatus}</span>
                  </div>
                  {view === "open" ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#f0f2f0] pt-3">
                      <span className="text-[11px] text-[#8a938c]">{item.wechatNotified ? "微信提醒：已记录，送达情况请看投递记录" : "微信提醒：未生成"}</span>
                      <div className="flex items-center gap-1.5">
                        {item.taskId ? (
                          <a className="btn-secondary px-2.5 py-1.5 text-xs" href={`/automations/${encodeURIComponent(item.taskId)}`}>查看任务</a>
                        ) : null}
                        <button
                          type="button"
                          className="btn-secondary px-2.5 py-1.5 text-xs"
                          disabled={closing === item.itemId}
                          onClick={() => void closeItem(item)}
                        >
                          {closing === item.itemId ? <Loader2 size={15} className="animate-spin" /> : null}直接关闭
                        </button>
                        <button
                          type="button"
                          className="btn-primary px-2.5 py-1.5 text-xs"
                          disabled={opening}
                          onClick={async () => {
                            setOpening(true);
                            try {
                              const response = await fetch(`/api/attention/${encodeURIComponent(item.itemId)}/conversation`, { method: "POST" });
                              const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: { conversationId: string } } | null;
                              if (payload?.ok !== true || !payload.data) throw new Error("会话创建失败");
                              // autosend=attention-analysis：会话上下文已由服务端注入，
                              // ChatShell 选中该会话后自动发送一次分析请求。
                              appNavigate(`/chat?conversationId=${encodeURIComponent(payload.data.conversationId)}&autosend=attention-analysis`);
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "会话创建失败");
                              setOpening(false);
                            }
                          }}
                        >
                          <Sparkles size={15} />AI分析
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-[#8a938c]">收口时间 {formatTime(item.resolvedAt)}</div>
                  )}
                </article>
              ))}
            </div>
          )}
          {!loading && view !== "open" && visibleItems.length >= resolvedLimit ? (
            <div className="mt-4 flex justify-center">
              <button type="button" className="btn-secondary px-3 py-1.5 text-xs" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <Loader2 size={15} className="animate-spin" /> : null}加载更多
              </button>
            </div>
          ) : null}
        {view === "open" && candidates.length > 0 ? (
          <section className="mt-2 rounded-lg border border-[#dfe3df] bg-white p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Lightbulb size={15} className="text-[#52705f]" />待确认改进（{candidates.length}）</h2>
              <p className="mb-3 text-xs text-[#7a827c]">Agent 在对话或任务运行中提出的改进候选；批准后才可能影响后续行为，默认不发送微信提醒。</p>
              <div className="flex flex-col gap-3">
                {candidates.map((candidate) => (
                  <article key={candidate.objectId} className="rounded border border-[#eceeeb] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="rounded bg-[#eceeeb] px-1.5 py-0.5 text-[10px] text-[#5f6660]">{candidate.kind === "lesson" ? "经验" : "工作流"}</span>
                        <h3 className="truncate text-sm font-medium">{candidate.title}</h3>
                        {candidate.previouslyRejected ? <span className="shrink-0 rounded bg-[#f4efe2] px-1.5 py-0.5 text-[10px] text-[#8a6d3b]">此前有同类被拒候选</span> : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button type="button" className="btn-primary px-2.5 py-1 text-[11px]" disabled={candidateBusy === candidate.objectId} onClick={() => void actCandidate(candidate, "approve")}>批准生效</button>
                        <button type="button" className="btn-secondary px-2.5 py-1 text-[11px]" disabled={candidateBusy === candidate.objectId} onClick={() => void actCandidate(candidate, "reject")}>拒绝</button>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs text-[#5f6660]">{String(candidate.content.trigger || candidate.content.scenario || "")}</p>
                    {candidate.content.guidance ? <p className="mt-1 text-xs text-[#5f6660]">处置：{String(candidate.content.guidance)}</p> : null}
                    <p className="mt-1.5 text-[11px] text-[#8a938c]">来源：{candidate.surface === "conversation" ? "对话" : "定时任务"} · {formatTime(candidate.updatedAt)}</p>
                  </article>
                ))}
              </div>
            </section>
        ) : null}
        </main>
      </div>
    </div>
  );
}
