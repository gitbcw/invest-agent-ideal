"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Boxes, ListChecks, Target } from "lucide-react";

/**
 * T-539 任务详情四块面板（设计 §6）：任务目标 / 依赖与产物 / 最近结果
 * （执行·产物·投递分层）/ 需要注意。只读聚合，经 connector 的
 * automation.detail 读模型渲染；跳转到方法/技能/文件的主管理入口。
 */
interface TaskDetail {
  goal: { name: string; description: string | null; frequency: string | null; deliveryMode: string | null };
  dependencies: Array<{ kind: string; refId: string; versionPolicy: string; pinnedVersionId: string | null; displayName: string | null }>;
  recentRuns: Array<{
    runId: string;
    status: string;
    origin: string;
    startedAt: string | null;
    finishedAt: string | null;
    errorCategory: string | null;
    artifacts: string[];
    deliveries: Array<{ kind: string; status: string; at: string | null }>;
  }>;
  attention: Array<{ itemId: string; title: string; impactSummary: string; systemStatus: string; lastFailedAt: string }>;
}

const FREQUENCY_LABELS: Record<string, string> = { daily: "每天", trading_days: "交易日", weekdays: "工作日", weekly: "每周" };
const USER_STATUS_LABELS: Record<string, string> = {
  needs_attention: "需要关注",
  failed: "执行失败",
  dependency_unavailable: "依赖暂时不可用",
  validation_failed: "结果校验未通过",
  timeout: "执行超时",
};

function formatTime(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

export function TaskDetailPanel({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/automations/${encodeURIComponent(taskId)}/detail`)
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; data?: TaskDetail } | null;
        if (cancelled) return;
        if (!payload || payload.ok !== true) throw new Error("任务信息加载失败");
        setDetail(payload.data ?? null);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "任务信息加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (error) return <div className="rounded-lg border border-[#dfe3df] bg-white px-4 py-2 text-xs text-[#7a827c]">{error}</div>;
  if (!detail) return null;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Target size={15} className="text-[#52705f]" />任务目标</h3>
        <p className="text-xs font-medium text-[#303632]">{detail.goal.name}</p>
        {detail.goal.description ? <p className="mt-1 text-xs text-[#5f6660]">{detail.goal.description}</p> : null}
        <p className="mt-1.5 text-[11px] text-[#7a827c]">
          {detail.goal.frequency ? `${FREQUENCY_LABELS[detail.goal.frequency] ?? detail.goal.frequency}执行` : "手动/混合调度"}
          {detail.goal.deliveryMode && detail.goal.deliveryMode !== "none" ? ` · 结果通过${detail.goal.deliveryMode === "wechat" ? "微信" : detail.goal.deliveryMode === "agent" ? "对话" : detail.goal.deliveryMode}交付` : " · 不主动交付"}
        </p>
      </section>
      <section className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Boxes size={15} className="text-[#52705f]" />依赖与产物</h3>
        {detail.dependencies.length === 0 ? (
          <p className="text-xs text-[#7a827c]">暂未登记方法、技能或资料依赖。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {detail.dependencies.map((dependency) => (
              <li key={`${dependency.kind}-${dependency.refId}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate">
                  <span className="mr-1 rounded bg-[#eceeeb] px-1 py-0.5 text-[10px] text-[#5f6660]">{dependency.kind === "method" ? "方法" : dependency.kind === "skill" ? "技能" : dependency.kind === "asset" ? "资料" : dependency.kind}</span>
                  {dependency.kind === "method" ? (
                    <a className="text-[#52705f] hover:underline" href="/workspace">{dependency.displayName || dependency.refId}</a>
                  ) : dependency.kind === "skill" ? (
                    <a className="text-[#52705f] hover:underline" href="/workspace#skills">{dependency.displayName || dependency.refId}</a>
                  ) : dependency.kind === "asset" ? (
                    <a className="text-[#52705f] hover:underline" href={`/assets?assetId=${encodeURIComponent(dependency.refId)}`}>{dependency.displayName || dependency.refId}</a>
                  ) : (
                    dependency.displayName || dependency.refId
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-[#7a827c]">{dependency.versionPolicy === "pinned" ? "已确认版本" : "随当前技能更新"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><ListChecks size={15} className="text-[#52705f]" />最近结果</h3>
        {detail.recentRuns.length === 0 ? (
          <p className="text-xs text-[#7a827c]">暂无运行记录。</p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-2 overflow-auto pr-1">
            {detail.recentRuns.map((run) => (
              <li key={run.runId} className="rounded border border-[#eceeeb] px-2.5 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className={run.status === "succeeded" ? "font-medium text-emerald-700" : run.status === "failed" ? "font-medium text-red-700" : "font-medium text-[#303632]"}>
                    {run.status === "succeeded" ? "执行成功" : run.status === "failed" ? "执行失败" : run.status}
                  </span>
                  <span className="shrink-0 text-[11px] text-[#7a827c]">{formatTime(run.finishedAt || run.startedAt)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-[#7a827c]">
                  <span>产物：{run.artifacts.length > 0 ? run.artifacts.join("、") : run.status === "succeeded" ? "本条无产物登记" : "无"}</span>
                  <span>
                    投递：{run.deliveries.length > 0 ? run.deliveries.map((delivery) => `${delivery.kind === "automation_failure" ? "失败提醒" : delivery.kind === "automation_recovery" ? "恢复提醒" : delivery.kind}${delivery.status === "sent" ? "已发" : delivery.status === "failed" ? "未送达" : delivery.status}`).join("、") : "无"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="rounded-lg border border-[#dfe3df] bg-white p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle size={15} className="text-[#52705f]" />需要注意</h3>
        {detail.attention.length === 0 ? (
          <p className="text-xs text-[#7a827c]">当前没有与该任务相关的失败事项。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {detail.attention.map((item) => (
              <li key={item.itemId} className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs">
                <p className="font-medium text-amber-900">{item.impactSummary}</p>
                <p className="mt-0.5 text-[11px] text-amber-800">{USER_STATUS_LABELS[item.systemStatus] || "需要关注"} · {formatTime(item.lastFailedAt)}</p>
                <div className="mt-1.5 flex gap-1.5">
                  <a className="rounded border border-amber-300 px-2 py-0.5 text-[11px] text-amber-900 hover:bg-amber-100" href="/attention">前往待处理</a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
