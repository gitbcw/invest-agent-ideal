"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Settings as SettingsIcon, X } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";
import { WechatBindingPanel } from "./WechatBindingPanel";
import { activateAutomation, fetchAutomations, pauseAutomation, updateAutomation } from "@/components/automation/api";
import type { AutomationTask } from "@/lib/protocol";

interface Preferences {
  wechatFailureEnabled: boolean;
  wechatRecoveryEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  categories: string[] | null;
  defaultDeliveryMode: "wechat" | "none";
}

const NOTIFICATION_CATEGORIES = [
  { value: "failure", label: "任务失败时提醒我", description: "任务第一次失败时，通过微信提醒" },
  { value: "recovery", label: "任务恢复后提醒我", description: "任务从失败恢复后，通过微信提醒" },
] as const;

/** 推送任务（2026-10-09 owner 裁决）：向导第三步配置的四项系统推送任务在
 * 设置页常驻化——开关直接启停任务，时间/时间窗行内调整，与定时任务页
 * 同一份状态。按 taskId 后缀识别（preset 播种 id 形如 preset_*_<type>）。 */
const PUSH_TASK_DEFS = [
  { suffix: "scheduled-daily-review", label: "盘后复盘推送", description: "交易日收盘后推送当日复盘" },
  { suffix: "scheduled-weekly-review", label: "周复盘推送", description: "每周推送周度复盘" },
  { suffix: "scheduled-monthly-review", label: "月复盘推送", description: "每月推送月度复盘" },
  { suffix: "scheduled-market-watch", label: "盘中盯盘提醒", description: "交易日盘中按时间窗检查持仓异动" },
] as const;

function toMinutes(slot: string): number {
  const [h, m] = slot.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function TimeSelect({ value, onChange, ariaLabel, disabled, emptyLabel }: { value: string | null; onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; /** 提供时允许「未设置」空选项，onChange 收到空串。 */ emptyLabel?: string }) {
  const slots: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      slots.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  const current = value && slots.includes(value) ? value : (() => {
    if (!value) return "";
    const [h, m] = value.split(":").map(Number);
    const nearest = slots.reduce((best, slot) => Math.abs(toMinutes(slot) - (h * 60 + (m ?? 0))) < Math.abs(toMinutes(best) - (h * 60 + (m ?? 0))) ? slot : best, slots[0]!);
    return nearest;
  })();
  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded border border-neutral-200 bg-white px-2 text-sm disabled:opacity-50"
      aria-label={ariaLabel}
    >
      {emptyLabel ? <option value="">{emptyLabel}</option> : null}
      {slots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
    </select>
  );
}

/** 设置页管理跨任务提醒偏好；不修改既有任务的 schedule/delivery。 */
export function SettingsShell() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pushTasks, setPushTasks] = useState<Array<{ def: (typeof PUSH_TASK_DEFS)[number]; task: AutomationTask }> | null>(null);
  const [taskBusy, setTaskBusy] = useState<string | null>(null);

  const loadPushTasks = useCallback(async () => {
    try {
      const result = await fetchAutomations({ limit: 50 });
      const rows = PUSH_TASK_DEFS
        .map((def) => {
          const task = result.items.find((item) => item.taskId.endsWith(def.suffix));
          return task ? { def, task } : null;
        })
        .filter((row): row is { def: (typeof PUSH_TASK_DEFS)[number]; task: AutomationTask } => row !== null);
      setPushTasks(rows);
    } catch {
      setPushTasks([]);
    }
  }, []);

  useEffect(() => {
    void loadPushTasks();
  }, [loadPushTasks]);

  const setTaskEnabled = async (task: AutomationTask, enabled: boolean) => {
    setTaskBusy(task.taskId);
    setError(null);
    try {
      if (enabled) {
        await activateAutomation(task.taskId, task.currentRevision);
      } else {
        await pauseAutomation(task.taskId, task.currentRevision);
      }
      await loadPushTasks();
      setNotice(enabled ? `已开启「${task.revision.name}」，按计划时间推送。` : `已暂停「${task.revision.name}」，不再推送。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "任务状态更新失败");
    } finally {
      setTaskBusy(null);
    }
  };

  const setTaskSchedule = async (task: AutomationTask, schedule: AutomationTask["revision"]["schedule"]) => {
    setTaskBusy(task.taskId);
    setError(null);
    try {
      const updated = await updateAutomation(task.taskId, { schedule });
      // updateAutomationTask 落新 revision 时保守置 paused 并清 next_run_at
      //（onboarding 同款坑）：改时间前在跑的任务要立刻按新计划激活。
      if (task.status === "active") {
        await activateAutomation(task.taskId, updated.currentRevision);
      }
      await loadPushTasks();
      setNotice(`已更新「${task.revision.name}」的推送时间${task.status === "active" ? "，按新计划生效" : ""}。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "推送时间更新失败");
    } finally {
      setTaskBusy(null);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/preferences");
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: Preferences } | null;
      if (!payload || payload.ok !== true) throw new Error("偏好加载失败");
      setPreferences(payload.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<Preferences>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: Preferences; error?: { message: string } } | null;
      if (!payload || payload.ok !== true) throw new Error(payload?.error?.message || "保存失败");
      setPreferences(payload.data ?? null);
      setNotice("已保存。偏好只影响提醒投递，网页待处理、任务运行和既有任务配置不受影响。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#f7f8f7] text-[#202123]">
      <div className="hidden sm:block"><PortalSidebar active="settings" /></div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-[#dfe3df] bg-white px-4 py-2 sm:px-7">
          <div className="flex items-center gap-3">
            <SettingsIcon size={20} className="shrink-0 text-[#52705f]" />
            <div><h1 className="text-base font-semibold">设置</h1><p className="text-[11px] text-[#7a827c]">通知偏好等低频配置</p></div>
          </div>
          <button type="button" className="btn-secondary px-2.5 py-1.5 text-xs" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />刷新
          </button>
        </header>
        {error ? (
          <div className="flex items-center justify-between border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="关闭错误"><X size={15} /></button>
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50 px-5 py-2 text-xs text-emerald-800">
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={14} /></button>
          </div>
        ) : null}
        <main className="min-w-0 flex-1 p-4 sm:p-7">
          {loading || !preferences ? (
            <div className="flex items-center gap-2 px-2 py-8 text-sm text-[#7a827c]"><Loader2 size={16} className="animate-spin" />加载偏好…</div>
          ) : (
            <section className="flex max-w-2xl flex-col gap-6 rounded-lg border border-[#dfe3df] bg-white p-5">
              <div>
                <h2 className="text-sm font-semibold">通知设置</h2>
              </div>
              {pushTasks && pushTasks.length > 0 ? (
                <div className="flex flex-col gap-3 rounded-xl border border-[#d9e5db] bg-[#f7fbf7] p-4">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#304936]"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#dcecdf] text-xs text-[#52705f]">1</span>推送任务</div>
                    <p className="mt-1 text-xs text-[#7a827c]">初始化时配置的复盘与盯盘推送在这里调整；深度管理（指令、输入输出）到定时任务页。</p>
                  </div>
                  {pushTasks.map(({ def, task }) => {
                    const schedule = task.revision.schedule;
                    const enabled = task.status === "active";
                    const busy = taskBusy === task.taskId;
                    return (
                      <div key={task.taskId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#dce7dd] bg-white px-3 py-3">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                          <input
                            type="checkbox"
                            className="h-4 w-8 shrink-0 accent-[#52705f]"
                            checked={enabled}
                            disabled={busy}
                            onChange={(event) => void setTaskEnabled(task, event.target.checked)}
                          />
                          <span className="text-xs"><span className="block font-medium text-[#303632]">{def.label}</span><span className="mt-1 block text-[#7a827c]">{def.description}</span></span>
                        </label>
                        <div className="flex shrink-0 flex-wrap items-center gap-1" aria-label={`${def.label}时间`}>
                          {schedule.windows && schedule.windows.length > 0 ? (
                            schedule.windows.map((window, index) => (
                              <TimeSelect
                                key={index}
                                value={window}
                                disabled={busy}
                                ariaLabel={`${def.label}时间窗 ${index + 1}`}
                                onChange={(value) => {
                                  const windows = [...(schedule.windows ?? [])];
                                  windows[index] = value;
                                  void setTaskSchedule(task, { ...schedule, windows, time: windows[windows.length - 1] ?? schedule.time });
                                }}
                              />
                            ))
                          ) : (
                            <TimeSelect
                              value={schedule.time}
                              disabled={busy}
                              ariaLabel={`${def.label}时间`}
                              onChange={(value) => void setTaskSchedule(task, { ...schedule, time: value })}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="flex flex-col gap-3 rounded-xl border border-[#d9e5db] bg-[#f7fbf7] p-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#304936]"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#dcecdf] text-xs text-[#52705f]">2</span>新建定时任务的结果</div>
                </div>
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-[#dce7dd] bg-white px-3 py-3">
                  <span className="text-xs font-medium text-[#303632]">默认将结果摘要发送到微信</span>
                  <input
                    type="checkbox"
                    className="h-4 w-8 shrink-0 accent-[#52705f]"
                    checked={preferences.defaultDeliveryMode === "wechat"}
                    disabled={saving}
                    onChange={(event) => void save({ defaultDeliveryMode: event.target.checked ? "wechat" : "none" })}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-[#e5e1d5] bg-[#fcfaf5] p-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#554c35]"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#efe7cd] text-xs text-[#8a7645]">3</span>异常提醒</div>
                </div>
                {NOTIFICATION_CATEGORIES.map((category) => {
                  const enabled = category.value === "failure"
                    ? preferences.wechatFailureEnabled && (preferences.categories === null || preferences.categories.includes(category.value))
                    : preferences.wechatRecoveryEnabled && (preferences.categories === null || preferences.categories.includes(category.value));
                  return (
                    <label key={category.value} className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-[#ebe7db] bg-white px-3 py-3">
                      <span className="text-xs"><span className="block font-medium text-[#303632]">{category.label}</span><span className="mt-1 block text-[#7a827c]">{category.description}</span></span>
                      <input
                        type="checkbox"
                        className="h-4 w-8 shrink-0 accent-[#52705f]"
                        checked={enabled}
                        disabled={saving}
                        onChange={(event) => {
                          const current = preferences.categories ?? NOTIFICATION_CATEGORIES.map((item) => item.value);
                          const next = event.target.checked
                            ? Array.from(new Set([...current, category.value]))
                            : current.filter((value) => value !== category.value);
                          void save({
                            categories: next,
                            ...(category.value === "failure" ? { wechatFailureEnabled: event.target.checked } : { wechatRecoveryEnabled: event.target.checked }),
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
              <div className="flex flex-col gap-3 rounded-xl border border-[#dce3ed] bg-[#f7f9fc] p-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[#354761]"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#dfe8f5] text-xs text-[#55749e]">4</span>免打扰时段</div>
                </div>
                {/* 2026-10-09：自由文本改下拉——用户不知道格式，服务端也可能收到
                    非法值；半小时粒度选项 + 「不开启」空选项覆盖原语义（留空=关闭）。 */}
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <TimeSelect
                    value={preferences.quietHoursStart}
                    emptyLabel="不开启"
                    disabled={saving}
                    ariaLabel="免打扰开始时间"
                    onChange={(value) => { if (value !== (preferences.quietHoursStart ?? "")) void save({ quietHoursStart: value === "" ? null : value }); }}
                  />
                  <span className="text-xs text-[#7a827c]">至</span>
                  <TimeSelect
                    value={preferences.quietHoursEnd}
                    emptyLabel="不开启"
                    disabled={saving}
                    ariaLabel="免打扰结束时间"
                    onChange={(value) => { if (value !== (preferences.quietHoursEnd ?? "")) void save({ quietHoursEnd: value === "" ? null : value }); }}
                  />
                </div>
              </div>
            </section>
          )}
          <section className="flex max-w-2xl flex-col gap-3 rounded-lg border border-[#dfe3df] bg-white p-5">
            <div>
              <h2 className="text-sm font-semibold">微信绑定</h2>
              <p className="mt-1 text-xs text-[#7a827c]">绑定后，复盘与盯盘推送直接发到你的微信</p>
            </div>
            <WechatBindingPanel />
          </section>
        </main>
      </div>
    </div>
  );
}
