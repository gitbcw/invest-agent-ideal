/**
 * 复盘调度器。
 *
 * 行为:
 *   - 每分钟扫描所有 schedulable user 的 workspace/config/schedules.yaml
 *   - 命中 daily_review / weekly_review / monthly_review 时触发对应 generate 函数,推送摘要到 IM
 *   - DEFAULT_USER_ID 无 workspace 时,回退到 settings 表的 review_push_time(默认 21:30,仅 daily)
 *   - 同一 (date, kind, userId) 只跑一次(进程内 Set 去重)
 *
 * 时间判断一律走北京时间(schedules.yaml 模板默认 Asia/Shanghai)。
 */

import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { logger } from "../lib/logger.js";
import type { PushCallback } from "./index.js";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { readSchedules, entryHitsNow, beijingNow, beijingDateKey } from "../lib/schedules-loader.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runScheduledReviewTask } from "../acp/scheduled-tasks.js";

const PUSH_TIME_KEY = "review_push_time";
const DEFAULT_HOUR = 21;
const DEFAULT_MINUTE = 30;

type ReviewKind = "daily" | "weekly" | "monthly";

const firedKeys = new Set<string>();

let fallbackHour = DEFAULT_HOUR;
let fallbackMinute = DEFAULT_MINUTE;

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

async function hasExistingDailyReview(userId: string, dateKey: string): Promise<boolean> {
  const row = await dailyPlanBackend.get(userId, DEFAULT_INSTANCE_ID, dateKey).catch(() => null);
  return Boolean(row);
}

async function shouldFire(kind: ReviewKind, userId: string, now: Date): Promise<boolean> {
  if (kind === "daily" && !isAfterDailyReviewScanStart(now)) return false;
  const dateKey = beijingDateKey(now);
  const dedupeKey = `${dateKey}:${kind}:${userId}`;
  if (firedKeys.has(dedupeKey)) return false;

  let hit = false;
  if (hasWorkspace(userId)) {
    const schedules = readSchedules(userId);
    if (kind === "daily") hit = entryHitsNow(schedules.daily_review, now);
    else if (kind === "weekly") hit = entryHitsNow(schedules.weekly_review, now);
    else if (kind === "monthly") hit = entryHitsNow(schedules.monthly_review, now);
    if (hit && kind === "daily" && schedules.run_policy?.skip_automatic_if_manual_report_exists !== false) {
      if (await hasExistingDailyReview(userId, dateKey)) {
        logger.info(`跳过自动日复盘 user=${userId} date=${dateKey}: 当日已有复盘记录`);
        hit = false;
      }
    }
  } else if (userId === DEFAULT_USER_ID && kind === "daily") {
    const clock = beijingNow(now);
    hit = clock.getHours() === fallbackHour && clock.getMinutes() === fallbackMinute;
  }

  if (hit) {
    firedKeys.add(dedupeKey);
    return true;
  }
  return false;
}

async function fire(kind: ReviewKind, userId: string, pushFn: PushCallback): Promise<void> {
  try {
    const instanceId = defaultInstanceIdForUser(userId);
    const text = await runScheduledReviewTask({ userId, instanceId }, kind);
    if (text) await pushFn(text, { userId, instanceId });
  } catch (error) {
    logger.error(`复盘触发失败 kind=${kind} user=${userId}: ${error}`);
  }
}

function isAfterDailyReviewScanStart(now: Date): boolean {
  const bj = beijingNow(now);
  const timeNum = bj.getHours() * 100 + bj.getMinutes();
  return timeNum >= 1500;
}

/**
 * 启动调度器。每分钟检查所有 schedulable user。
 */
export async function startReviewScheduler(
  pushFn: PushCallback,
  getUserIds: () => Promise<string[]> = async () => [DEFAULT_USER_ID],
) {
  const { hour: initHour, minute: initMinute } = await getReviewPushTime();
  fallbackHour = initHour;
  fallbackMinute = initMinute;

  setInterval(async () => {
    const now = new Date();
    try {
      const userIds = await getUserIds();
      for (const userId of userIds) {
        for (const kind of ["daily", "weekly", "monthly"] as ReviewKind[]) {
          if (await shouldFire(kind, userId, now)) {
            logger.info(`触发 ${kind} 复盘 user=${userId}`);
            await fire(kind, userId, pushFn);
          }
        }
      }
    } catch (error) {
      logger.error(`复盘调度循环失败: ${error}`);
    }
  }, 60 * 1000);

  // 进程内 dedupe 集合按天清理,避免长期增长
  setInterval(() => {
    const todayKey = beijingNow().toISOString().slice(0, 10);
    for (const key of firedKeys) {
      if (!key.startsWith(todayKey)) firedKeys.delete(key);
    }
  }, 60 * 60 * 1000);

  logger.info(`复盘调度器已启动(workspace schedules.yaml + DEFAULT 用户兜底 ${fallbackHour}:${String(fallbackMinute).padStart(2, "0")})`);
}
