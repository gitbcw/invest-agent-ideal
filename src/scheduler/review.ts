/**
 * 复盘调度器。
 *
 * 行为:
 *   - 每分钟扫描所有 schedulable scope 的 workspace/config/schedules.yaml
 *   - 命中 daily_review / weekly_review / monthly_review 时触发对应 generate 函数,推送摘要到 IM
 *   - DEFAULT_USER_ID 无 workspace 时,回退到 settings 表的 review_push_time(默认 21:30,仅 daily)
 *   - 同一 (date, kind, userId, instanceId) 通过 scheduled_task_runs 持久化抢锁,跨进程只跑一次
 *
 * 时间判断一律走北京时间(schedules.yaml 模板默认 Asia/Shanghai)。
 */

import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { logger } from "../lib/logger.js";
import type { PushCallback } from "./index.js";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { beijingDateKey } from "../lib/schedules-loader.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runScheduledReviewTask } from "../runtime/scheduled-tasks.js";
import {
  claimScheduledTaskRun,
  finishScheduledTaskRun,
  reconcileExpiredScheduledTaskRuns,
} from "../services/scheduled-task-runs.js";
import { resolveScheduledMessageExpiry, scheduledMessageIdempotencyKey, type ScheduledMessageKind } from "../services/scheduled-message-policy.js";

const PUSH_TIME_KEY = "review_push_time";
const DEFAULT_HOUR = 21;
const DEFAULT_MINUTE = 30;
const REVIEW_FINAL_LEASE_MS = 25 * 60 * 1000;

type ReviewKind = "daily" | "weekly" | "monthly";

let reviewIntervalId: ReturnType<typeof setInterval> | null = null;
let lastScheduledTaskReconcileAt = 0;

export interface ReviewScope {
  userId: string;
  instanceId: string;
  projectId?: string;
}

/** 从 settings 表读取 DEFAULT_USER_ID 的兜底日复盘时间(workspace 不存在时使用)。 */
export async function getReviewPushTime(): Promise<{ hour: number; minute: number }> {
  const rows = await db.select().from(settings).where(eq(settings.key, PUSH_TIME_KEY)).limit(1);
  if (rows.length > 0) {
    const parts = rows[0].value.split(":");
    const hour = Number(parts[0]);
    const minute = Number(parts[1] ?? 0);
    if (Number.isFinite(hour) && Number.isFinite(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute };
    }
  }
  return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
}

function hasWorkspace(userId: string): boolean {
  if (ACTIVE_BACKEND === "mastra") return true;
  return existsSync(join(resolveWorkspacePath(userId), "AGENTS.md"));
}

async function hasExistingDailyReview(scope: ReviewScope, dateKey: string): Promise<boolean> {
  const row = await dailyPlanBackend.get(scope.userId, scope.instanceId, dateKey).catch(() => null);
  return Boolean(row);
}

async function shouldSkipFallbackDailyGeneration(kind: ReviewKind, scope: ReviewScope, dateKey: string, manualReason?: string) {
  if (kind !== "daily" || manualReason) return false;
  if (!hasWorkspace(scope.userId)) return false;
  return hasExistingDailyReview(scope, dateKey);
}

async function getScheduledPreparedDailyReview(scope: ReviewScope, dateKey: string): Promise<string | null> {
  const row = await dailyPlanBackend.get(scope.userId, scope.instanceId, dateKey).catch(() => null);
  if (!row?.content) return null;
  const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
  const context = data.context && typeof data.context === "object" ? data.context as Record<string, unknown> : {};
  return context.source === "scheduled-review" ? row.content : null;
}

async function readReusableReviewText(scope: ReviewScope, kind: ReviewKind, dateKey: string): Promise<string | null> {
  return kind === "daily" ? getScheduledPreparedDailyReview(scope, dateKey) : null;
}

async function resolveReviewText(
  kind: ReviewKind,
  scope: ReviewScope,
  dateKey: string,
  manualReason?: string,
  overrides: {
    readText?: () => Promise<string | null>;
    waitForPrepare?: () => Promise<string | null>;
    shouldSkipFallback?: () => Promise<boolean>;
    generate?: () => Promise<string | null>;
  } = {},
  runId?: string,
) {
  const readText = overrides.readText ?? (() => readReusableReviewText(scope, kind, dateKey));
  let text = await readText();
  if (!text) {
    const shouldSkip = await (overrides.shouldSkipFallback
      ?? (() => shouldSkipFallbackDailyGeneration(kind, scope, dateKey, manualReason)))();
    if (!shouldSkip) {
      text = await (overrides.generate
        ?? (() => runScheduledReviewTask(
          { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId },
          kind,
          { runId },
        )))();
    }
  }
  return text;
}

export async function triggerReviewNow(
  kind: ReviewKind,
  scope: ReviewScope,
  pushFn: PushCallback,
  now = new Date(),
  options: { manualReason?: string } = {},
): Promise<{ taskKey: string; skipped: boolean; pushJobId?: string }> {
  const dateKey = beijingDateKey(now);
  const projectId = scope.projectId ?? DEFAULT_PROJECT_ID;
  const reasonSuffix = options.manualReason ? `:${options.manualReason}` : "";
  const taskKey = `${dateKey}:${kind}-review:${scope.userId}:${scope.instanceId}${reasonSuffix}`;
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: `${kind}-review`,
    scheduledFor: dateKey,
    userId: scope.userId,
    projectId,
    instanceId: scope.instanceId,
    leaseMs: REVIEW_FINAL_LEASE_MS,
  });
  if (!claimed) {
    logger.info(`跳过 ${kind} 复盘 user=${scope.userId} instance=${scope.instanceId}: task 已被其他进程领取`);
    return { taskKey, skipped: true };
  }

  try {
    const text = await resolveReviewText(kind, { ...scope, projectId }, dateKey, options.manualReason, {}, taskKey);
    if (!text) {
      await finishScheduledTaskRun(taskKey, { status: "skipped" });
      return { taskKey, skipped: true };
    }
    const messageKind = `${kind}_review` as ScheduledMessageKind;
    const delivery = resolveScheduledMessageExpiry(messageKind, now);
    const pushResult = text
      ? await pushFn(text, {
        userId: scope.userId,
        projectId,
        instanceId: scope.instanceId,
        messageKind,
        expiresAt: delivery.expiresAt,
        originTaskKey: taskKey,
        retryPolicy: delivery.retryPolicy,
        idempotencyKey: scheduledMessageIdempotencyKey({
          instanceId: scope.instanceId,
          userId: scope.userId,
          kind: messageKind,
          businessPeriod: dateKey,
        }),
        maxAttempts: delivery.maxAttempts,
      })
      : undefined;
    const pushJobId = typeof pushResult === "string" ? pushResult : undefined;
    await finishScheduledTaskRun(taskKey, { status: "success", pushJobId });
    return { taskKey, skipped: false, pushJobId };
  } catch (error) {
    logger.error(`复盘触发失败 kind=${kind} user=${scope.userId} instance=${scope.instanceId}: ${error}`);
    await finishScheduledTaskRun(taskKey, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * P4b (E4): scheduled reviews fire exclusively as typed automation tasks
 * driven by the automation scheduler. The preference-driven minute loop is
 * retired; this entry keeps the reconcile heartbeat (expired scheduled-task
 * run cleanup).
 */
export async function startReviewScheduler(
  _pushFn: PushCallback,
  _getScopes?: () => Promise<ReviewScope[]>,
) {
  stopReviewScheduler();

  reviewIntervalId = setInterval(async () => {
    const now = new Date();
    try {
      if (now.getTime() - lastScheduledTaskReconcileAt >= 60_000) {
        lastScheduledTaskReconcileAt = now.getTime();
        await reconcileExpiredScheduledTaskRuns(now);
      }
    } catch (error) {
      logger.error(`复盘调度 reconcile 失败: ${error}`);
    }
  }, 60 * 1000);

  logger.info(`复盘偏好调度已退役（P4b）：复盘/预生成由 typed 自动化任务驱动；本循环仅保留 scheduled_task_runs reconcile`);
}

export function stopReviewScheduler() {
  if (reviewIntervalId !== null) {
    clearInterval(reviewIntervalId);
    reviewIntervalId = null;
  }
}

export const __test__ = {
  resolveReviewText,
};
