import { startReviewScheduler, stopReviewScheduler, getReviewPushTime, triggerReviewNow, type ReviewScope } from "./review.js";
import { startDataQualityScheduler, stopDataQualityScheduler } from "./data-quality.js";
import { logger } from "../lib/logger.js";
import { db } from "../db/index.js";
import { aiInstances, alertRules, alerts, channelIdentities, channelIdentityInstances, settings, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { beijingDateKey, beijingNow, isBeijingTradingDay, readSchedules, type SchedulesYaml } from "../lib/schedules-loader.js";
import { runScheduledMarketWatchTask } from "../acp/scheduled-tasks.js";
import { claimScheduledTaskRun, finishScheduledTaskRun } from "../services/scheduled-task-runs.js";
import { formatUnknownError } from "../lib/errors.js";
import { formatAlerts, runAlertCheck } from "./alert-check.js";

export type PushCallback = (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => Promise<void | boolean | string>;

const INTERVAL_SETTINGS_KEY = "alert_check_interval_minutes";
const DEFAULT_INTERVAL_MINUTES = 5;

let pushFn: PushCallback | null = null;
let alertIntervalId: ReturnType<typeof setInterval> | null = null;
const marketWatchFiredKeys = new Set<string>();
const runningMarketWatchTasks = new Set<string>();
const ruleAlertFiredKeys = new Set<string>();
const runningRuleAlertTasks = new Set<string>();

interface SchedulableScope {
  userId: string;
  instanceId: string;
  projectId?: string;
}

interface ManualScheduledTriggerScope extends ReviewScope {
  projectId?: string;
}

/** 注册消息推送回调（由 server 调用） */
export function registerPush(callback: PushCallback) {
  pushFn = callback;
  logger.info("提醒推送回调已注册");
}

function getPushFn(): PushCallback {
  if (!pushFn) throw new Error("推送回调未注册");
  return pushFn;
}

function scopeKey(scope: SchedulableScope) {
  return `${scope.userId}\n${scope.instanceId}`;
}

function addScope(scopes: Map<string, SchedulableScope>, scope: SchedulableScope) {
  const userId = scope.userId.trim();
  const instanceId = scope.instanceId.trim();
  if (!userId || !instanceId) return;
  const normalized = { ...scope, userId, instanceId, projectId: scope.projectId ?? DEFAULT_PROJECT_ID };
  scopes.set(scopeKey(normalized), normalized);
}

async function getSchedulableScopes(): Promise<SchedulableScope[]> {
  const scopes = new Map<string, SchedulableScope>();
  addScope(scopes, { userId: DEFAULT_USER_ID, instanceId: DEFAULT_INSTANCE_ID, projectId: DEFAULT_PROJECT_ID });

  const [activeUsers, instances, identityInstances, enabledAlerts, enabledAlertRules] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.status, "active")),
    db
      .select({ userId: aiInstances.ownerUserId, instanceId: aiInstances.id, projectId: aiInstances.projectId })
      .from(aiInstances)
      .where(eq(aiInstances.status, "active")),
    db
      .select({
        userId: channelIdentities.userId,
        instanceId: channelIdentityInstances.instanceId,
        projectId: channelIdentityInstances.projectId,
      })
      .from(channelIdentityInstances)
      .innerJoin(channelIdentities, eq(channelIdentityInstances.channelIdentityId, channelIdentities.id))
      .where(eq(channelIdentities.channel, "weixin-mobile")),
    db.select({ userId: alerts.userId, instanceId: alerts.instanceId }).from(alerts).where(eq(alerts.enabled, true)),
    db.select({ userId: alertRules.userId, instanceId: alertRules.instanceId }).from(alertRules).where(eq(alertRules.enabled, true)),
  ]);

  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  for (const instance of instances) {
    if (activeUserIds.has(instance.userId)) addScope(scopes, instance);
  }
  for (const scope of identityInstances) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  for (const scope of enabledAlerts) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  for (const scope of enabledAlertRules) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  return [...scopes.values()];
}

export async function listSchedulableScopes() {
  return getSchedulableScopes();
}

/** 从数据库读取巡检间隔（分钟） */
export async function getAlertInterval(): Promise<number> {
  const rows = await db.select().from(settings).where(eq(settings.key, INTERVAL_SETTINGS_KEY)).limit(1);
  if (rows.length > 0) {
    const val = Number(rows[0].value);
    return Number.isFinite(val) && val >= 1 ? val : DEFAULT_INTERVAL_MINUTES;
  }
  return DEFAULT_INTERVAL_MINUTES;
}

/** 更新巡检间隔并重启定时器 */
export async function setAlertInterval(minutes: number): Promise<string> {
  if (!Number.isFinite(minutes) || minutes < 1) {
    return "巡检间隔至少1分钟";
  }
  await db.insert(settings).values({ key: INTERVAL_SETTINGS_KEY, value: String(minutes) })
    .onConflictDoUpdate({ target: settings.key, set: { value: String(minutes) } });

  restartAlertInterval(minutes);
  logger.info(`巡检间隔已更新为 ${minutes} 分钟`);
  return `巡检间隔已更新为 ${minutes} 分钟`;
}

function restartAlertInterval(_minutes: number) {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
  }
  alertIntervalId = setInterval(async () => {
    try {
      const now = new Date();
      const fallbackInterval = await getAlertInterval();
      const scopes = await getSchedulableScopes();
      for (const { userId, instanceId, projectId } of scopes) {
        const runningKey = `${userId}:${instanceId}`;
        try {
          if (runningMarketWatchTasks.has(runningKey)) continue;
          const hit = await shouldRunMarketWatchTask({ userId, instanceId, projectId }, fallbackInterval, now);
          if (!hit) continue;
          const runKey = hit.taskKey;
          const claimed = await claimScheduledTaskRun({
            taskKey: runKey,
            taskType: "market-watch",
            scheduledFor: hit.scheduledFor,
            userId,
            projectId,
            instanceId,
          });
          if (!claimed) {
            logger.info(`跳过盘中巡检 user=${userId} instance=${instanceId} slot=${hit.slot}: task 已被其他进程领取`);
            continue;
          }
          runningMarketWatchTasks.add(runningKey);
          try {
            const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId });
            if (text) {
              const pushResult = await getPushFn()(text, { userId, projectId, instanceId });
              await finishScheduledTaskRun(runKey, {
                status: "success",
                pushJobId: typeof pushResult === "string" ? pushResult : undefined,
              });
            } else {
              logger.info(`盘中巡检无推送 user=${userId} instance=${instanceId}`);
              await finishScheduledTaskRun(runKey, { status: "skipped" });
            }
          } catch (error) {
            await finishScheduledTaskRun(runKey, {
              status: "error",
              errorMessage: formatUnknownError(error),
            });
            throw error;
          }
        } catch (error) {
          logger.error(`行情巡检失败 (${userId}/${instanceId}):`, error);
        } finally {
          runningMarketWatchTasks.delete(runningKey);
        }

        try {
          if (runningRuleAlertTasks.has(runningKey)) continue;
          const hit = shouldRunRuleAlertCheckTask({ userId, instanceId, projectId }, fallbackInterval, now);
          if (!hit) continue;
          const claimed = await claimScheduledTaskRun({
            taskKey: hit.taskKey,
            taskType: "rule-alert-check",
            scheduledFor: hit.scheduledFor,
            userId,
            projectId,
            instanceId,
          });
          if (!claimed) {
            logger.info(`跳过规则巡检 user=${userId} instance=${instanceId} slot=${hit.slot}: task 已被其他进程领取`);
            continue;
          }
          runningRuleAlertTasks.add(runningKey);
          try {
            const items = await runAlertCheck({ force: true, userId, instanceId });
            if (items.length > 0) {
              const text = formatAlerts(items);
              const pushResult = await getPushFn()(text, { userId, projectId, instanceId });
              await finishScheduledTaskRun(hit.taskKey, {
                status: "success",
                pushJobId: typeof pushResult === "string" ? pushResult : undefined,
              });
              logger.info(`规则巡检命中 user=${userId} instance=${instanceId} slot=${hit.slot} alerts=${items.length}`);
            } else {
              await finishScheduledTaskRun(hit.taskKey, { status: "skipped" });
              logger.info(`规则巡检无命中 user=${userId} instance=${instanceId} slot=${hit.slot}`);
            }
          } catch (error) {
            await finishScheduledTaskRun(hit.taskKey, {
              status: "error",
              errorMessage: formatUnknownError(error),
            });
            throw error;
          }
        } catch (error) {
          logger.error(`规则巡检失败 (${userId}/${instanceId}):`, error);
        } finally {
          runningRuleAlertTasks.delete(runningKey);
        }
      }
    } catch (error) {
      logger.error("行情巡检失败:", error);
    }
  }, 60 * 1000);
}

/** 启动所有定时任务 */
export async function startScheduler() {
  logger.info("启动定时任务调度器...");

  const intervalMin = await getAlertInterval();
  restartAlertInterval(intervalMin);

  // 收盘后日复盘
  startReviewScheduler(async (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => {
    await getPushFn()(message, options);
  }, getSchedulableScopes);

  // 收盘后平台级数据质量汇总
  await startDataQualityScheduler();

  const pushTime = await getReviewPushTime();
  logger.info(`定时任务已启动（巡检: 每分钟扫描 workspace 配置,默认间隔 ${intervalMin}min / 复盘 ${pushTime.hour}:${String(pushTime.minute).padStart(2, "0")} / 数据质量 15:30）`);
}

/** 停止所有定时任务 */
export function stopScheduler() {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
    alertIntervalId = null;
  }
  stopReviewScheduler();
  stopDataQualityScheduler();
  logger.info("定时任务已停止");
}

async function shouldRunMarketWatchTask(scope: SchedulableScope, fallbackIntervalMinutes: number, now: Date): Promise<{ taskKey: string; scheduledFor: string; slot: string } | null> {
  if (!isBeijingTradingDay(now)) return null;

  const schedules = readSchedules(scope.userId);
  if (schedules.market_watch?.enabled === false || schedules.market_watch?.auto_run === false) return null;

  const watch = await readWatchConfig(scope.userId);
  if (watch?.mode === "disabled" || watch?.mode === "off") return null;

  const windows = normalizeWatchWindows(watch?.default_check_windows ?? schedules.market_watch?.default_windows);
  const customInterval = resolveMarketWatchInterval(watch, schedules, fallbackIntervalMinutes, windows.length > 0);
  const slot = customInterval
    ? intervalSlot(now, customInterval)
    : windowSlot(now, windows, 3);
  if (!slot) return null;

  const dateKey = beijingDateKey(now);
  const key = `${dateKey}:market-watch:${scope.userId}:${scope.instanceId}:${slot}`;
  if (marketWatchFiredKeys.has(key)) return null;
  marketWatchFiredKeys.add(key);
  logger.info(`命中盘中巡检 user=${scope.userId} instance=${scope.instanceId} slot=${slot}`);
  return { taskKey: key, scheduledFor: `${dateKey}:${slot}`, slot };
}

function shouldRunRuleAlertCheckTask(scope: SchedulableScope, intervalMinutes: number, now: Date): { taskKey: string; scheduledFor: string; slot: string } | null {
  if (!isBeijingTradingDay(now)) return null;
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes >= 1 ? intervalMinutes : DEFAULT_INTERVAL_MINUTES;
  const slot = intervalSlot(now, interval);
  if (!slot) return null;
  const dateKey = beijingDateKey(now);
  const key = `${dateKey}:rule-alert-check:${scope.userId}:${scope.instanceId}:${slot}`;
  if (ruleAlertFiredKeys.has(key)) return null;
  ruleAlertFiredKeys.add(key);
  logger.info(`命中规则巡检 user=${scope.userId} instance=${scope.instanceId} slot=${slot}`);
  return { taskKey: key, scheduledFor: `${dateKey}:${slot}`, slot };
}

export async function triggerScheduledMarketWatchNow(
  scope: ManualScheduledTriggerScope,
  now = new Date(),
  options: { manualReason?: string } = {},
) {
  const userId = scope.userId.trim();
  const instanceId = scope.instanceId.trim();
  const projectId = scope.projectId ?? DEFAULT_PROJECT_ID;
  const bj = beijingNow(now);
  const manualReason = options.manualReason ?? "manual-trigger";
  const slot = `manual-${String(bj.getHours()).padStart(2, "0")}${String(bj.getMinutes()).padStart(2, "0")}`;
  const dateKey = beijingDateKey(now);
  const taskKey = `${dateKey}:market-watch:${userId}:${instanceId}:${slot}:${manualReason}`;
  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: "market-watch",
    scheduledFor: `${dateKey}:${slot}`,
    userId,
    projectId,
    instanceId,
  });
  if (!claimed) {
    logger.info(`跳过盘中巡检 user=${userId} instance=${instanceId} reason=${manualReason}: task 已被其他进程领取`);
    return { taskKey, skipped: true };
  }

  try {
    const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId });
    if (!text) {
      logger.info(`盘中巡检无推送 user=${userId} instance=${instanceId} reason=${manualReason}`);
      await finishScheduledTaskRun(taskKey, { status: "skipped" });
      return { taskKey, skipped: true };
    }
    const pushResult = await getPushFn()(text, { userId, projectId, instanceId });
    const pushJobId = typeof pushResult === "string" ? pushResult : undefined;
    await finishScheduledTaskRun(taskKey, { status: "success", pushJobId });
    return { taskKey, skipped: false, pushJobId };
  } catch (error) {
    await finishScheduledTaskRun(taskKey, {
      status: "error",
      errorMessage: formatUnknownError(error),
    });
    throw error;
  }
}

export async function triggerScheduledReviewNow(
  kind: "daily" | "weekly" | "monthly",
  scope: ManualScheduledTriggerScope,
  now = new Date(),
  options: { manualReason?: string } = {},
) {
  return triggerReviewNow(kind, scope, getPushFn(), now, options);
}

async function readWatchConfig(userId: string) {
  try {
    return await new WorkspaceStore(userId).readWatch();
  } catch (error) {
    logger.warn(`market_watch.readWatch failed user=${userId}: ${(error as Error).message}`);
    return null;
  }
}

function isAshareMarketWatchTime(now: Date) {
  if (!isBeijingTradingDay(now)) return false;
  const bj = beijingNow(now);
  const timeNum = bj.getHours() * 100 + bj.getMinutes();
  return (timeNum >= 920 && timeNum <= 1130) || (timeNum >= 1300 && timeNum <= 1500);
}

function normalizeWatchWindows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return "";
      const raw = item as Record<string, unknown>;
      return typeof raw.time === "string" ? raw.time.trim() : "";
    })
    .filter((time) => /^(\d{1,2}):(\d{2})$/.test(time));
}

function resolveMarketWatchInterval(
  watch: Awaited<ReturnType<typeof readWatchConfig>>,
  schedules: SchedulesYaml,
  fallbackIntervalMinutes: number,
  hasDefaultWindows: boolean,
) {
  const raw =
    readIntervalMinutes((watch as Record<string, unknown> | null)?.check_interval_minutes) ??
    readIntervalMinutes((watch as Record<string, unknown> | null)?.custom_frequency) ??
    readIntervalMinutes(schedules.market_watch?.custom_frequency);
  if (raw != null) return Math.max(1, raw);
  return hasDefaultWindows ? null : Math.max(1, fallbackIntervalMinutes);
}

function readIntervalMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "default" || trimmed === "默认" || trimmed === "null") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function intervalSlot(now: Date, intervalMinutes: number) {
  const bj = beijingNow(now);
  const minutes = bj.getHours() * 60 + bj.getMinutes();
  const morningStart = 9 * 60 + 20;
  const morningEnd = 11 * 60 + 30;
  const afternoonStart = 13 * 60;
  const afternoonEnd = 15 * 60;
  if (minutes >= morningStart && minutes <= morningEnd) {
    const elapsed = minutes - morningStart;
    return elapsed % intervalMinutes === 0 ? `am-${Math.floor(elapsed / intervalMinutes)}` : null;
  }
  if (minutes >= afternoonStart && minutes <= afternoonEnd) {
    const elapsed = minutes - afternoonStart;
    return elapsed % intervalMinutes === 0 ? `pm-${Math.floor(elapsed / intervalMinutes)}` : null;
  }
  return null;
}

function windowSlot(now: Date, windows: string[], graceMinutes = 0) {
  if (windows.length === 0) return null;
  const bj = beijingNow(now);
  const currentMinutes = bj.getHours() * 60 + bj.getMinutes();
  for (const window of windows) {
    const [hourRaw, minuteRaw] = window.split(":");
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
    const windowMinutes = hour * 60 + minute;
    const delta = currentMinutes - windowMinutes;
    if (delta >= 0 && delta <= graceMinutes) return window;
  }
  return null;
}

export const __test__ = {
  normalizeWatchWindows,
  readIntervalMinutes,
  intervalSlot,
  windowSlot,
};
