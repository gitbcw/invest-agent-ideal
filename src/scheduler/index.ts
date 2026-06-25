import { startReviewScheduler, getReviewPushTime } from "./review.js";
import { logger } from "../lib/logger.js";
import { db } from "../db/index.js";
import { aiInstances, alerts, channelIdentities, channelIdentityInstances, portfolio, settings, users, watchlist } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { beijingDateKey, beijingNow, isBeijingTradingDay, readSchedules, type SchedulesYaml } from "../lib/schedules-loader.js";
import { runScheduledMarketWatchTask } from "../acp/scheduled-tasks.js";

export type PushCallback = (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => Promise<void | boolean>;

const INTERVAL_SETTINGS_KEY = "alert_check_interval_minutes";
const DEFAULT_INTERVAL_MINUTES = 5;

let pushFn: PushCallback | null = null;
let alertIntervalId: ReturnType<typeof setInterval> | null = null;
const marketWatchFiredKeys = new Set<string>();
const runningMarketWatchTasks = new Set<string>();

interface SchedulableScope {
  userId: string;
  instanceId: string;
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

async function getSchedulableUserIds(): Promise<string[]> {
  const identities = await db
    .select({ userId: channelIdentities.userId })
    .from(channelIdentities)
    .where(eq(channelIdentities.channel, "weixin-mobile"));
  const ids = new Set<string>([DEFAULT_USER_ID]);
  for (const identity of identities) {
    ids.add(identity.userId);
  }
  return [...ids];
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

  const [activeUsers, instances, identityInstances, enabledAlerts, watchItems, positions] = await Promise.all([
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
    db.select({ userId: watchlist.userId, instanceId: watchlist.instanceId }).from(watchlist),
    db.select({ userId: portfolio.userId, instanceId: portfolio.instanceId }).from(portfolio),
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
  for (const scope of watchItems) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  for (const scope of positions) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }

  return [...scopes.values()];
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
        const taskKey = `${userId}:${instanceId}`;
        try {
          if (runningMarketWatchTasks.has(taskKey)) continue;
          const hit = await shouldRunMarketWatchTask({ userId, instanceId, projectId }, fallbackInterval, now);
          if (!hit) continue;
          runningMarketWatchTasks.add(taskKey);
          const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId });
          if (text) await getPushFn()(text, { userId, projectId, instanceId });
        } catch (error) {
          logger.error(`行情巡检失败 (${userId}/${instanceId}):`, error);
        } finally {
          runningMarketWatchTasks.delete(taskKey);
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
  startReviewScheduler(async (message: string, options?: { userId?: string }) => {
    await getPushFn()(message, options);
  }, getSchedulableUserIds);

  const pushTime = await getReviewPushTime();
  logger.info(`定时任务已启动（巡检: 每分钟扫描 workspace 配置,默认间隔 ${intervalMin}min / 复盘 ${pushTime.hour}:${String(pushTime.minute).padStart(2, "0")}）`);
}

/** 停止所有定时任务 */
export function stopScheduler() {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
    alertIntervalId = null;
  }
  logger.info("定时任务已停止");
}

async function shouldRunMarketWatchTask(scope: SchedulableScope, fallbackIntervalMinutes: number, now: Date): Promise<boolean> {
  if (!isAshareMarketWatchTime(now)) return false;

  const schedules = readSchedules(scope.userId);
  if (schedules.market_watch?.enabled === false || schedules.market_watch?.auto_run === false) return false;

  const watch = await readWatchConfig(scope.userId);
  if (watch?.mode === "disabled" || watch?.mode === "off") return false;

  const windows = normalizeWatchWindows(watch?.default_check_windows ?? schedules.market_watch?.default_windows);
  const customInterval = resolveMarketWatchInterval(watch, schedules, fallbackIntervalMinutes, windows.length > 0);
  const slot = customInterval
    ? intervalSlot(now, customInterval)
    : windowSlot(now, windows);
  if (!slot) return false;

  const key = `${beijingDateKey(now)}:${scope.userId}:${scope.instanceId}:market-watch:${slot}`;
  if (marketWatchFiredKeys.has(key)) return false;
  marketWatchFiredKeys.add(key);
  return true;
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
    readNumberLike((watch as Record<string, unknown> | null)?.check_interval_minutes) ??
    readNumberLike((watch as Record<string, unknown> | null)?.custom_frequency) ??
    readNumberLike(schedules.market_watch?.custom_frequency);
  if (raw != null) return Math.max(1, raw);
  return hasDefaultWindows ? null : Math.max(1, fallbackIntervalMinutes);
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "default" || trimmed === "默认") return null;
  if (trimmed.includes("高频")) return 1;
  if (trimmed.includes("低频")) return 30;
  const m = /(\d+)/.exec(trimmed);
  if (!m) return null;
  const n = Number(m[1]);
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

function windowSlot(now: Date, windows: string[]) {
  if (windows.length === 0) return null;
  const bj = beijingNow(now);
  const current = `${String(bj.getHours()).padStart(2, "0")}:${String(bj.getMinutes()).padStart(2, "0")}`;
  return windows.includes(current) ? current : null;
}
