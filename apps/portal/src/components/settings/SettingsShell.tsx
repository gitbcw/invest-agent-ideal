"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Settings as SettingsIcon, X } from "lucide-react";
import { PortalSidebar } from "@/components/navigation/PortalSidebar";

interface Preferences {
  wechatFailureEnabled: boolean;
  wechatRecoveryEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  categories: string[] | null;
}

/** 设置页（首版仅通知偏好）。偏好只影响提醒投递，不改变任务运行与事实。 */
export function SettingsShell() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      setNotice("已保存。偏好只影响微信提醒，网页待处理列表与任务运行不受影响。");
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
            <section className="flex max-w-2xl flex-col gap-4 rounded-lg border border-[#dfe3df] bg-white p-5">
              <div>
                <h2 className="text-sm font-semibold">微信提醒</h2>
                <p className="mt-1 text-xs text-[#7a827c]">网页「待处理」始终保留完整失败告知；微信只是提醒投影。关闭提醒不会暂停任务或改变运行事实。</p>
              </div>
              <label className="flex items-start justify-between gap-3">
                <span className="text-xs"><span className="block font-medium text-[#303632]">失败提醒</span><span className="text-[#7a827c]">自动化首次失败时发送微信提醒</span></span>
                <input
                  type="checkbox"
                  className="h-4 w-8 shrink-0 accent-[#52705f]"
                  checked={preferences.wechatFailureEnabled}
                  disabled={saving}
                  onChange={(event) => void save({ wechatFailureEnabled: event.target.checked })}
                />
              </label>
              <label className="flex items-start justify-between gap-3">
                <span className="text-xs"><span className="block font-medium text-[#303632]">恢复提醒</span><span className="text-[#7a827c]">任务自动恢复时也发送微信（默认关闭，成功与恢复不打扰）</span></span>
                <input
                  type="checkbox"
                  className="h-4 w-8 shrink-0 accent-[#52705f]"
                  checked={preferences.wechatRecoveryEnabled}
                  disabled={saving}
                  onChange={(event) => void save({ wechatRecoveryEnabled: event.target.checked })}
                />
              </label>
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs"><span className="block font-medium text-[#303632]">静默时段</span><span className="text-[#7a827c]">该时段内不发送微信提醒（首版预留，暂不强制）</span></span>
                <div className="flex shrink-0 items-center gap-1">
                  <input
                    className="input w-20 px-2 py-1 text-xs"
                    placeholder="22:00"
                    defaultValue={preferences.quietHoursStart ?? ""}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value === (preferences.quietHoursStart ?? "")) return;
                      void save({ quietHoursStart: value === "" ? null : value });
                    }}
                  />
                  <span className="text-xs text-[#7a827c]">至</span>
                  <input
                    className="input w-20 px-2 py-1 text-xs"
                    placeholder="08:00"
                    defaultValue={preferences.quietHoursEnd ?? ""}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value === (preferences.quietHoursEnd ?? "")) return;
                      void save({ quietHoursEnd: value === "" ? null : value });
                    }}
                  />
                </div>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
