"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BadgeCheck, Loader2, QrCode, RefreshCw } from "lucide-react";

interface BindingState {
  bound: boolean;
  stage: string | null;
  message: string | null;
  qrcodeDataUrl: string | null;
  accounts?: Array<{ accountId: string; listenerRunning: boolean; pushReady: boolean }>;
}

/**
 * 微信绑定面板（2026-10-09 重做）：绑定 = 扫系统生成的动态二维码
 * （任何微信可扫）——凭据落盘到实例专属通道，扫码微信即对端，扫完
 * 监听自动启动。向导第四步与设置页共用；轮询绑定状态直至 connected。
 */
export function WechatBindingPanel({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<BindingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/wechat/binding", { cache: "no-store" });
      const payload = (await res.json()) as { ok?: boolean; data?: BindingState } & BindingState;
      const body = (payload?.data ?? payload) as BindingState;
      if (res.ok && typeof body?.bound === "boolean") {
        setState(body);
        return body;
      }
      throw new Error("bad response");
    } catch {
      setError("状态查询失败，可稍后重试");
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 扫码等待中（waiting_scan）时轮询，绑定成功即停。
  useEffect(() => {
    if (state?.bound || (state?.stage && state.stage !== "waiting_scan")) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }
    if (!state?.qrcodeDataUrl) return;
    timerRef.current = setInterval(() => { void load(); }, 3000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state?.bound, state?.stage, state?.qrcodeDataUrl, load]);

  const startQr = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wechat/binding/qrcode", { method: "POST" });
      const payload = (await res.json()) as { ok?: boolean; data?: BindingState } & BindingState;
      const body = (payload?.data ?? payload) as BindingState;
      if (!res.ok || !payload?.ok) throw new Error("bad response");
      setState(body);
    } catch {
      setError("生成二维码失败，请重试");
    } finally {
      setBusy(false);
    }
  }, []);

  const unbind = useCallback(async () => {
    if (!window.confirm("解除微信绑定？此微信将不再收到推送，通道会被关闭。")) return;
    setBusy(true);
    try {
      await fetch("/api/wechat/binding", { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (state === null) {
    return <div className="flex items-center gap-2 py-6 text-sm text-neutral-500"><Loader2 size={15} className="animate-spin" /> 加载中…</div>;
  }

  if (state.bound) {
    return (
      <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-4 ${compact ? "" : "mt-2"} border-[#cfe3d4] bg-[#f4f9f5]`}>
        <div className="flex items-center gap-2">
          <BadgeCheck size={16} className="text-[#365b40]" />
          <div>
            <p className="text-sm font-medium">已绑定微信</p>
            <p className="text-xs text-neutral-500">
              {state.accounts?.length ? `${state.accounts.length} 个通道 · ${state.accounts[0]!.listenerRunning ? "监听中" : "监听未运行"}` : (state.message ?? "")}
            </p>
          </div>
        </div>
        <button type="button" onClick={() => void unbind()} disabled={busy} className="h-8 rounded-md border border-neutral-200 px-3 text-xs text-neutral-600 transition hover:bg-neutral-50">
          解除绑定
        </button>
      </div>
    );
  }

  if (state.qrcodeDataUrl) {
    return (
      <div className={`flex flex-col items-center gap-2 rounded-lg border border-dashed border-neutral-300 p-4 ${compact ? "" : "mt-2"}`}>
        {error ? <p className="text-xs text-red-600">{error}</p> : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.qrcodeDataUrl} alt="微信绑定二维码" className="h-52 w-52" />
        <p className="text-sm text-neutral-700">用你的微信扫码，即完成绑定</p>
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> 等待扫码…</span>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-neutral-500 hover:text-neutral-700">
            <RefreshCw size={11} /> 刷新状态
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-300 p-6 ${compact ? "" : "mt-2"}`}>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {state.stage === "error" && state.message ? <p className="text-xs text-neutral-500">{state.message}</p> : null}
      <button type="button" onClick={() => void startQr()} disabled={busy} className="flex h-9 items-center gap-2 rounded-md bg-[#365b40] px-5 text-sm font-medium text-white transition hover:bg-[#2c4c35] disabled:opacity-40">
        <QrCode size={15} /> {busy ? "生成中…" : "生成二维码"}
      </button>
      <p className="text-xs text-neutral-500">扫码即绑定：这个微信将成为你账号的推送与对话通道</p>
    </div>
  );
}
