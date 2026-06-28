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
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { readSchedules, entryHitsNow, beijingNow, beijingDateKey } from "../lib/schedules-loader.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runScheduledReviewTask } from "../acp/scheduled-tasks.js";
import { claimScheduledTaskRun, finishScheduledTaskRun } from "../services/scheduled-task-runs.js";

const PUSH_TIME_KEY = "review_push_time";
const DEFAULT_HOUR = 21;
const DEFAULT_MINUTE = 30;

type ReviewKind = "daily" | "weekly" | "monthly";

let reviewIntervalId: ReturnType<typeof setInterval> | null = null;

let fallbackHour = DEFAULT_HOUR;
let fallbackMinute = DEFAULT_MINUTE;

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

/** 设置 DEFAULT_USER_ID 兜底日复盘时间。 */
export async function setReviewPushTime(hour: number, minute: number): Promise<string> {
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return "时间格式无效，小时 0-23，分钟 0-59";
  }
  const value = `${hour}:${String(minute).padStart(2, "0")}`;
  await db.insert(settings).values({ key: PUSH_TIME_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });

  fallbackHour = hour;
  fallbackMinute = minute;
  logger.info(`复盘推送时间已更新为 ${value}`);
  return `复盘推送时间已更新为 ${value}`;
}

function hasWorkspace(userId: string): boolean {
  return existsSync(join(resolveWorkspacePath(userId), "AGENTS.md"));
}

async function hasExistingDailyReview(scope: ReviewScope, dateKey: string): Promise<boolean> {
  const row = await dailyPlanBackend.get(scope.userId, scope.instanceId, dateKey).catch(() => null);
  return Boolean(row);
}

async function shouldFire(kind: ReviewKind, scope: ReviewScope, now: Date): Promise<boolean> {
  if (kind === "daily" && !isAfterDailyReviewScanStart(now)) return false;
  const dateKey = beijingDateKey(now);

  let hit = false;
  if (hasWorkspace(scope.userId)) {
    const schedules = readSchedules(scope.userId);
    if (kind === "daily") hit = entryHitsNow(schedules.daily_review, now);
    else if (kind === "weekly") hit = entryHitsNow(schedules.weekly_review, now);
    else if (kind === "monthly") hit = entryHitsNow(schedules.monthly_review, now);
    if (hit && kind === "daily" && schedules.run_policy?.skip_automatic_if_manual_report_exists !== false) {
      if (await hasExistingDailyReview(scope, dateKey)) {
        logger.info(`跳过自动日复盘 user=${scope.userId} instance=${scope.instanceId} date=${dateKey}: 当日已有复盘记录`);
        hit = false;
      }
    }
  } else if (scope.userId === DEFAULT_USER_ID && kind === "daily") {
    const clock = beijingNow(now);
    hit = clock.getHours() === fallbackHour && clock.getMinutes() === fallbackMinute;
  }

  return hit;
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
  });
  if (!claimed) {
    logger.info(`跳过 ${kind} 复盘 user=${scope.userId} instance=${scope.instanceId}: task 已被其他进程领取`);
    return { taskKey, skipped: true };
  }

  try {
    const text = await runScheduledReviewTask({ userId: scope.userId, instanceId: scope.instanceId, projectId }, kind);
    const pushResult = text
      ? await pushFn(text, { userId: scope.userId, projectId, instanceId: scope.instanceId })
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

function isAfterDailyReviewScanStart(now: Date): boolean {
  const bj = beijingNow(now);
  const timeNum = bj.getHours() * 100 + bj.getMinutes();
  return timeNum >= 1500;
}

/**
 * 启动调度器。每分钟检查所有 schedulable scope。
 */
export async function startReviewScheduler(
  pushFn: PushCallback,
  getScopes: () => Promise<ReviewScope[]> = async () => [
    { userId: DEFAULT_USER_ID, instanceId: DEFAULT_INSTANCE_ID, projectId: DEFAULT_PROJECT_ID },
  ],
) {
  const { hour: initHour, minute: initMinute } = await getReviewPushTime();
  fallbackHour = initHour;
  fallbackMinute = initMinute;

  stopReviewScheduler();

  reviewIntervalId = setInterval(async () => {
    const now = new Date();
    try {
      const scopes = await getScopes();
      for (const scope of scopes) {
        for (const kind of ["daily", "weekly", "monthly"] as ReviewKind[]) {
          if (await shouldFire(kind, scope, now)) {
            logger.info(`触发 ${kind} 复盘 user=${scope.userId} instance=${scope.instanceId}`);
            await triggerReviewNow(kind, scope, pushFn, now);
          }
        }
      }
    } catch (error) {
      logger.error(`复盘调度循环失败: ${error}`);
    }
  }, 60 * 1000);

  logger.info(`复盘调度器已启动(workspace schedules.yaml + DEFAULT 用户兜底 ${fallbackHour}:${String(fallbackMinute).padStart(2, "0")})`);
}

export function stopReviewScheduler() {
  if (reviewIntervalId !== null) {
    clearInterval(reviewIntervalId);
    reviewIntervalId = null;
  }
}
