"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AUTO_MODEL_VALUE, FALLBACK_MODEL_OPTIONS, type ModelOption } from "@/lib/models";

interface ModelsStateResponse {
  ok: boolean;
  data?: {
    auto: { textModel: string; imageModel: string };
    options: Array<{
      model: string;
      description: string;
      inputPrice: number | null;
    }>;
  };
}

const LABELS: Record<string, string> = {
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.5": "GPT-5.5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "doubao-seed-2-1-turbo-260628": "豆包 Seed 2.1 Turbo",
};

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<ModelsStateResponse["data"] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/models")
      .then((res) => res.json() as Promise<ModelsStateResponse>)
      .then((body) => { if (!cancelled && body.ok && body.data) setRemote(body.data); })
      .catch(() => { /* 静态兜底 */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const options = useMemo<ModelOption[]>(() => {
    if (!remote?.options?.length) return FALLBACK_MODEL_OPTIONS;
    const built = remote.options
      .filter((item) => LABELS[item.model])
      .map((item) => ({ value: item.model, label: LABELS[item.model], description: item.description, price: item.inputPrice }));
    return built.sort((a, b) => {
      const order = Object.keys(LABELS);
      return order.indexOf(a.value) - order.indexOf(b.value);
    });
  }, [remote]);

  const autoModel = remote?.auto.textModel;
  const selectedLabel = value === AUTO_MODEL_VALUE
    ? `自动${autoModel ? ` · ${LABELS[autoModel] ?? autoModel}` : "（推荐）"}`
    : LABELS[value] ?? value;
  const autoOption = options.find((opt) => opt.value === (autoModel ?? "gpt-5.6-sol"));

  return (
    <div ref={rootRef} className="relative mr-2 shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className="flex h-8 max-w-[220px] cursor-pointer items-center gap-1 rounded-md border border-black/10 bg-[#f7f7f8] px-2 text-xs text-[#5f6368] outline-none transition hover:bg-black/5 focus:border-[#7a8d83] disabled:opacity-50"
        aria-label="选择模型"
        title="选择模型（当前会话发送时生效）"
      >
        <span className="truncate font-medium">{selectedLabel}</span>
        <span className="text-[9px] text-zinc-400" aria-hidden="true">▼</span>
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-50 w-[300px] rounded-lg border border-[#e3e6e3] bg-white p-1 shadow-lg">
          <button
            type="button"
            onClick={() => { onChange(AUTO_MODEL_VALUE); setOpen(false); }}
            className={`w-full cursor-pointer rounded-md px-3 py-2 text-left transition hover:bg-[#f2f5f2] ${value === AUTO_MODEL_VALUE ? "bg-[#eef3ef]" : ""}`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-[#22301f]">自动（推荐）</span>
              {autoModel ? <span className="text-[10px] text-[#52705f]">当前 {LABELS[autoModel] ?? autoModel}</span> : null}
            </div>
            <div className="mt-0.5 text-[11px] leading-4 text-[#8a938c]">按质量优先自动选择，异常时逐级降级</div>
          </button>
          <div className="my-1 border-t border-[#eef2ee]" />
          {autoOption && value === AUTO_MODEL_VALUE ? null : null}
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full cursor-pointer rounded-md px-3 py-2 text-left transition hover:bg-[#f2f5f2] ${value === opt.value ? "bg-[#eef3ef]" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-[#22301f]">{opt.label}</span>
                <span className="shrink-0 text-[10px] text-[#8a938c]">{opt.price !== null ? `¥${opt.price}` : ""}</span>
              </div>
              <div className="mt-0.5 text-[11px] leading-4 text-[#8a938c]">{opt.description}</div>
            </button>
          ))}
          <div className="border-t border-[#eef2ee] px-3 py-1.5 text-[10px] text-[#a2aaa4]">价格为每百万 tokens 输入价（峰谷模型按峰值）</div>
        </div>
      ) : null}
    </div>
  );
}
