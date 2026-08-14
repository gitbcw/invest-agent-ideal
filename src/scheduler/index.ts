import { startReviewScheduler, stopReviewScheduler, getReviewPushTime, triggerReviewNow, type ReviewScope } from "./review.js";
import { startDataQualityScheduler, stopDataQualityScheduler } from "./data-quality.js";
import { startAutomationScheduler, stopAutomationScheduler } from "./automation.js";
import { logger } from "../lib/logger.js";
import { db, sqlite } from "../db/index.js";
import { aiInstances, alertRules, channelIdentities, channelIdentityInstances, settings, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { beijingDateKey, beijingNow, isBeijingTradingDay, readSchedules, type SchedulesYaml } from "../lib/schedules-loader.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { MastraUserPreferenceStore } from "../services/user-preferences.js";
import { runScheduledMarketWatchTask } from "../runtime/scheduled-tasks.js";
import {
  claimScheduledTaskRun,
  finishScheduledTaskRun,
  reconcileExpiredScheduledTaskRuns,
} from "../services/scheduled-task-runs.js";
import { formatUnknownError } from "../lib/errors.js";
import { formatAlerts, runAlertCheck } from "./alert-check.js";
import { processOnboardingDraftCommits } from "../services/onboarding-drafts.js";
import {
  resolveScheduledMessageExpiry,
  scheduledMessageIdempotencyKey,
  type ScheduledMessageKind,
} from "../services/scheduled-message-policy.js";

export type PushCallback = (message: string, options?: {
  userId?: string;
  projectId?: string;
  instanceId?: string;
  messageKind?: ScheduledMessageKind;
  expiresAt?: string;
  originTaskKey?: string;
  retryPolicy?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}) => Promise<void | boolean | string>;

const INTERVAL_SETTINGS_KEY = "alert_check_interval_minutes";
const DEFAULT_INTERVAL_MINUTES = 5;
const MARKET_WATCH_CONCURRENCY = normalizePositiveInteger(process.env.MARKET_WATCH_CONCURRENCY, 2);
const MARKET_WATCH_MAX_QUEUE_DELAY_MS = normalizePositiveInteger(
  process.env.MARKET_WATCH_MAX_QUEUE_DELAY_MS,
  5 * 60 * 1000
);

let pushFn: PushCallback | null = null;
let alertIntervalId: ReturnType<typeof setInterval> | null = null;
let onboardingDraftCommitIntervalId: ReturnType<typeof setInterval> | null = null;
const marketWatchFiredKeys = new Set<string>();
const runningMarketWatchTasks = new Set<string>();
const marketWatchQueue: MarketWatchQueueItem[] = [];
let activeMarketWatchWorkers = 0;
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

interface MarketWatchHit {
  taskKey: string;
  scheduledFor: string;
  slot: string;
}

interface MarketWatchQueueItem {
  scope: Required<SchedulableScope>;
  hit: MarketWatchHit;
  runningKey: string;
  enqueuedAt: number;
}

function normalizePositiveInteger(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
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

  const [activeUsers, instances, identityInstances, enabledAlertRules] = await Promise.all([
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
    db.select({ userId: alertRules.userId, instanceId: alertRules.instanceId }).from(alertRules).where(eq(alertRules.enabled, true)),
  ]);

  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  for (const instance of instances) {
    if (activeUserIds.has(instance.userId)) addScope(scopes, instance);
  }
  for (const scope of identityInstances) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  for (const scope of enabledAlertRules) {
    if (activeUserIds.has(scope.userId)) addScope(scopes, scope);
  }
  const candidates = [...scopes.values()];
  if (ACTIVE_BACKEND !== "mastra") return candidates;
  // Imported Mastra targets remain inert until an operator explicitly enables
  // scheduler activation. This prevents a cold-start process from pushing
  // migrated data merely because an active instance exists in SQLite.
  const enabled: SchedulableScope[] = [];
  for (const scope of candidates) {
    const row = sqlite.prepare(
      "SELECT preferences_json AS preferencesJson FROM mastra_runtime_preferences WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
    ).get(scope.userId, scope.projectId ?? DEFAULT_PROJECT_ID, scope.instanceId) as { preferencesJson?: string } | undefined;
    let activation: unknown;
    try { activation = row?.preferencesJson ? JSON.parse(row.preferencesJson).schedulerActivation : undefined; } catch { activation = undefined; }
    if (activation === "enabled") enabled.push(scope);
    else logger.info(`Mastra scheduler scope disabled user=${scope.userId} instance=${scope.instanceId} activation=${String(activation ?? "missing")}`);
  }
  return enabled;
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
        const marketWatchHit = runningMarketWatchTasks.has(runningKey)
          ? null
          : await shouldRunMarketWatchTask({ userId, instanceId, projectId }, fallbackInterval, now);
        const ruleAlertHit = runningRuleAlertTasks.has(runningKey)
          ? null
          : shouldRunRuleAlertCheckTask({ userId, instanceId, projectId }, fallbackInterval, now);
        const tickPlan = planSchedulerTick({
          marketWatchHit: Boolean(marketWatchHit),
          ruleAlertHit: Boolean(ruleAlertHit),
          marketWatchRunning: runningMarketWatchTasks.has(runningKey),
          ruleAlertRunning: runningRuleAlertTasks.has(runningKey),
        });
        try {
          if (tickPlan.runMarketWatch && marketWatchHit) {
            const claimed = await claimScheduledTaskRun({
              taskKey: marketWatchHit.taskKey,
              taskType: "market-watch",
              scheduledFor: marketWatchHit.scheduledFor,
              userId,
              projectId,
              instanceId,
            });
            if (!claimed) {
              logger.info(`跳过盘中定时简报 user=${userId} instance=${instanceId} slot=${marketWatchHit.slot}: task 已被其他进程领取`);
            } else {
              runningMarketWatchTasks.add(runningKey);
              enqueueMarketWatchTask({
                scope: { userId, instanceId, projectId: projectId ?? DEFAULT_PROJECT_ID },
                hit: marketWatchHit,
                runningKey,
                enqueuedAt: Date.now(),
              });
            }
          }
        } catch (error) {
          logger.error(`盘中定时简报调度失败 (${userId}/${instanceId}):`, error);
        }

        try {
          if (!tickPlan.runRuleAlertCheck || !ruleAlertHit) continue;
          const claimed = await claimScheduledTaskRun({
            taskKey: ruleAlertHit.taskKey,
            taskType: "rule-alert-check",
            scheduledFor: ruleAlertHit.scheduledFor,
            userId,
            projectId,
            instanceId,
          });
          if (!claimed) {
            logger.info(`跳过规则巡检 user=${userId} instance=${instanceId} slot=${ruleAlertHit.slot}: task 已被其他进程领取`);
            continue;
          }
          runningRuleAlertTasks.add(runningKey);
          try {
            const items = await runAlertCheck({ force: true, userId, instanceId });
            if (items.length > 0) {
              if (shouldSuppressRuleAlertPush({ marketWatchHitThisTick: Boolean(marketWatchHit), alertCount: items.length })) {
                await finishScheduledTaskRun(ruleAlertHit.taskKey, {
                  status: "skipped",
                  errorMessage: "suppressed: market-watch brief already hit in same scheduler tick",
                });
                logger.info(
                  `规则巡检命中但同 tick 已有盘中简报，跳过单独推送 user=${userId} instance=${instanceId} slot=${ruleAlertHit.slot} alerts=${items.length}`
                );
                continue;
              }
              const text = formatAlerts(items);
              const messageKind = "rule_alert" as const;
              const delivery = resolveScheduledMessageExpiry(messageKind, now);
              const pushResult = await getPushFn()(text, {
                userId,
                projectId,
                instanceId,
                messageKind,
                expiresAt: delivery.expiresAt,
                originTaskKey: ruleAlertHit.taskKey,
                retryPolicy: delivery.retryPolicy,
                idempotencyKey: scheduledMessageIdempotencyKey({
                  userId,
                  instanceId,
                  kind: messageKind,
                  businessPeriod: ruleAlertHit.taskKey,
                }),
                maxAttempts: delivery.maxAttempts,
              });
              await finishScheduledTaskRun(ruleAlertHit.taskKey, {
                status: "success",
                pushJobId: typeof pushResult === "string" ? pushResult : undefined,
              });
              logger.info(`规则巡检命中 user=${userId} instance=${instanceId} slot=${ruleAlertHit.slot} alerts=${items.length}`);
            } else {
              await finishScheduledTaskRun(ruleAlertHit.taskKey, { status: "skipped" });
              logger.info(`规则巡检无命中 user=${userId} instance=${instanceId} slot=${ruleAlertHit.slot}`);
            }
          } catch (error) {
            await finishScheduledTaskRun(ruleAlertHit.taskKey, {
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
      logger.error("定时任务扫描失败:", error);
    }
  }, 60 * 1000);
}

function enqueueMarketWatchTask(item: MarketWatchQueueItem) {
  marketWatchQueue.push(item);
  logger.info(
    `盘中定时简报入队 user=${item.scope.userId} instance=${item.scope.instanceId} slot=${item.hit.slot} queue=${marketWatchQueue.length} active=${activeMarketWatchWorkers}/${MARKET_WATCH_CONCURRENCY}`
  );
  drainMarketWatchQueue();
}

function drainMarketWatchQueue() {
  while (activeMarketWatchWorkers < MARKET_WATCH_CONCURRENCY && marketWatchQueue.length > 0) {
    const item = marketWatchQueue.shift();
    if (!item) return;
    activeMarketWatchWorkers += 1;
    runQueuedMarketWatchTask(item)
      .catch((error) => {
        logger.error(`盘中定时简报 worker 失败 (${item.scope.userId}/${item.scope.instanceId}):`, error);
      })
      .finally(() => {
        activeMarketWatchWorkers -= 1;
        runningMarketWatchTasks.delete(item.runningKey);
        drainMarketWatchQueue();
      });
  }
}

async function runQueuedMarketWatchTask(item: MarketWatchQueueItem) {
  const { userId, instanceId, projectId } = item.scope;
  const ageMs = Date.now() - item.enqueuedAt;
  if (ageMs > MARKET_WATCH_MAX_QUEUE_DELAY_MS) {
    const message = `market-watch task stale before start ageMs=${ageMs}`;
    logger.warn(`盘中定时简报过期跳过 user=${userId} instance=${instanceId} slot=${item.hit.slot} ageMs=${ageMs}`);
    await finishScheduledTaskRun(item.hit.taskKey, {
      status: "skipped",
      errorMessage: message,
    });
    return;
  }

  try {
    const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId });
    if (text) {
      const messageKind = "market_watch" as const;
      const delivery = resolveScheduledMessageExpiry(messageKind, new Date(item.enqueuedAt));
      const pushResult = await getPushFn()(text, {
        userId,
        projectId,
        instanceId,
        messageKind,
        expiresAt: delivery.expiresAt,
        originTaskKey: item.hit.taskKey,
        retryPolicy: delivery.retryPolicy,
        idempotencyKey: scheduledMessageIdempotencyKey({
          userId,
          instanceId,
          kind: messageKind,
          businessPeriod: item.hit.taskKey,
        }),
        maxAttempts: delivery.maxAttempts,
      });
      await finishScheduledTaskRun(item.hit.taskKey, {
        status: "success",
        pushJobId: typeof pushResult === "string" ? pushResult : undefined,
      });
    } else {
      logger.info(`盘中定时简报无推送 user=${userId} instance=${instanceId}`);
      await finishScheduledTaskRun(item.hit.taskKey, { status: "skipped" });
    }
  } catch (error) {
    await finishScheduledTaskRun(item.hit.taskKey, {
      status: "error",
      errorMessage: formatUnknownError(error),
    });
    throw error;
  }
}

/** 启动所有定时任务 */
export async function startScheduler() {
  logger.info("启动定时任务调度器...");

  await reconcileExpiredScheduledTaskRuns();

  const intervalMin = await getAlertInterval();
  restartAlertInterval(intervalMin);
  await runOnboardingDraftCommitWorker();
  onboardingDraftCommitIntervalId = setInterval(() => {
    runOnboardingDraftCommitWorker().catch((error) => logger.error("Onboarding 草稿提交 worker 失败:", error));
  }, 5_000);

  // 收盘后日复盘
  startReviewScheduler((message, options) => getPushFn()(message, options), getSchedulableScopes);

  // 收盘后平台级数据质量汇总
  await startDataQualityScheduler();
  await startAutomationScheduler();

  const pushTime = await getReviewPushTime();
  logger.info(`定时任务已启动（每分钟扫描 ${ACTIVE_BACKEND === "mastra" ? "service-owned preferences" : "Workspace 配置"}；Onboarding 草稿提交 5s；盘中定时简报并发 ${MARKET_WATCH_CONCURRENCY}；规则巡检默认间隔 ${intervalMin}min；复盘 ${pushTime.hour}:${String(pushTime.minute).padStart(2, "0")}；数据质量 15:30）`);
}

/** 停止所有定时任务 */
export function stopScheduler() {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
    alertIntervalId = null;
  }
  if (onboardingDraftCommitIntervalId !== null) {
    clearInterval(onboardingDraftCommitIntervalId);
    onboardingDraftCommitIntervalId = null;
  }
  for (const item of marketWatchQueue) runningMarketWatchTasks.delete(item.runningKey);
  marketWatchQueue.length = 0;
  stopReviewScheduler();
  stopDataQualityScheduler();
  stopAutomationScheduler();
  logger.info("定时任务已停止");
}

async function runOnboardingDraftCommitWorker() {
  const result = await processOnboardingDraftCommits({ limit: 3 });
  if (result.processed > 0) {
    logger.info(`Onboarding 草稿提交 worker processed=${result.processed} completed=${result.completed} failed=${result.failed}`);
  }
}

async function shouldRunMarketWatchTask(scope: SchedulableScope, fallbackIntervalMinutes: number, now: Date): Promise<MarketWatchHit | null> {
  if (!isBeijingTradingDay(now)) return null;
  // Migration rule: an active typed market-watch automation task is
  // authoritative; the preference-driven path must not double-fire.
  try {
    const typed = sqlite.prepare(
      "SELECT 1 AS one FROM automation_tasks WHERE user_id=? AND project_id=? AND instance_id=? AND task_type='scheduled-market-watch' AND status='active' LIMIT 1",
    ).get(scope.userId, scope.projectId ?? "invest-agent", scope.instanceId);
    if (typed) return null;
  } catch {
    // automation tables unavailable: keep the preference-driven behavior
  }

  const schedules: SchedulesYaml = ACTIVE_BACKEND === "mastra"
    ? await new MastraUserPreferenceStore(scope.userId, scope.instanceId, scope.projectId ?? DEFAULT_PROJECT_ID).readSchedules() as SchedulesYaml
    : readSchedules(scope.userId);
  if (schedules.market_watch?.enabled === false || schedules.market_watch?.auto_run === false) return null;

  const watch = await readWatchConfig(scope);
  if (watch?.mode === "disabled" || watch?.mode === "off") return null;

  const windows = resolveMarketWatchWindows(schedules);
  const customInterval = resolveMarketWatchInterval(watch, schedules, fallbackIntervalMinutes, windows.length > 0);
  const slot = customInterval
    ? intervalSlot(now, customInterval)
    : windowSlot(now, windows, 3);
  if (!slot) return null;

  const dateKey = beijingDateKey(now);
  const key = `${dateKey}:market-watch:${scope.userId}:${scope.instanceId}:${slot}`;
  if (marketWatchFiredKeys.has(key)) return null;
  marketWatchFiredKeys.add(key);
  logger.info(`命中盘中定时简报 user=${scope.userId} instance=${scope.instanceId} slot=${slot}`);
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
    logger.info(`跳过盘中定时简报 user=${userId} instance=${instanceId} reason=${manualReason}: task 已被其他进程领取`);
    return { taskKey, skipped: true };
  }

  try {
    const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId });
    if (!text) {
      logger.info(`盘中定时简报无推送 user=${userId} instance=${instanceId} reason=${manualReason}`);
      await finishScheduledTaskRun(taskKey, { status: "skipped" });
      return { taskKey, skipped: true };
    }
    const messageKind = "market_watch" as const;
    const delivery = resolveScheduledMessageExpiry(messageKind, now);
    const pushResult = await getPushFn()(text, {
      userId,
      projectId,
      instanceId,
      messageKind,
      expiresAt: delivery.expiresAt,
      originTaskKey: taskKey,
      retryPolicy: delivery.retryPolicy,
      idempotencyKey: scheduledMessageIdempotencyKey({
        userId,
        instanceId,
        kind: messageKind,
        businessPeriod: taskKey,
      }),
      maxAttempts: delivery.maxAttempts,
    });
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

async function readWatchConfig(scope: SchedulableScope) {
  try {
    if (ACTIVE_BACKEND === "mastra") {
      return await new MastraUserPreferenceStore(scope.userId, scope.instanceId, scope.projectId ?? DEFAULT_PROJECT_ID).readWatch();
    }
    return await new WorkspaceStore(scope.userId).readWatch();
  } catch (error) {
    logger.warn(`market_watch.readWatch failed user=${scope.userId}: ${(error as Error).message}`);
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

function resolveMarketWatchWindows(schedules: SchedulesYaml): string[] {
  return normalizeWatchWindows(schedules.market_watch?.default_windows);
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

function shouldSuppressRuleAlertPush(input: { marketWatchHitThisTick: boolean; alertCount: number }) {
  return input.marketWatchHitThisTick && input.alertCount > 0;
}

function planSchedulerTick(input: { marketWatchHit: boolean; ruleAlertHit: boolean; marketWatchRunning?: boolean; ruleAlertRunning?: boolean }) {
  return {
    runMarketWatch: input.marketWatchHit && !input.marketWatchRunning,
    runRuleAlertCheck: input.ruleAlertHit && !input.ruleAlertRunning,
  };
}

export const __test__ = {
  normalizeWatchWindows,
  resolveMarketWatchWindows,
  readIntervalMinutes,
  intervalSlot,
  windowSlot,
  shouldSuppressRuleAlertPush,
  planSchedulerTick,
};
