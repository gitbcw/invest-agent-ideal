import { randomUUID } from "node:crypto";

import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";
import {
  getNotificationPreferences,
  markAttentionWechatNotified,
  recordAutomationFailureAttention,
  resolveAutomationAttention,
} from "./attention-items.js";
import { enqueuePushJob } from "./push-queue.js";

/**
 * T-479 自动化失败/恢复通知。契约见 docs/automation-failure-notify-design.md：
 * scheduled run 失败终态首条通知（consecutive_failures=1）、失败消除后恢复通知
 * （最新通知 job 为 failure）；manual 不通知；模板正文不跑模型；查询式决策，
 * 可安全重复调用（幂等键含 runId）。
 *
 * T-539 调整（设计 §7）：attention_items 是失败告知的服务拥有事实——无论微信
 * 偏好如何都写入并自动恢复；微信只是同一事项的提醒投影，受通知偏好 gate
 * （失败提醒可关、恢复默认静默）。偏好不改变任务终态/失败事实/重试语义。
 */

const FAILURE_VALIDITY_MS = 2 * 60 * 60 * 1000;
export const AUTOMATION_FAILURE_MESSAGE_KIND = "automation_failure";
export const AUTOMATION_RECOVERY_MESSAGE_KIND = "automation_recovery";

const CATEGORY_LABELS: Record<string, string> = {
  timeout: "执行超时",
  expired: "运行超时被系统回收",
  invalid_input: "结果校验未通过",
  validation_failed: "结果校验未通过",
  dependency_unavailable: "依赖服务暂不可用",
  scope_or_permission: "权限不足",
  transient: "瞬时错误",
};

function categoryLabel(category: string | null | undefined): string {
  return (category && CATEGORY_LABELS[category]) || "未分类错误";
}

/** taskId 主体段 + 尾部短码，如 `market-watch·88b950f3`；不读 revision 正文。 */
function taskLabel(taskId: string): string {
  const tail = taskId.slice(-8);
  const body = taskId.slice(0, Math.max(0, taskId.length - 8)).replace(/_+$/, "");
  return body ? `${body}·${tail}` : tail;
}

function beijingHm(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return "—";
  }
}

function quietHoursEndAt(now: Date, start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const parse = (value: string) => {
    const match = /^(\d{2}):(\d{2})$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const startMinutes = parse(start);
  const endMinutes = parse(end);
  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) return null;

  const beijingNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const currentMinutes = beijingNow.getUTCHours() * 60 + beijingNow.getUTCMinutes();
  const active = startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
  if (!active) return null;

  const target = new Date(Date.UTC(
    beijingNow.getUTCFullYear(), beijingNow.getUTCMonth(), beijingNow.getUTCDate(),
    Math.floor(endMinutes / 60), endMinutes % 60, 0, 0,
  ));
  if (endMinutes <= currentMinutes && startMinutes >= endMinutes) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

function categoryEnabled(categories: string[] | null, category: "failure" | "recovery"): boolean {
  return !categories || categories.length === 0 || categories.includes(category);
}

interface NotifyRunRow {
  runId: string;
  taskId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  origin: string;
  status: string;
  errorCategory: string | null;
  scheduledFor: string | null;
  finishedAt: string | null;
}

function insertNotifyAuditRow(input: {
  taskId: string;
  runId: string;
  scope: { userId: string; projectId: string; instanceId: string };
  action: "run.failure_notified" | "run.recovery_notified";
  details: Record<string, unknown>;
  createdAt: string;
}): void {
  sqlite.prepare(`
    INSERT INTO automation_task_audit_logs (
      audit_id, task_id, revision_id, run_id, asset_id, user_id, project_id, instance_id,
      action, status, details_json, created_at
    ) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, 'sent', ?, ?)
  `).run(
    `ataudit_${randomUUID()}`,
    input.taskId,
    input.runId,
    input.scope.userId,
    input.scope.projectId,
    input.scope.instanceId,
    input.action,
    JSON.stringify(input.details),
    input.createdAt,
  );
}

/** 该 task 最新一条失败/恢复通知 job 的 message_kind（无则 null）。 */
function latestNotifyKind(taskId: string): string | null {
  const row = sqlite.prepare(`
    SELECT message_kind FROM push_jobs
    WHERE (idempotency_key LIKE ? OR idempotency_key LIKE ?)
      AND message_kind IN (?, ?)
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(
    `automation:${taskId}:failure:%`,
    `automation:${taskId}:recovery:%`,
    AUTOMATION_FAILURE_MESSAGE_KIND,
    AUTOMATION_RECOVERY_MESSAGE_KIND,
  ) as { message_kind: string } | undefined;
  return row?.message_kind ?? null;
}

export interface AutomationNotifyResult {
  notified: "failure" | "recovery" | null;
  reason: string;
}

/**
 * run 终态落库后调用（事务外）。决策纯查询：失败首条 = failed ∧ scheduled ∧
 * consecutive_failures=1；恢复 = succeeded ∧ scheduled ∧ 最新通知 job 为 failure。
 * enqueuePushJob 按 idempotency_key 幂等，重复调用不产生新 job。
 */
export async function notifyAutomationRunTerminal(input: {
  scope: { userId: string; projectId: string; instanceId: string };
  taskId: string;
  runId: string;
}): Promise<AutomationNotifyResult> {
  const run = sqlite.prepare(`
    SELECT run_id AS runId, task_id AS taskId, user_id AS userId, project_id AS projectId,
           instance_id AS instanceId, origin, status, error_category AS errorCategory,
           scheduled_for AS scheduledFor, finished_at AS finishedAt
    FROM automation_task_runs
    WHERE run_id = ? AND task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(
    input.runId, input.taskId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
  ) as NotifyRunRow | undefined;
  if (!run) return { notified: null, reason: "run_not_found" };
  // run 行携带任务归属 scope，以其为准（与 summary 推送同源）。
  const scope = { userId: run.userId, projectId: run.projectId, instanceId: run.instanceId };
  if (run.origin !== "scheduled") return { notified: null, reason: `origin_${run.origin}` };

  if (run.status === "failed") {
    const task = sqlite.prepare(`
      SELECT consecutive_failures FROM automation_tasks
      WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
    `).get(input.taskId, scope.userId, scope.projectId, scope.instanceId) as { consecutive_failures: number } | undefined;
    const failures = Number(task?.consecutive_failures ?? 0);
    if (failures !== 1) {
      // 连败非首条：不重复发微信，但去重更新既有 open 事项的计数与系统状态。
      if (failures > 1) recordAutomationFailureAttention({ scope, taskId: input.taskId, runId: run.runId, errorCategory: run.errorCategory });
      return { notified: null, reason: `consecutive_failures_${failures}` };
    }
    // 失败告知事实：无论微信偏好如何都写入（网页完整告知的事实源）。
    recordAutomationFailureAttention({ scope, taskId: input.taskId, runId: run.runId, errorCategory: run.errorCategory });
    const preferences = getNotificationPreferences(scope);
    if (!preferences.wechatFailureEnabled || !categoryEnabled(preferences.categories, "failure")) {
      insertNotifyAuditRow({
        taskId: input.taskId,
        runId: run.runId,
        scope,
        action: "run.failure_notified",
        details: {
          errorCategory: run.errorCategory,
          skippedByPreference: true,
          reason: preferences.wechatFailureEnabled ? "failure_category_disabled" : "wechat_failure_disabled",
        },
        createdAt: new Date().toISOString(),
      });
      return { notified: null, reason: "failure_wechat_suppressed_by_preference" };
    }
    const idempotencyKey = `automation:${input.taskId}:failure:${run.runId}`;
    const message = [
      `【定时任务失败】任务 ${taskLabel(input.taskId)}（计划 ${beijingHm(run.scheduledFor)}）本次执行失败：${categoryLabel(run.errorCategory)}。`,
      "系统将按原计划在下个周期自动重试；若连续 3 次失败，任务会自动暂停并需要人工处理。详情见网页端「待处理」。",
    ].join("");
    const job = await enqueuePushJob({
      userId: scope.userId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      source: "automation",
      messageKind: AUTOMATION_FAILURE_MESSAGE_KIND,
      idempotencyKey,
      originTaskKey: input.taskId,
      expiresAt: new Date(Date.now() + FAILURE_VALIDITY_MS).toISOString(),
      nextRetryAt: quietHoursEndAt(new Date(), preferences.quietHoursStart, preferences.quietHoursEnd) ?? undefined,
      message,
    });
    markAttentionWechatNotified(scope, input.taskId);
    insertNotifyAuditRow({
      taskId: input.taskId,
      runId: run.runId,
      scope,
      action: "run.failure_notified",
      details: {
        errorCategory: run.errorCategory,
        pushJobId: job.id,
        idempotencyKey,
      },
      createdAt: new Date().toISOString(),
    });
    return { notified: "failure", reason: "first_failure" };
  }

  if (run.status === "succeeded") {
    // 成功终态：自动恢复 open 事项（网页告知反映恢复；默认不推送成功消息）。
    const resolved = resolveAutomationAttention({ scope, taskId: input.taskId, runId: run.runId });
    if (latestNotifyKind(input.taskId) !== AUTOMATION_FAILURE_MESSAGE_KIND) {
      return { notified: null, reason: resolved ? "attention_resolved" : "no_open_failure_notice" };
    }
    const preferences = getNotificationPreferences(scope);
    if (!preferences.wechatRecoveryEnabled || !categoryEnabled(preferences.categories, "recovery")) {
      // T-539（设计 §7.2）：成功与自动恢复默认不打扰；代码路径保留，偏好可开启。
      insertNotifyAuditRow({
        taskId: input.taskId,
        runId: run.runId,
        scope,
        action: "run.recovery_notified",
        details: {
          suppressedByPreference: true,
          reason: preferences.wechatRecoveryEnabled ? "recovery_category_disabled" : "wechat_recovery_disabled_default",
        },
        createdAt: new Date().toISOString(),
      });
      return { notified: null, reason: "recovery_wechat_suppressed_by_preference" };
    }
    const idempotencyKey = `automation:${input.taskId}:recovery:${run.runId}`;
    const message = `【任务已恢复】任务 ${taskLabel(input.taskId)} 已于 ${beijingHm(run.finishedAt)} 成功完成，此前的连续失败已消除。`;
    const job = await enqueuePushJob({
      userId: scope.userId,
      projectId: scope.projectId,
      instanceId: scope.instanceId,
      source: "automation",
      messageKind: AUTOMATION_RECOVERY_MESSAGE_KIND,
      idempotencyKey,
      originTaskKey: input.taskId,
      expiresAt: new Date(Date.now() + FAILURE_VALIDITY_MS).toISOString(),
      nextRetryAt: quietHoursEndAt(new Date(), preferences.quietHoursStart, preferences.quietHoursEnd) ?? undefined,
      message,
    });
    insertNotifyAuditRow({
      taskId: input.taskId,
      runId: run.runId,
      scope,
      action: "run.recovery_notified",
      details: {
        pushJobId: job.id,
        idempotencyKey,
      },
      createdAt: new Date().toISOString(),
    });
    return { notified: "recovery", reason: "recovered" };
  }

  return { notified: null, reason: `status_${run.status}` };
}

/** 挂点统一入口：吞异常保终态路径——通知失败不能反噬 run 收口。 */
export async function notifyAutomationRunTerminalQuietly(input: {
  scope: { userId: string; projectId: string; instanceId: string };
  taskId: string;
  runId: string;
}): Promise<void> {
  try {
    const result = await notifyAutomationRunTerminal(input);
    if (result.notified) {
      logger.info(`automation notify task=${input.taskId} run=${input.runId} kind=${result.notified}`);
    }
  } catch (error) {
    logger.warn(`automation notify skipped task=${input.taskId} run=${input.runId} error=${String(error).slice(0, 140)}`);
  }
}
