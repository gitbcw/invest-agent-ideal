"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleDot, Loader2, Wrench } from "lucide-react";

import type { TraceDetailView, WorkStepView } from "./types";

/**
 * T-199 AI 工作过程时间线。历史回看（trace.get 摘要）与实时轮内事件共用：
 * 两者都映射为 WorkStepView 列表，按到达顺序渲染。
 */

const KIND_LABEL: Record<WorkStepView["kind"], string> = {
  turn_start: "开始处理",
  first_token: "开始生成回复",
  tool_call: "调用工具",
  tool_result: "工具返回",
  model_fallback: "切换模型",
  turn_end: "处理完成"
};

function formatClock(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function StepRow({ step }: { step: WorkStepView }) {
  const isTool = step.kind === "tool_call" || step.kind === "tool_result";
  const isError = step.status === "error";
  const label = step.toolName
    ? `${KIND_LABEL[step.kind]}：${step.toolName}`
    : step.message
      ? `${KIND_LABEL[step.kind]} — ${step.message}`
      : KIND_LABEL[step.kind];
  const meta = [
    step.elapsedMs !== undefined ? formatDuration(step.elapsedMs) : "",
    step.inputChars !== undefined ? `入${step.inputChars}字` : "",
    step.outputChars !== undefined ? `出${step.outputChars}字` : ""
  ].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start gap-2 py-1 text-xs leading-5">
      <span className="mt-0.5 shrink-0">
        {isTool ? (
          <Wrench className={`h-3.5 w-3.5 ${isError ? "text-red-500" : "text-slate-400"}`} />
        ) : (
          <CircleDot className={`h-3.5 w-3.5 ${step.kind === "turn_end" ? "text-emerald-500" : "text-slate-300"}`} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`break-words ${isError ? "text-red-600" : "text-slate-600"}`}>{label}</span>
        {meta ? <span className="ml-1.5 text-slate-400">{meta}</span> : null}
        {step.errorExcerpt ? (
          <span className="mt-0.5 block truncate rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-500" title={step.errorExcerpt}>
            {step.errorExcerpt}
          </span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums text-slate-300">{formatClock(step.at)}</span>
    </li>
  );
}

const LIVE_WINDOW = 5;

export function ToolCallTimeline({
  steps,
  summary,
  live = false,
  defaultOpen = false
}: {
  steps: WorkStepView[];
  summary?: TraceDetailView | null;
  live?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || live);
  const toolCount = useMemo(() => steps.filter((step) => step.kind === "tool_call").length, [steps]);
  // 实时模式是「跟最近动作」的尾巴窗口：固定条数、无滚动条，旧事件
  // 自然滚出视野；完整链路在轮次结束后由历史回看（带滚动）承载。
  const visibleSteps = live && steps.length > LIVE_WINDOW ? steps.slice(-LIVE_WINDOW) : steps;
  const omittedCount = live ? Math.max(0, steps.length - LIVE_WINDOW) : 0;
  const headerMeta = summary
    ? [
        summary.model ?? "",
        formatDuration(summary.elapsedMs ?? undefined),
        summary.firstTokenMs != null ? `首字${formatDuration(summary.firstTokenMs)}` : "",
        summary.totalTokens != null ? `${summary.totalTokens.toLocaleString()} tokens` : "",
        summary.cost != null ? `$${summary.cost.toFixed(3)}` : ""
      ].filter(Boolean).join(" · ")
    : live
      ? `${steps.length} 个事件${toolCount ? ` · ${toolCount} 次工具` : ""}`
      : `${toolCount} 次工具`;

  return (
    <div className="mt-1 w-full">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-xs text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-600"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <span>{live ? "正在工作" : "处理过程"}</span>
        <span className="truncate text-slate-300">{headerMeta}</span>
      </button>
      {open ? (
        <div className="mt-0.5 rounded-xl border border-slate-100 bg-slate-50/60 px-2.5 py-1.5">
          {steps.length === 0 ? (
            <div className="flex items-center gap-1.5 py-1 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              等待第一个事件…
            </div>
          ) : (
            <>
              {omittedCount > 0 ? (
                <div className="px-1 pb-0.5 text-[10px] text-slate-300">已省略更早的 {omittedCount} 条</div>
              ) : null}
              <ol className={live ? "pr-1" : "max-h-72 overflow-y-auto pr-1"}>
                {visibleSteps.map((step, index) => (
                  <StepRow key={`${step.at}-${index}`} step={step} />
                ))}
              </ol>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
