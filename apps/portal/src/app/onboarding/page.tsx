"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * O1 onboarding wizard skeleton (design doc v2).
 * Step 2 (portfolio entry) and step 3 (strategy pack) are placeholders that
 * become functional in O2/O4; step 4 applies the default usage mode for real.
 */
export default function OnboardingWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState<2 | 3 | 4>(2);
  const [portfolioText, setPortfolioText] = useState("");
  const [strategyChoice, setStrategyChoice] = useState<"skip" | "trend" | "value">("skip");
  const [completing, setCompleting] = useState(false);
  const [result, setResult] = useState<{ message: string; appliedDefault: boolean; strategyPack?: { applied: string[] } | null; portfolioDraft?: { parsed: number } | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const complete = async () => {
    setCompleting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(strategyChoice === "skip" ? {} : { strategyPackId: strategyChoice === "trend" ? "strategy-trend-following" : "strategy-value-reversion" }), ...(step === 4 && portfolioText.trim() ? {} : {}), portfolioText }) });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setResult({ message: data.data.message, appliedDefault: Boolean(data.data.appliedDefault), strategyPack: data.data.strategyPack ?? null, portfolioDraft: data.data.portfolioDraft ?? null });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCompleting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-lg">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">初始化你的投资助手</h1>
          <p className="mt-2 text-sm text-neutral-500">三步完成，约 2 分钟。之后随时可以调整。</p>
        </header>

        {step === 2 && (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 1 步 · 录入持仓（必做）</h2>
            <p className="mt-1 text-sm text-neutral-500">粘贴持仓文本（股票名称 + 6 位代码，每行一条）。截图或口述请直接在对话里发给助手，由 AI 识别后确认入库。</p>
            <textarea
              value={portfolioText}
              onChange={(event) => setPortfolioText(event.target.value)}
              rows={5}
              placeholder={"示例：\n贵州茅台 600519 成本1700\n宁德时代 300750 成本230"}
              className="mt-3 w-full rounded border p-2 text-sm"
            />
            <div className="mt-4 flex justify-between">
              <button onClick={() => setStep(3)} className="rounded border px-4 py-2 text-sm">先跳过</button>
              <button onClick={() => setStep(3)} disabled={portfolioText.trim().length === 0} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40">下一步</button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 2 步 · 选择策略（可选）</h2>
            <p className="mt-1 text-sm text-neutral-500">可以先跳过；策略包即将上线，也可之后录入你自己的策略。</p>
            <div className="mt-3 grid gap-3">
              {([["trend", "趋势跟踪包", "跟随趋势，回踩确认后加减仓"], ["value", "价值回归包", "围绕估值中枢低吸高抛"]] as const).map(([key, name, desc]) => (
                <label key={key} className={`flex cursor-pointer items-start gap-3 rounded border p-3 ${strategyChoice === key ? "border-black" : ""}`}>
                  <input type="radio" checked={strategyChoice === key} onChange={() => setStrategyChoice(key)} className="mt-1" />
                  <span><span className="text-sm font-medium">{name}</span><br /><span className="text-xs text-neutral-500">{desc}</span></span>
                </label>
              ))}
              <label className={`flex cursor-pointer items-center gap-3 rounded border p-3 ${strategyChoice === "skip" ? "border-black" : ""}`}>
                <input type="radio" checked={strategyChoice === "skip"} onChange={() => setStrategyChoice("skip")} className="mt-1" />
                <span className="text-sm">暂不选择，之后再说</span>
              </label>
            </div>
            <div className="mt-4 flex justify-between">
              <button onClick={() => setStep(2)} className="rounded border px-4 py-2 text-sm">上一步</button>
              <button onClick={() => setStep(4)} className="rounded bg-black px-4 py-2 text-sm text-white">下一步</button>
            </div>
          </section>
        )}

        {step === 4 && !result && (
          <section className="rounded border p-5">
            <h2 className="font-medium">第 3 步 · 复盘与盯盘节奏</h2>
            <p className="mt-2 text-sm text-neutral-600">默认为你启用：交易日收盘复盘 + 盘中只推例外事项。</p>
            <p className="mt-1 text-sm text-neutral-500">这是可选配置——完成后可在「自动化」页面随时调整、暂停或关闭。</p>
            {error && <p className="mt-3 rounded bg-red-50 p-2 text-sm text-red-600">{error}</p>}
            <div className="mt-4 flex justify-between">
              <button onClick={() => setStep(3)} className="rounded border px-4 py-2 text-sm">上一步</button>
              <button onClick={complete} disabled={completing} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40">{completing ? "正在应用…" : "完成初始化"}</button>
            </div>
          </section>
        )}

        {result && (
          <section className="rounded border p-5 text-center">
            <h2 className="font-medium">✓ 初始化完成</h2>
            <p className="mt-2 text-sm text-neutral-600">{result.message}</p>
            {result.strategyPack && <p className="mt-1 text-xs text-neutral-400">新增策略：{result.strategyPack.applied.join("、") || "无（已存在）"}</p>}
            {result.portfolioDraft && <p className="mt-1 text-xs text-neutral-400">持仓草案已保存 {result.portfolioDraft.parsed} 条，可在对话中确认入库</p>}
            <div className="mt-5 flex justify-center gap-3">
              <button onClick={() => router.push("/automations")} className="rounded bg-black px-4 py-2 text-sm text-white">查看我的任务</button>
              <button onClick={() => router.push("/chat")} className="rounded border px-4 py-2 text-sm">开始对话</button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
