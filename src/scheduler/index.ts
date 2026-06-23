import { runAlertCheck, formatAlerts } from "./alert-check.js";
import { runPreMarketAlert } from "./pre-market.js";
import { startReviewScheduler, getReviewPushTime } from "./review.js";
import { logger } from "../lib/logger.js";
import { db } from "../db/index.js";
import { aiInstances, alerts, channelIdentities, channelIdentityInstances, portfolio, settings, users, watchlist } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";

export type PushCallback = (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => Promise<void | boolean>;

const INTERVAL_SETTINGS_KEY = "alert_check_interval_minutes";
const DEFAULT_INTERVAL_MINUTES = 5;

let pushFn: PushCallback | null = null;
let intervals: ReturnType<typeof setInterval>[] = [];
let alertIntervalId: ReturnType<typeof setInterval> | null = null;

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
  const [activeUsers, identities] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.status, "active")),
    db
      .select({ userId: channelIdentities.userId })
      .from(channelIdentities)
      .where(eq(channelIdentities.channel, "weixin-mobile")),
  ]);
  const active = new Set(activeUsers.map((user) => user.id));
  const ids = new Set<string>([DEFAULT_USER_ID]);
  for (const identity of identities) {
    if (active.has(identity.userId)) ids.add(identity.userId);
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

function restartAlertInterval(minutes: number) {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
  }
  alertIntervalId = setInterval(async () => {
    try {
      const scopes = await getSchedulableScopes();
      for (const { userId, instanceId, projectId } of scopes) {
        try {
          const alertItems = await runAlertCheck({ userId, instanceId });
          if (alertItems.length > 0) {
            const text = formatAlerts(alertItems);
            await getPushFn()(text, { userId, projectId, instanceId });
          }
        } catch (error) {
          logger.error(`行情巡检失败 (${userId}/${instanceId}):`, error);
        }
      }
    } catch (error) {
      logger.error("行情巡检失败:", error);
    }
  }, minutes * 60 * 1000);
}

/** 启动所有定时任务 */
export async function startScheduler() {
  logger.info("启动定时任务调度器...");

  const intervalMin = await getAlertInterval();
  restartAlertInterval(intervalMin);

  // 每分钟检查是否到 9:15（开盘前提醒）
  const preMarketInterval = setInterval(async () => {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const bjTime = new Date(utc + 8 * 3600000);
    const hour = bjTime.getHours();
    const minute = bjTime.getMinutes();
    const day = bjTime.getDay();

    if (day >= 1 && day <= 5 && hour === 9 && minute === 15) {
      try {
        const userIds = await getSchedulableUserIds();
        for (const userId of userIds) {
          const instanceId = defaultInstanceIdForUser(userId);
          try {
            const text = await runPreMarketAlert({ userId, instanceId });
            if (text) await getPushFn()(text, { userId, instanceId });
          } catch (error) {
            logger.error(`开盘前提醒失败 (${userId}):`, error);
          }
        }
      } catch (error) {
        logger.error("开盘前提醒失败:", error);
      }
    }
  }, 60 * 1000);

  intervals = [preMarketInterval];

  // 收盘后日复盘
  startReviewScheduler(async (message: string, options?: { userId?: string }) => {
    await getPushFn()(message, options);
  }, getSchedulableUserIds);

  const pushTime = await getReviewPushTime();
  logger.info(`定时任务已启动（巡检 ${intervalMin}min / 盘前 9:15 / 复盘 ${pushTime.hour}:${String(pushTime.minute).padStart(2, "0")}）`);
}

/** 停止所有定时任务 */
export function stopScheduler() {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
    alertIntervalId = null;
  }
  for (const interval of intervals) {
    clearInterval(interval);
  }
  intervals = [];
  logger.info("定时任务已停止");
}
