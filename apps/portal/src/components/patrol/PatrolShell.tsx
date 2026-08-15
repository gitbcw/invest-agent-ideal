"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Play, Plus, Radar, Trash2 } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";

/**
 * E9 v2 / G21: dedicated rule-patrol page. Rule inspection is a system
 * schedule (not an automation task), so it gets its own small surface:
 * status card, rule management (create/edit/enable/delete/dry-run),
 * manual patrol (never pushes), run history.
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

type PatrolRule = {
  id: number;
  stockCode: string;
  stockName: string;
  params: { operator?: string; value?: number } & Record<string, unknown>;
  notification?: { priority?: string } & Record<string, unknown>;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
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

type RuleFormState = { stockCode: string; stockName: string; operator: ">=" | "<="; value: string; priority: "P0" | "P1" | "P2" };

const EMPTY_FORM: RuleFormState = { stockCode: "", stockName: "", operator: "<=", value: "", priority: "P2" };

const STATUS_LABEL: Record<PatrolRun["status"], string> = { running: "进行中", succeeded: "命中并推送", failed: "失败", skipped: "无命中" };
const STATUS_STYLE: Record<PatrolRun["status"], string> = {
  running: "bg-amber-50 text-amber-700", succeeded: "bg-emerald-50 text-emerald-700", failed: "bg-red-50 text-red-700", skipped: "bg-zinc-100 text-zinc-600",
};
const PRIORITY_LABEL: Record<string, string> = { P0: "重要", P1: "关注", P2: "一般" };

function fmtTime(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : value;
}

async function patrolFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const body = await res.json() as { ok?: boolean; data?: T; error?: { message?: string } };
  if (!res.ok || !body.ok || body.data === undefined) throw new Error(body.error?.message || "请求失败");
  return body.data;
}

export function PatrolShell() {
  const [data, setData] = useState<PatrolData | null>(null);
  const [rules, setRules] = useState<PatrolRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runNow, setRunNow] = useState<RunNowResult | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [dryRunNote, setDryRunNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [patrol, ruleList] = await Promise.all([
        patrolFetch<PatrolData>("/api/patrol"),
        patrolFetch<{ items: PatrolRule[] }>("/api/patrol/rules"),
      ]);
      setData(patrol);
      setRules(ruleList.items);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "巡检数据加载失败");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    setRunNow(null);
    try {
      setRunNow(await patrolFetch<RunNowResult>("/api/patrol/run-now", { method: "POST" }));
      await load();
    } catch (error) {
      setRunNow({ ranAt: new Date().toISOString(), items: [], error: error instanceof Error ? error.message : "立即巡检失败" });
    } finally {
      setRunning(false);
    }
  }, [load]);

  const openCreate = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }, []);

  const openEdit = useCallback((rule: PatrolRule) => {
    setEditingId(rule.id);
    setForm({
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      operator: rule.params.operator === ">=" ? ">=" : "<=",
      value: String(rule.params.value ?? ""),
      priority: rule.notification?.priority === "P0" || rule.notification?.priority === "P1" ? rule.notification.priority : "P2",
    });
    setFormError(null);
    setFormOpen(true);
  }, []);

  const submitRule = useCallback(async () => {
    setFormError(null);
    const value = Number(form.value);
    if (!/^\d{6}$/.test(form.stockCode.trim())) { setFormError("股票代码必须是 6 位数字（如 600519）"); return; }
    if (!form.stockName.trim()) { setFormError("请填写股票名称"); return; }
    if (!Number.isFinite(value) || value <= 0) { setFormError("阈值必须是正数"); return; }
    setSaving(true);
    try {
      if (editingId === null) {
        await patrolFetch("/api/patrol/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...form, stockCode: form.stockCode.trim(), stockName: form.stockName.trim(), value }),
        });
      } else {
        await patrolFetch(`/api/patrol/rules/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockName: form.stockName.trim(), operator: form.operator, value, priority: form.priority }),
        });
      }
      setFormOpen(false);
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [editingId, form, load]);

  const toggleEnabled = useCallback(async (rule: PatrolRule) => {
    try {
      await patrolFetch(`/api/patrol/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "启停失败");
    }
  }, [load]);

  const handleDelete = useCallback(async (id: number) => {
    try {
      await patrolFetch(`/api/patrol/rules/${id}`, { method: "DELETE" });
      setDeleteTarget(null);
      await load();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "删除失败");
    }
  }, [load]);

  const handleDryRun = useCallback(async (rule: PatrolRule) => {
    setDryRunNote(null);
    try {
      const result = await patrolFetch<{ triggered?: boolean; price?: number; reason?: string; snapshot?: { price?: number } }>(`/api/patrol/rules/${rule.id}/dry-run`, { method: "POST" });
      const price = result.price ?? result.snapshot?.price;
      setDryRunNote(`「${rule.stockName}」当前价 ${price !== undefined ? price : "未知"}，条件${result.triggered ? "已满足（如启用将提醒）" : "未满足"}`);
    } catch (error) {
      setDryRunNote(`试运行失败：${error instanceof Error ? error.message : "数据源不可用"}`);
    }
  }, []);

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
                交易时段每 {data?.status.intervalMinutes ?? "-"} 分钟自动评估启用的规则并推送命中；本页可管理规则、查看运行历史与手动巡检。
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
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-[#22301f]">我的规则</h2>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#36543d] px-3 py-1.5 text-sm font-medium text-white transition hover:bg-[#2c4632]"
            >
              <Plus size={14} />
              新建规则
            </button>
          </div>

          {formOpen ? (
            <div className="mt-4 rounded-xl border border-[#e0e7e1] bg-[#f8faf8] p-4">
              <div className="text-sm font-medium text-[#22301f]">{editingId === null ? "新建到价规则" : `编辑规则（${form.stockName}）`}</div>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <label className="text-xs text-[#6f7d73]">
                  股票代码
                  <input
                    value={form.stockCode}
                    onChange={(e) => setForm({ ...form, stockCode: e.target.value })}
                    disabled={editingId !== null}
                    placeholder="600519"
                    inputMode="numeric"
                    className="mt-1 w-full rounded-md border border-[#c8cfca] bg-white px-2 py-1.5 text-sm text-[#22301f] outline-none focus:border-[#52705f] disabled:bg-[#eef2ee] disabled:text-[#9aa39c]"
                  />
                </label>
                <label className="text-xs text-[#6f7d73]">
                  股票名称
                  <input
                    value={form.stockName}
                    onChange={(e) => setForm({ ...form, stockName: e.target.value })}
                    placeholder="贵州茅台"
                    className="mt-1 w-full rounded-md border border-[#c8cfca] bg-white px-2 py-1.5 text-sm text-[#22301f] outline-none focus:border-[#52705f]"
                  />
                </label>
                <label className="text-xs text-[#6f7d73]">
                  触发条件
                  <select
                    value={form.operator}
                    onChange={(e) => setForm({ ...form, operator: e.target.value as RuleFormState["operator"] })}
                    className="mt-1 w-full rounded-md border border-[#c8cfca] bg-white px-2 py-1.5 text-sm text-[#22301f] outline-none focus:border-[#52705f]"
                  >
                    <option value={"<="}>下破 ≤（跌到价提醒）</option>
                    <option value={">="}>上穿 ≥（涨到价提醒）</option>
                  </select>
                </label>
                <label className="text-xs text-[#6f7d73]">
                  阈值（元）
                  <input
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                    placeholder="1600"
                    inputMode="decimal"
                    className="mt-1 w-full rounded-md border border-[#c8cfca] bg-white px-2 py-1.5 text-sm text-[#22301f] outline-none focus:border-[#52705f]"
                  />
                </label>
                <label className="text-xs text-[#6f7d73]">
                  提醒级别
                  <select
                    value={form.priority}
                    onChange={(e) => setForm({ ...form, priority: e.target.value as RuleFormState["priority"] })}
                    className="mt-1 w-full rounded-md border border-[#c8cfca] bg-white px-2 py-1.5 text-sm text-[#22301f] outline-none focus:border-[#52705f]"
                  >
                    <option value="P0">重要</option>
                    <option value="P1">关注</option>
                    <option value="P2">一般</option>
                  </select>
                </label>
              </div>
              {formError ? <div className="mt-2 text-sm text-red-700">{formError}</div> : null}
              <div className="mt-3 flex gap-2">
                <button type="button" disabled={saving} onClick={() => void submitRule()} className="rounded-lg bg-[#36543d] px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-[#2c4632] disabled:opacity-50">
                  {saving ? "保存中..." : editingId === null ? "创建" : "保存修改"}
                </button>
                <button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-[#c8cfca] px-3.5 py-1.5 text-sm text-[#303632] transition hover:bg-black/5">
                  取消
                </button>
              </div>
            </div>
          ) : null}

          {dryRunNote ? <div className="mt-3 rounded-lg bg-[#eef4ef] px-3 py-2 text-sm text-[#36543d]">{dryRunNote}</div> : null}

          {rules.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#e0e7e1] text-left text-xs text-[#6f7d73]">
                    <th className="py-2 pr-3 font-medium">股票</th>
                    <th className="py-2 pr-3 font-medium">条件</th>
                    <th className="py-2 pr-3 font-medium">级别</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 pr-3 font-medium">更新时间</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id} className={`border-b border-[#eef2ee] last:border-0 ${rule.enabled ? "" : "opacity-60"}`}>
                      <td className="py-2 pr-3 text-[#22301f]">
                        <span className="font-medium">{rule.stockName}</span>
                        <span className="ml-1 text-xs text-[#6f7d73]">{rule.stockCode}</span>
                      </td>
                      <td className="py-2 pr-3 text-[#22301f]">{rule.params.operator === ">=" ? "上穿 ≥" : "下破 ≤"} {rule.params.value}</td>
                      <td className="py-2 pr-3 text-[#6f7d73]">{PRIORITY_LABEL[rule.notification?.priority ?? "P2"] ?? "一般"}</td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(rule)}
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium transition ${rule.enabled ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100" : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200"}`}
                        >
                          {rule.enabled ? "启用中" : "已停用"}
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-xs text-[#6f7d73]">{fmtTime(rule.updatedAt ?? rule.createdAt ?? null)}</td>
                      <td className="py-2">
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => openEdit(rule)} title="编辑" aria-label="编辑" className="rounded p-1.5 text-[#6f7d73] transition hover:bg-black/5 hover:text-[#22301f]">
                            <Pencil size={14} />
                          </button>
                          <button type="button" onClick={() => void handleDryRun(rule)} title="试运行（查当前价）" aria-label="试运行" className="rounded p-1.5 text-[#6f7d73] transition hover:bg-black/5 hover:text-[#22301f]">
                            <Play size={14} />
                          </button>
                          {deleteTarget === rule.id ? (
                            <>
                              <button type="button" onClick={() => void handleDelete(rule.id)} className="ml-1 rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700">
                                确认删除
                              </button>
                              <button type="button" onClick={() => setDeleteTarget(null)} className="rounded border border-[#c8cfca] px-2 py-1 text-xs text-[#303632] hover:bg-black/5">
                                取消
                              </button>
                            </>
                          ) : (
                            <button type="button" onClick={() => setDeleteTarget(rule.id)} title="删除" aria-label="删除" className="rounded p-1.5 text-[#6f7d73] transition hover:bg-red-50 hover:text-red-600">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-dashed border-[#c8cfca] bg-[#f8faf8] px-4 py-8 text-center text-sm text-[#6f7d73]">
              还没有规则。点右上角「新建规则」，例如：贵州茅台（600519）下破 1600 时提醒。
            </div>
          )}
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
