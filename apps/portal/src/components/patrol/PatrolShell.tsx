"use client";

import { useCallback, useEffect, useState } from "react";
import { Play, Radar } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";

/**
 * E9 v2 / G21: dedicated rule-patrol page. Rule inspection is a system
 * schedule (not an automation task), so it gets its own small surface:
 * status card, manual patrol (never pushes), run history.
 */

type PatrolRun = {
  runId: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  scheduledFor: string;
  claimedAt: string;
  finishedAt: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  pushed: boolean;
  attempt: number;
  createdAt: string;
};

type PatrolData = {
  status: { rulesTotal: number; rulesEnabled: number; latestRun: PatrolRun | null; intervalMinutes: number };
  runs: PatrolRun[];
};

type RunNowResult = {
  ranAt: string;
  items: Array<{ stockCode: string; stockName: string; message: string; severity: string }>;
  error?: string;
};

const STATUS_LABEL: Record<PatrolRun["status"], string> = {
  running: "进行中",
  succeeded: "命中并推送",
  failed: "失败",
  skipped: "无命中",
};

const STATUS_STYLE: Record<PatrolRun["status"], string> = {
  running: "bg-amber-50 text-amber-700",
  succeeded: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  skipped: "bg-zinc-100 text-zinc-600",
};

function fmtTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : value;
}

export function PatrolShell() {
  const [data, setData] = useState<PatrolData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runNow, setRunNow] = useState<RunNowResult | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/patrol");
      const body = await res.json() as { ok?: boolean; data?: PatrolData; error?: { message?: string } };
      if (!res.ok || !body.ok || !body.data) throw new Error(body.error?.message || "巡检数据加载失败");
      setData(body.data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "巡检数据加载失败");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    setRunNow(null);
    try {
      const res = await fetch("/api/patrol/run-now", { method: "POST" });
      const body = await res.json() as { ok?: boolean; data?: RunNowResult; error?: { message?: string } };
      if (!res.ok || !body.ok || !body.data) throw new Error(body.error?.message || "立即巡检失败");
      setRunNow(body.data);
      await load();
    } catch (error) {
      setRunNow({ ranAt: new Date().toISOString(), items: [], error: error instanceof Error ? error.message : "立即巡检失败" });
    } finally {
      setRunning(false);
    }
  }, [load]);

  return (
    <div className="flex min-h-screen bg-[#f4f7f4] text-[#263129]">
      <PortalSidebar active="patrol" />
      <div className="min-w-0 flex-1 px-4 py-6 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-2xl border border-[#e0e7e1] bg-white p-5 shadow-[0_2px_6px_rgba(41,61,45,0.03)] sm:p-8">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[#527a5d]">
                <Radar size={17} />
                <span className="text-sm font-medium">规则巡检</span>
              </div>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[#22301f]">到价规则巡检面板</h1>
              <p className="mt-1 text-sm text-[#6f7d73]">
                交易时段每 {data?.status.intervalMinutes ?? "-"} 分钟自动评估启用的 watch 规则并推送命中；本页可查看运行历史与手动巡检。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleRunNow()}
              disabled={running || (data?.status.rulesTotal ?? 0) === 0}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[#36543d] px-3.5 py-2 text-sm font-medium text-white transition hover:bg-[#2c4632] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play size={14} />
              {running ? "巡检中..." : "立即巡检"}
            </button>
          </div>

          {loadError ? <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</div> : null}

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-[#e0e7e1] bg-[#f8faf8] px-4 py-3">
              <div className="text-xs text-[#6f7d73]">规则总数</div>
              <div className="mt-1 text-xl font-semibold text-[#22301f]">{data?.status.rulesTotal ?? "-"}</div>
            </div>
            <div className="rounded-xl border border-[#e0e7e1] bg-[#f8faf8] px-4 py-3">
              <div className="text-xs text-[#6f7d73]">启用中</div>
              <div className="mt-1 text-xl font-semibold text-[#22301f]">{data?.status.rulesEnabled ?? "-"}</div>
            </div>
            <div className="rounded-xl border border-[#e0e7e1] bg-[#f8faf8] px-4 py-3">
              <div className="text-xs text-[#6f7d73]">最近一次</div>
              <div className="mt-1 text-sm font-medium text-[#22301f]">
                {data?.status.latestRun ? `${STATUS_LABEL[data.status.latestRun.status]} · ${fmtTime(data.status.latestRun.createdAt)}` : "暂无运行"}
              </div>
            </div>
            <div className="rounded-xl border border-[#e0e7e1] bg-[#f8faf8] px-4 py-3">
              <div className="text-xs text-[#6f7d73]">自动节奏</div>
              <div className="mt-1 text-sm font-medium text-[#22301f]">交易日盘中 · 每 {data?.status.intervalMinutes ?? "-"} 分钟</div>
            </div>
          </div>

          {runNow ? (
            <div className="mt-5 rounded-xl border border-[#e0e7e1] bg-white p-4">
              <div className="text-sm font-medium text-[#22301f]">手动巡检结果（{fmtTime(runNow.ranAt)}）</div>
              {runNow.error ? (
                <div className="mt-2 text-sm text-red-700">巡检失败：{runNow.error}</div>
              ) : runNow.items.length === 0 ? (
                <div className="mt-2 text-sm text-[#6f7d73]">本次无命中。手动巡检只评估规则，不会推送消息。</div>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {runNow.items.map((item, index) => (
                    <li key={index} className="rounded-lg bg-[#f8faf8] px-3 py-2 text-sm text-[#22301f]">
                      <span className="font-medium">{item.stockName}（{item.stockCode}）</span> · {item.message}
                      <span className="ml-2 text-xs text-[#6f7d73]">{item.severity}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <div className="mt-5 rounded-2xl border border-[#e0e7e1] bg-white p-5 shadow-[0_2px_6px_rgba(41,61,45,0.03)] sm:p-8">
          <h2 className="text-lg font-semibold tracking-tight text-[#22301f]">运行历史</h2>
          {data && data.runs.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#e0e7e1] text-left text-xs text-[#6f7d73]">
                    <th className="py-2 pr-3 font-medium">时间</th>
                    <th className="py-2 pr-3 font-medium">计划槽</th>
                    <th className="py-2 pr-3 font-medium">结果</th>
                    <th className="py-2 pr-3 font-medium">推送</th>
                    <th className="py-2 font-medium">错误</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((run) => (
                    <tr key={run.runId} className="border-b border-[#eef2ee] last:border-0">
                      <td className="py-2 pr-3 text-[#22301f]">{fmtTime(run.createdAt)}</td>
                      <td className="py-2 pr-3 text-[#6f7d73]">{run.scheduledFor}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[run.status]}`}>{STATUS_LABEL[run.status]}</span>
                      </td>
                      <td className="py-2 pr-3 text-[#6f7d73]">{run.pushed ? "已推送" : "—"}</td>
                      <td className="max-w-[220px] truncate py-2 text-red-700" title={run.errorMessage ?? ""}>{run.errorMessage ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-3 text-sm text-[#6f7d73]">
              {data ? "暂无运行记录：巡检只在交易日盘中触发；也可以点右上角“立即巡检”手动评估一次。" : "加载中..."}
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
