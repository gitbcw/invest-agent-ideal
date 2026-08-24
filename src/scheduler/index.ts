import { startReviewScheduler, stopReviewScheduler, getReviewPushTime, triggerReviewNow, type ReviewScope } from "./review.js";
import { startDataQualityScheduler, stopDataQualityScheduler } from "./data-quality.js";
import { startAutomationScheduler, stopAutomationScheduler } from "./automation.js";
import { logger } from "../lib/logger.js";
import { beijingDateKey, beijingNow, isBeijingTradingDay } from "../lib/schedules-loader.js";
import { db, sqlite } from "../db/index.js";
import { aiInstances, alertRules, channelIdentities, channelIdentityInstances, settings, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
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
import { runModelProbes } from "../services/model-health.js";

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
const MARKET_WATCH_MAX_QUEUE_DELAY_MS = normalizePositiveInteger(
  process.env.MARKET_WATCH_MAX_QUEUE_DELAY_MS,
  5 * 60 * 1000
);

let pushFn: PushCallback | null = null;
let alertIntervalId: ReturnType<typeof setInterval> | null = null;
let onboardingDraftCommitIntervalId: ReturnType<typeof setInterval> | null = null;
let modelProbeIntervalId: ReturnType<typeof setInterval> | null = null;
let modelProbeStartupTimer: ReturnType<typeof setTimeout> | null = null;
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
  // P4b: schedulerActivation is retired — these scopes feed only the rule
  // patrol and manual flows now; scheduled reviews/market-watch fire from
  // typed automation tasks, whose own active/paused state is the gate.
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
        // P4b: market-watch fires only as a typed automation task; this loop
        // now drives the rule patrol alone.
        const ruleAlertHit = runningRuleAlertTasks.has(runningKey)
          ? null
          : shouldRunRuleAlertCheckTask({ userId, instanceId, projectId }, fallbackInterval, now);
        try {
          if (!ruleAlertHit) continue;
          runningRuleAlertTasks.add(runningKey);
          try {
            const items = await runAlertCheck({ force: true, userId, instanceId });
            // 无命中不落运行记录、不打日志：巡检默认每 5 分钟一轮，仅命中与失败留痕。
            if (items.length === 0) continue;
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
          } catch (error) {
            // 失败必须留痕：评估或推送异常时补记 error 运行记录（claim 幂等，已领取时仅在 claimed 行上生效）。
            try {
              await claimScheduledTaskRun({
                taskKey: ruleAlertHit.taskKey,
                taskType: "rule-alert-check",
                scheduledFor: ruleAlertHit.scheduledFor,
                userId,
                projectId,
                instanceId,
              });
            } catch {
              // 留痕失败不掩盖原始错误
            }
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
  // W1-P2 模型健康探针：启动 90s 后首探，此后每小时一轮。
  modelProbeStartupTimer = setTimeout(() => {
    void runModelProbes().then((results: Array<{ model: string; ok: boolean; latencyMs?: number }>) => {
      if (results.some((item: { ok: boolean }) => !item.ok)) logger.warn(`模型探针存在失败: ${JSON.stringify(results)}`);
    }).catch((error: unknown) => logger.warn("模型探针异常:", error));
  }, 90_000);
  modelProbeIntervalId = setInterval(() => {
    void runModelProbes().catch((error: unknown) => logger.warn("模型探针异常:", error));
  }, 60 * 60 * 1000);

  const pushTime = await getReviewPushTime();
  logger.info(`定时任务已启动（规则巡检分钟扫描默认间隔 ${intervalMin}min；Onboarding 草稿提交 5s；复盘/盯盘由 typed 自动化任务驱动；复盘推送 ${pushTime.hour}:${String(pushTime.minute).padStart(2, "0")}；数据质量 15:30）`);
}

/** 停止所有定时任务 */
export function stopScheduler() {
  if (alertIntervalId !== null) {
    clearInterval(alertIntervalId);
    alertIntervalId = null;
  }
  if (modelProbeStartupTimer !== null) {
    clearTimeout(modelProbeStartupTimer);
    modelProbeStartupTimer = null;
  }
  if (modelProbeIntervalId !== null) {
    clearInterval(modelProbeIntervalId);
    modelProbeIntervalId = null;
  }
  if (onboardingDraftCommitIntervalId !== null) {
    clearInterval(onboardingDraftCommitIntervalId);
    onboardingDraftCommitIntervalId = null;
  }
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

function shouldRunRuleAlertCheckTask(scope: SchedulableScope, intervalMinutes: number, now: Date): { taskKey: string; scheduledFor: string; slot: string } | null {
  if (!isBeijingTradingDay(now)) return null;
  const interval = Number.isFinite(intervalMinutes) && intervalMinutes >= 1 ? intervalMinutes : DEFAULT_INTERVAL_MINUTES;
  const slot = intervalSlot(now, interval);
  if (!slot) return null;
  const dateKey = beijingDateKey(now);
  const key = `${dateKey}:rule-alert-check:${scope.userId}:${scope.instanceId}:${slot}`;
  if (ruleAlertFiredKeys.has(key)) return null;
  ruleAlertFiredKeys.add(key);
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
    const text = await runScheduledMarketWatchTask({ userId, instanceId, projectId }, { runId: taskKey });
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


export const __test__ = {
  intervalSlot,
};
