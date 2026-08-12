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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runScheduledReviewTask } from "../runtime/scheduled-tasks.js";
import {
  claimScheduledTaskRun,
  finishScheduledTaskRun,
  getScheduledTaskRunState,
  reconcileExpiredScheduledTaskRuns,
  type ScheduledTaskRunState,
} from "../services/scheduled-task-runs.js";
import { formatUnknownError } from "../lib/errors.js";
import { resolveScheduledMessageExpiry, scheduledMessageIdempotencyKey, type ScheduledMessageKind } from "../services/scheduled-message-policy.js";

const PUSH_TIME_KEY = "review_push_time";
const DEFAULT_HOUR = 21;
const DEFAULT_MINUTE = 30;
const REVIEW_PREPARE_LEAD_MINUTES = normalizePositiveInteger(process.env.REVIEW_PREPARE_LEAD_MINUTES, 12);
const REVIEW_PREPARE_LEASE_MS = 15 * 60 * 1000;
const REVIEW_FINAL_LEASE_MS = 25 * 60 * 1000;
const REVIEW_HANDOFF_POLL_MS = 1_000;
const REVIEW_HANDOFF_SETTLE_BUFFER_MS = 5_000;

type ReviewKind = "daily" | "weekly" | "monthly";

let reviewIntervalId: ReturnType<typeof setInterval> | null = null;
let lastScheduledTaskReconcileAt = 0;

let fallbackHour = DEFAULT_HOUR;
let fallbackMinute = DEFAULT_MINUTE;

export interface ReviewScope {
  userId: string;
  instanceId: string;
  projectId?: string;
}

interface PreparedReviewPush {
  kind: ReviewKind;
  userId: string;
  instanceId: string;
  projectId: string;
  dateKey: string;
  text: string;
  preparedAt: string;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
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

async function shouldFire(kind: ReviewKind, scope: ReviewScope, now: Date, options: { skipExistingDailyReview?: boolean } = {}): Promise<boolean> {
  if (kind === "daily" && !isAfterDailyReviewScanStart(now)) return false;
  const dateKey = beijingDateKey(now);

  let hit = false;
  if (hasWorkspace(scope.userId)) {
    const schedules = readSchedules(scope.userId);
    if (kind === "daily") hit = entryHitsNow(schedules.daily_review, now);
    else if (kind === "weekly") hit = entryHitsNow(schedules.weekly_review, now);
    else if (kind === "monthly") hit = entryHitsNow(schedules.monthly_review, now);
    if (hit && options.skipExistingDailyReview !== false && kind === "daily" && schedules.run_policy?.skip_automatic_if_manual_report_exists !== false) {
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

async function shouldPrepare(kind: ReviewKind, scope: ReviewScope, now: Date): Promise<{ dateKey: string } | null> {
  if (!hasWorkspace(scope.userId)) return null;
  const prepareFor = addMinutes(now, REVIEW_PREPARE_LEAD_MINUTES);
  if (!(await shouldFire(kind, scope, prepareFor, { skipExistingDailyReview: true }))) return null;
  return { dateKey: beijingDateKey(prepareFor) };
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function preparedReviewPath(scope: ReviewScope, kind: ReviewKind, dateKey: string) {
  const safeInstance = (scope.instanceId || DEFAULT_INSTANCE_ID).replace(/[^a-zA-Z0-9_-]/g, "-");
  return join(resolveWorkspacePath(scope.userId), ".state", "scheduled-reviews", safeInstance, `${dateKey}-${kind}.json`);
}

async function readPreparedReviewPush(scope: ReviewScope, kind: ReviewKind, dateKey: string): Promise<PreparedReviewPush | null> {
  try {
    const file = preparedReviewPath(scope, kind, dateKey);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<PreparedReviewPush>;
    if (parsed.kind !== kind || parsed.dateKey !== dateKey || typeof parsed.text !== "string" || !parsed.text.trim()) return null;
    return {
      kind,
      userId: String(parsed.userId || scope.userId),
      instanceId: String(parsed.instanceId || scope.instanceId || DEFAULT_INSTANCE_ID),
      projectId: String(parsed.projectId || scope.projectId || DEFAULT_PROJECT_ID),
      dateKey,
      text: parsed.text,
      preparedAt: String(parsed.preparedAt || ""),
    };
  } catch (error) {
    logger.warn(`读取预生成复盘失败 kind=${kind} user=${scope.userId}: ${(error as Error).message}`);
    return null;
  }
}

async function writePreparedReviewPush(scope: ReviewScope, kind: ReviewKind, dateKey: string, text: string) {
  const file = preparedReviewPath(scope, kind, dateKey);
  await mkdir(dirname(file), { recursive: true });
  const payload: PreparedReviewPush = {
    kind,
    userId: scope.userId,
    instanceId: scope.instanceId,
    projectId: scope.projectId ?? DEFAULT_PROJECT_ID,
    dateKey,
    text,
    preparedAt: new Date().toISOString(),
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf-8");
}

async function shouldSkipFallbackDailyGeneration(kind: ReviewKind, scope: ReviewScope, dateKey: string, manualReason?: string) {
  if (kind !== "daily" || manualReason) return false;
  if (!hasWorkspace(scope.userId)) return false;
  const schedules = readSchedules(scope.userId);
  if (schedules.run_policy?.skip_automatic_if_manual_report_exists === false) return false;
  return hasExistingDailyReview(scope, dateKey);
}

async function getScheduledPreparedDailyReview(scope: ReviewScope, dateKey: string): Promise<string | null> {
  const row = await dailyPlanBackend.get(scope.userId, scope.instanceId, dateKey).catch(() => null);
  if (!row?.content) return null;
  const data = row.data && typeof row.data === "object" ? row.data as Record<string, unknown> : {};
  const context = data.context && typeof data.context === "object" ? data.context as Record<string, unknown> : {};
  return context.source === "scheduled-acp" ? row.content : null;
}

function reviewPrepareTaskKey(kind: ReviewKind, scope: ReviewScope, dateKey: string) {
  return `${dateKey}:${kind}-review-prepare:${scope.userId}:${scope.instanceId}`;
}

async function readReusableReviewText(scope: ReviewScope, kind: ReviewKind, dateKey: string): Promise<string | null> {
  const prepared = await readPreparedReviewPush(scope, kind, dateKey);
  if (prepared?.text) return prepared.text;
  return kind === "daily" ? getScheduledPreparedDailyReview(scope, dateKey) : null;
}

interface ReviewPrepareHandoffDependencies {
  getState: (taskKey: string) => Promise<ScheduledTaskRunState | null>;
  readText: () => Promise<string | null>;
  reconcile: (now: Date) => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

function prepareLeaseDeadline(state: ScheduledTaskRunState): number {
  const explicit = state.leaseExpiresAt ? Date.parse(state.leaseExpiresAt) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  const claimedAt = Date.parse(state.claimedAt);
  return Number.isFinite(claimedAt) ? claimedAt + REVIEW_PREPARE_LEASE_MS : Number.NaN;
}

async function waitForPreparedReview(
  kind: ReviewKind,
  scope: ReviewScope,
  dateKey: string,
  overrides: Partial<ReviewPrepareHandoffDependencies> = {},
): Promise<string | null> {
  const taskKey = reviewPrepareTaskKey(kind, scope, dateKey);
  const deps: ReviewPrepareHandoffDependencies = {
    getState: getScheduledTaskRunState,
    readText: () => readReusableReviewText(scope, kind, dateKey),
    reconcile: reconcileExpiredScheduledTaskRuns,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    ...overrides,
  };

  let state = await deps.getState(taskKey);
  if (state?.status !== "claimed") return deps.readText();

  let nextProgressLogAt = deps.now().getTime() + 30_000;
  while (state?.status === "claimed") {
    const text = await deps.readText();
    if (text) return text;

    const now = deps.now();
    const deadline = prepareLeaseDeadline(state) + REVIEW_HANDOFF_SETTLE_BUFFER_MS;
    if (!Number.isFinite(deadline) || now.getTime() >= deadline) {
      await deps.reconcile(now);
      return deps.readText();
    }
    if (now.getTime() >= nextProgressLogAt) {
      logger.info(`等待复盘预生成交接 kind=${kind} user=${scope.userId} instance=${scope.instanceId} date=${dateKey} prepareTask=${taskKey}`);
      nextProgressLogAt = now.getTime() + 30_000;
    }
    await deps.sleep(Math.min(REVIEW_HANDOFF_POLL_MS, deadline - now.getTime()));
    state = await deps.getState(taskKey);
  }

  return deps.readText();
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
) {
  const readText = overrides.readText ?? (() => readReusableReviewText(scope, kind, dateKey));
  let text = await readText();
  if (!text && !manualReason) {
    text = await (overrides.waitForPrepare ?? (() => waitForPreparedReview(kind, scope, dateKey)))();
  }
  if (!text) {
    const shouldSkip = await (overrides.shouldSkipFallback
      ?? (() => shouldSkipFallbackDailyGeneration(kind, scope, dateKey, manualReason)))();
    if (!shouldSkip) {
      text = await (overrides.generate
        ?? (() => runScheduledReviewTask({ userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId }, kind)))();
    }
  }
  return text;
}

async function triggerReviewPrepareNow(
  kind: ReviewKind,
  scope: ReviewScope,
  dateKey: string,
): Promise<{ taskKey: string; skipped: boolean }> {
  const projectId = scope.projectId ?? DEFAULT_PROJECT_ID;
  const taskKey = reviewPrepareTaskKey(kind, scope, dateKey);
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: `${kind}-review-prepare`,
    scheduledFor: dateKey,
    userId: scope.userId,
    projectId,
    instanceId: scope.instanceId,
    leaseMs: REVIEW_PREPARE_LEASE_MS,
  });
  if (!claimed) {
    logger.info(`跳过 ${kind} 复盘预生成 user=${scope.userId} instance=${scope.instanceId}: task 已被其他进程领取`);
    return { taskKey, skipped: true };
  }

  try {
    const text = await runScheduledReviewTask({ userId: scope.userId, instanceId: scope.instanceId, projectId }, kind);
    if (!text) {
      await finishScheduledTaskRun(taskKey, { status: "skipped" });
      return { taskKey, skipped: true };
    }
    await writePreparedReviewPush({ ...scope, projectId }, kind, dateKey, text);
    await finishScheduledTaskRun(taskKey, { status: "success" });
    logger.info(`复盘已预生成 kind=${kind} user=${scope.userId} instance=${scope.instanceId} date=${dateKey}`);
    return { taskKey, skipped: false };
  } catch (error) {
    logger.error(`复盘预生成失败 kind=${kind} user=${scope.userId} instance=${scope.instanceId}: ${error}`);
    await finishScheduledTaskRun(taskKey, {
      status: "error",
      errorMessage: formatUnknownError(error),
    });
    throw error;
  }
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
    const text = await resolveReviewText(kind, { ...scope, projectId }, dateKey, options.manualReason);
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
      if (now.getTime() - lastScheduledTaskReconcileAt >= 60_000) {
        lastScheduledTaskReconcileAt = now.getTime();
        await reconcileExpiredScheduledTaskRuns(now);
      }
      const scopes = await getScopes();
      for (const scope of scopes) {
        for (const kind of ["daily", "weekly", "monthly"] as ReviewKind[]) {
          const prepare = await shouldPrepare(kind, scope, now);
          if (prepare) {
            logger.info(`提前预生成 ${kind} 复盘 user=${scope.userId} instance=${scope.instanceId} date=${prepare.dateKey}`);
            await triggerReviewPrepareNow(kind, scope, prepare.dateKey);
          }
          if (await shouldFire(kind, scope, now, { skipExistingDailyReview: false })) {
            logger.info(`触发 ${kind} 复盘 user=${scope.userId} instance=${scope.instanceId}`);
            await triggerReviewNow(kind, scope, pushFn, now);
          }
        }
      }
    } catch (error) {
      logger.error(`复盘调度循环失败: ${error}`);
    }
  }, 60 * 1000);

  logger.info(`复盘调度器已启动(workspace schedules.yaml + DEFAULT 用户兜底 ${fallbackHour}:${String(fallbackMinute).padStart(2, "0")}; 提前预生成 ${REVIEW_PREPARE_LEAD_MINUTES}min)`);
}

export function stopReviewScheduler() {
  if (reviewIntervalId !== null) {
    clearInterval(reviewIntervalId);
    reviewIntervalId = null;
  }
}

export const __test__ = {
  addMinutes,
  prepareLeaseDeadline,
  preparedReviewPath,
  readPreparedReviewPush,
  resolveReviewText,
  reviewPrepareTaskKey,
  shouldPrepare,
  waitForPreparedReview,
  writePreparedReviewPush,
};
