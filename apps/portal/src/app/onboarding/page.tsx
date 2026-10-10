"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { WechatBindingPanel } from "@/components/settings/WechatBindingPanel";

/**
 * 初始化向导（2026-10-08 重设计）：风格 → 持仓 → 确认默认。
 * 每步只问一件事；全部可跳过；文案面向普通用户，不使用内部系统名称。
 * 风格落地为两层模型：默认投资框架（常驻方法论）+ 风格对应的主策略。
 */
type Style = "trend" | "value" | "balanced" | "skip";

const STYLE_CARDS: Array<{ id: Exclude<Style, "skip">; title: string; desc: string }> = [
  { id: "trend", title: "趋势跟踪", desc: "跟随强势方向：站上趋势才持有，破位就离场，不抄底" },
  { id: "value", title: "价值回归", desc: "逆向布局：低估分批买，回归就卖，基本面恶化立即走" },
  { id: "balanced", title: "均衡", desc: "两者兼顾：趋势确认才进，估值过高不追，信号冲突就观望" },
];

function TimeSelect({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) {
  const slots: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      slots.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  const current = slots.includes(value) ? value : (() => {
    const [h, m] = value.split(":").map(Number);
    const nearest = slots.reduce((best, slot) => Math.abs(toMinutes(slot) - (h * 60 + (m ?? 0))) < Math.abs(toMinutes(best) - (h * 60 + (m ?? 0))) ? slot : best, slots[0]!);
    return nearest;
  })();
  return (
    <select
      value={current}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 rounded border border-neutral-200 bg-white px-2 text-sm"
      aria-label={ariaLabel}
    >
      {slots.map((slot) => (
        <option key={slot} value={slot}>{slot}</option>
      ))}
    </select>
  );
}

function toMinutes(slot: string): number {
  const [h, m] = slot.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

export default function OnboardingWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [style, setStyle] = useState<Style>("skip");
  const [customText, setCustomText] = useState("");
  const [portfolioText, setPortfolioText] = useState("");
  const [dailyReview, setDailyReview] = useState({ enabled: true, time: "19:00" });
  const [marketWatch, setMarketWatch] = useState({ enabled: true, times: ["09:55", "11:20", "14:30"] });
  const [weeklyReview, setWeeklyReview] = useState({ enabled: true, time: "09:00" });
  const [monthlyReview, setMonthlyReview] = useState({ enabled: true, time: "09:00" });
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = async () => {
    setCompleting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          style,
          ...(customText.trim() ? { customText } : {}),
          notify: { dailyReview, marketWatch, weeklyReview, monthlyReview },
          portfolioText,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      router.replace("/chat");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setCompleting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">初始化你的投资助手</h1>
          <p className="mt-2 text-sm text-neutral-500">四步，每步都可以跳过。之后随时可以调整。</p>
        </header>

        {error ? <p className="mb-4 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p> : null}

        {step === 1 ? (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 1 步 · 你的投资风格</h2>
            <p className="mt-1 text-sm text-neutral-500">选一个方向作为起点——助手会带着它对应的规则和纪律帮你分析；细节以后随时改。</p>
            <div className="mt-4 space-y-2">
              {STYLE_CARDS.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => setStyle(card.id)}
                  className={`w-full rounded-lg border p-3 text-left transition ${style === card.id ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200 hover:border-neutral-300"}`}
                >
                  <span className="text-sm font-medium">{card.title}</span>
                  <span className="mt-1 block text-xs leading-5 text-neutral-500">{card.desc}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() => setStyle("skip")}
                className={`w-full rounded-lg border p-3 text-left text-sm transition ${style === "skip" ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200 hover:border-neutral-300"}`}
              >
                先不选，之后再说
              </button>
            </div>
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-neutral-500">更想自己说？写下你的打法（可选）</summary>
              <textarea
                value={customText}
                onChange={(event) => setCustomText(event.target.value)}
                rows={4}
                placeholder="例如：我只买消费和医药龙头，回撤 20% 分批加仓，目标年化 15%……"
                className="mt-2 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#52705f]"
              />
              <p className="mt-1 text-xs text-neutral-400">写了这里就以你的描述为准（助手会把它保存为你的主策略）。</p>
            </details>
            <div className="mt-5 flex justify-end">
              <button type="button" onClick={() => setStep(2)} className="h-10 rounded-md bg-[#365b40] px-6 text-sm font-medium text-white transition hover:bg-[#2c4c35]">
                下一步
              </button>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 2 步 · 现在持有或关注的（可跳过）</h2>
            <p className="mt-1 text-sm text-neutral-500">粘贴持仓或观察名单，每行「股票名称 + 6 位代码」。跳过也完全没关系——以后在对话里直接发给我就行。</p>
            <textarea
              value={portfolioText}
              onChange={(event) => setPortfolioText(event.target.value)}
              rows={6}
              placeholder={"贵州茅台 600519\n宁德时代 300750\n（想先观察的也可以写，加个「观察」即可）"}
              className="mt-3 w-full resize-y rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[#52705f]"
            />
            <div className="mt-5 flex justify-between">
              <button type="button" onClick={() => setStep(1)} className="h-10 rounded-md border border-neutral-200 px-5 text-sm text-neutral-600 transition hover:bg-neutral-50">
                上一步
              </button>
              <button type="button" onClick={() => setStep(3)} className="h-10 rounded-md bg-[#365b40] px-6 text-sm font-medium text-white transition hover:bg-[#2c4c35]">
                下一步
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 3 步 · 推送与提醒</h2>
            <p className="mt-1 text-sm text-neutral-500">勾选要推送的内容，时间可改。</p>
            <div className="mt-4 space-y-2">
              <label className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 transition ${dailyReview.enabled ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200"}`}>
                <input type="checkbox" checked={dailyReview.enabled} onChange={(e) => setDailyReview({ ...dailyReview, enabled: e.target.checked })} className="h-4 w-4 accent-[#365b40]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">盘后复盘推送</span>
                  <span className="block text-xs text-neutral-500">交易日收盘后推送当日复盘</span>
                </span>
                <TimeSelect value={dailyReview.time} onChange={(time) => setDailyReview({ ...dailyReview, time })} ariaLabel="盘后复盘推送时间" />
              </label>
              <div className={`rounded-lg border p-3 transition ${marketWatch.enabled ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200"}`}>
                <label className="flex items-center gap-3">
                  <input type="checkbox" checked={marketWatch.enabled} onChange={(e) => setMarketWatch({ ...marketWatch, enabled: e.target.checked })} className="h-4 w-4 accent-[#365b40]" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">盘中盯盘提醒</span>
                    <span className="block text-xs text-neutral-500">按时间点检查持仓与观察对象，有情况才提醒</span>
                  </span>
                </label>
                <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
                  {[0, 1, 2].map((i) => (
                    <TimeSelect
                      key={i}
                      value={marketWatch.times[i] ?? "14:30"}
                      onChange={(time) => {
                        const times = [...marketWatch.times];
                        times[i] = time;
                        setMarketWatch({ ...marketWatch, times });
                      }}
                      ariaLabel={`盘中检查时间点 ${i + 1}`}
                    />
                  ))}
                  <span className="text-xs text-neutral-400">检查时间点</span>
                </div>
              </div>
              <label className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 transition ${weeklyReview.enabled ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200"}`}>
                <input type="checkbox" checked={weeklyReview.enabled} onChange={(e) => setWeeklyReview({ ...weeklyReview, enabled: e.target.checked })} className="h-4 w-4 accent-[#365b40]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">周复盘推送</span>
                  <span className="block text-xs text-neutral-500">每周六推送</span>
                </span>
                <TimeSelect value={weeklyReview.time} onChange={(time) => setWeeklyReview({ ...weeklyReview, time })} ariaLabel="周复盘推送时间" />
              </label>
              <label className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 transition ${monthlyReview.enabled ? "border-[#365b40] bg-[#f4f9f5]" : "border-neutral-200"}`}>
                <input type="checkbox" checked={monthlyReview.enabled} onChange={(e) => setMonthlyReview({ ...monthlyReview, enabled: e.target.checked })} className="h-4 w-4 accent-[#365b40]" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">月复盘推送</span>
                  <span className="block text-xs text-neutral-500">每月月初推送</span>
                </span>
                <TimeSelect value={monthlyReview.time} onChange={(time) => setMonthlyReview({ ...monthlyReview, time })} ariaLabel="月复盘推送时间" />
              </label>
            </div>
            <div className="mt-5 flex justify-between">
              <button type="button" onClick={() => setStep(2)} className="h-10 rounded-md border border-neutral-200 px-5 text-sm text-neutral-600 transition hover:bg-neutral-50">
                上一步
              </button>
              <button type="button" onClick={() => setStep(4)} className="h-10 rounded-md bg-[#365b40] px-6 text-sm font-medium text-white transition hover:bg-[#2c4c35]">
                下一步
              </button>
            </div>
          </section>
        ) : null}

        {step === 4 ? (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 4 步 · 绑定微信（可选）</h2>
            <p className="mt-1 text-sm text-neutral-500">绑定后，上一步勾选的推送会直接发到你的微信。</p>
            <WechatBindingPanel compact />
            <div className="mt-5 flex justify-between">
              <button type="button" onClick={() => setStep(3)} className="h-10 rounded-md border border-neutral-200 px-5 text-sm text-neutral-600 transition hover:bg-neutral-50">
                上一步
              </button>
              <button type="button" disabled={completing} onClick={() => void complete()} className="h-10 rounded-md bg-[#365b40] px-8 text-sm font-medium text-white transition hover:bg-[#2c4c35] disabled:opacity-40">
                {completing ? "正在配置…" : "完成"}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
