"use client";

import { useCallback, useEffect, useState } from "react";

type RangeKey = "today" | "7d" | "30d" | "custom";

interface Summary {
  range: { from: string; to: string };
  totals: { calls: number; tokens: number; cost: number; failures: number };
  byModel: Array<{ model: string | null; calls: number; cost: number; tokens: number }>;
  byDay: Array<{ day: string; calls: number; cost: number }>;
}

interface RecordRow {
  id: number;
  created_at: string;
  model: string | null;
  modelSource: string | null;
  conversationId: string;
  channel: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  elapsedMs: number | null;
  firstTokenMs: number | null;
}

const MODEL_LABELS: Record<string, string> = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-flash-vision-exp": "DeepSeek V4 Flash Vision",
  "qwen3.7-flash": "Qwen3.7 Flash",
  "doubao-seed-2-1-turbo-260628": "豆包 Seed 2.1 Turbo",
};

function beijingDay(offsetDays: number): string {
  const now = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function fmtCost(value: number): string {
  if (value >= 100) return `¥${value.toFixed(0)}`;
  if (value >= 1) return `¥${value.toFixed(2)}`;
  return `¥${value.toFixed(3)}`;
}

export function UsageShell({ username }: { username: string }) {
  const [rangeKey, setRangeKey] = useState<RangeKey>("7d");
  const [customFrom, setCustomFrom] = useState(beijingDay(-29));
  const [customTo, setCustomTo] = useState(beijingDay(0));
  const [summary, setSummary] = useState<Summary | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const rangeParams = useCallback((): { from: string; to: string } => {
    if (rangeKey === "today") return { from: beijingDay(0), to: beijingDay(0) };
    if (rangeKey === "7d") return { from: beijingDay(-6), to: beijingDay(0) };
    if (rangeKey === "30d") return { from: beijingDay(-29), to: beijingDay(0) };
    return { from: customFrom, to: customTo };
  }, [rangeKey, customFrom, customTo]);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { from, to } = rangeParams();
      const res = await fetch(`/api/usage/summary?from=${from}&to=${to}`);
      const body = await res.json();
      if (body.ok) setSummary(body.data);
      else setError(body.error?.message ?? "加载失败");
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }, [rangeParams]);

  const loadRecords = useCallback(async (nextCursor?: string | null) => {
    const { from, to } = rangeParams();
    const params = new URLSearchParams({ from, to, limit: "50" });
    if (nextCursor) params.set("cursor", nextCursor);
    const res = await fetch(`/api/usage/records?${params.toString()}`);
    const body = await res.json();
    if (body.ok) {
      setRecords((prev) => nextCursor ? [...prev, ...body.data.items] : body.data.items);
      setCursor(body.data.nextCursor);
    }
  }, [rangeParams]);

  useEffect(() => {
    void loadSummary();
    void loadRecords(null);
  }, [loadSummary, loadRecords]);

  const maxDayCost = Math.max(0.000001, ...(summary?.byDay ?? []).map((d) => d.cost));
  const maxModelCost = Math.max(0.000001, ...(summary?.byModel ?? []).map((m) => m.cost));
  // 补齐区间内每一天（无数据的天按 0 画基线），否则稀疏数据只剩孤柱。
  const daySeries: Array<{ day: string; calls: number; cost: number }> = [];
  {
    const byDayMap = new Map((summary?.byDay ?? []).map((d) => [d.day, d]));
    const cursor = new Date(rangeParams().from + "T00:00:00Z");
    const end = new Date(rangeParams().to + "T00:00:00Z");
    for (let guard = 0; guard <= 370 && cursor <= end; guard++) {
      const key = cursor.toISOString().slice(0, 10);
      const hit = byDayMap.get(key);
      daySeries.push({ day: key, calls: hit?.calls ?? 0, cost: hit?.cost ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  const dayLabelStep = daySeries.length <= 10 ? 1 : daySeries.length <= 31 ? 5 : Math.ceil(daySeries.length / 12);

  return (
    <div className="flex min-h-screen flex-col bg-[#f6f8f6]">
      <header className="flex h-14 items-center justify-between border-b border-black/10 bg-white px-4">
        <div className="flex items-center gap-3">
          <a href="/chat" className="text-sm text-[#52705f] hover:underline">← 返回对话</a>
          <h1 className="text-base font-semibold text-[#22301f]">使用记录</h1>
        </div>
        <span className="text-xs text-[#8a938c]">{username}</span>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 space-y-5 p-4 sm:p-6">
        <section className="flex flex-wrap items-center gap-2">
          {([["today", "今天"], ["7d", "近 7 天"], ["30d", "近 30 天"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRangeKey(key)}
              className={`h-8 cursor-pointer rounded-full px-3 text-xs transition ${rangeKey === key ? "bg-[#52705f] text-white" : "bg-white text-[#5f6368] hover:bg-black/5"}`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRangeKey("custom")}
            className={`h-8 cursor-pointer rounded-full px-3 text-xs transition ${rangeKey === "custom" ? "bg-[#52705f] text-white" : "bg-white text-[#5f6368] hover:bg-black/5"}`}
          >
            自定义
          </button>
          {rangeKey === "custom" ? (
            <span className="flex items-center gap-1 text-xs text-[#5f6368]">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-8 rounded-md border border-black/10 bg-white px-2" />
              <span>至</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-8 rounded-md border border-black/10 bg-white px-2" />
            </span>
          ) : null}
        </section>

        {error ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "总开销", value: summary ? fmtCost(summary.totals.cost) : "—" },
            { label: "调用次数", value: summary ? String(summary.totals.calls) : "—" },
            { label: "总 Tokens", value: summary ? summary.totals.tokens.toLocaleString("zh-CN") : "—" },
            { label: "失败次数", value: summary ? String(summary.totals.failures) : "—" },
          ].map((card) => (
            <div key={card.label} className="rounded-lg border border-[#e3e6e3] bg-white p-3">
              <div className="text-[11px] text-[#8a938c]">{card.label}</div>
              <div className="mt-1 text-lg font-semibold text-[#22301f]">{card.value}</div>
            </div>
          ))}
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-[#e3e6e3] bg-white p-4">
            <div className="mb-3 text-sm font-medium text-[#22301f]">按天开销</div>
            <div className="flex h-48 items-end gap-1 pt-4">
              {daySeries.map((day, index) => (
                <div key={day.day} className="group relative flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${day.day}：${fmtCost(day.cost)}（${day.calls} 次）`}>
                  <span className="text-[9px] leading-none text-[#8a938c]">{day.cost > 0 ? fmtCost(day.cost).replace("¥", "") : ""}</span>
                  <div
                    className={`w-full max-w-[18px] rounded-t transition ${day.cost > 0 ? "bg-[#7a9d8a] group-hover:bg-[#52705f]" : "bg-[#e3e6e3]"}`}
                    style={{ height: `${Math.max(day.cost > 0 ? 4 : 2, (day.cost / maxDayCost) * 120)}px` }}
                  />
                  <span className="w-full truncate text-center text-[9px] leading-none text-[#a2aaa4]">
                    {index % dayLabelStep === 0 ? day.day.slice(5) : ""}
                  </span>
                </div>
              ))}
              {!daySeries.length ? <div className="w-full text-center text-xs text-[#8a938c]">暂无数据</div> : null}
            </div>
          </div>
          <div className="rounded-lg border border-[#e3e6e3] bg-white p-4">
            <div className="mb-3 text-sm font-medium text-[#22301f]">按模型开销</div>
            <div className="space-y-2">
              {(summary?.byModel ?? []).map((model) => (
                <div key={model.model ?? "unknown"} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-xs text-[#5f6368]">{MODEL_LABELS[model.model ?? ""] ?? model.model ?? "未知"}</span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-[#f0f2f0]">
                    <div className="h-full rounded bg-[#7a9d8a]" style={{ width: `${Math.max(2, (model.cost / maxModelCost) * 100)}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right text-xs text-[#22301f]">{fmtCost(model.cost)}</span>
                </div>
              ))}
              {!summary?.byModel.length ? <div className="text-xs text-[#8a938c]">暂无数据</div> : null}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-[#e3e6e3] bg-white">
          <div className="border-b border-[#eef2ee] px-4 py-3 text-sm font-medium text-[#22301f]">调用记录</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#eef2ee] text-[#8a938c]">
                  <th className="px-3 py-2 font-medium">时间</th>
                  <th className="px-3 py-2 font-medium">模型</th>
                  <th className="px-3 py-2 font-medium">来源</th>
                  <th className="px-3 py-2 font-medium">输入/输出</th>
                  <th className="px-3 py-2 font-medium">费用</th>
                  <th className="px-3 py-2 font-medium">耗时</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {records.map((row) => (
                  <tr key={row.id} className="border-b border-[#f4f6f4] last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-[#5f6368]">{row.created_at.replace("T", " ").slice(5, 19)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#22301f]">{MODEL_LABELS[row.model ?? ""] ?? row.model ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#8a938c]">{row.modelSource === "auto" ? "自动" : row.modelSource === "user-selection" ? "手动" : row.modelSource ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#5f6368]">{((row.inputTokens ?? 0) / 1000).toFixed(1)}k / {((row.outputTokens ?? 0) / 1000).toFixed(1)}k</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#22301f]">{row.cost !== null ? fmtCost(row.cost) : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[#5f6368]">{row.elapsedMs !== null ? `${(row.elapsedMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded px-1.5 py-0.5 ${row.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{row.status === "success" ? "成功" : row.status === "error" ? "失败" : row.status}</span>
                    </td>
                  </tr>
                ))}
                {!records.length && !loading ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-[#8a938c]">该时间段暂无调用</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {cursor ? (
            <div className="border-t border-[#eef2ee] p-2 text-center">
              <button type="button" onClick={() => void loadRecords(cursor)} className="cursor-pointer rounded-md px-3 py-1.5 text-xs text-[#52705f] hover:bg-black/5">加载更多</button>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
