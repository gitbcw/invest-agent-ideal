import { logger } from "../lib/logger.js";
import {
  expireStaleScheduledAutomationTaskRun,
  listDueAutomationTasks,
  recoverExpiredAutomationTaskRuns,
} from "../services/automation-tasks.js";
import { runAutomationTaskNow } from "../services/automation-runner.js";

let automationIntervalId: ReturnType<typeof setInterval> | null = null;
const runningAutomationTasks = new Set<string>();
const DEFAULT_AUTOMATION_MAX_CONCURRENCY = 4;
const DEFAULT_AUTOMATION_MAX_QUEUE_DELAY_MS = 2 * 60 * 60 * 1000;

function automationMaxConcurrency(): number {
  const configured = Number.parseInt(process.env.AUTOMATION_MAX_CONCURRENCY || "", 10);
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_AUTOMATION_MAX_CONCURRENCY;
  return Math.min(configured, 100);
}

function automationMaxQueueDelayMs(): number {
  const configured = Number.parseInt(process.env.AUTOMATION_MAX_QUEUE_DELAY_MS || "", 10);
  if (!Number.isInteger(configured) || configured < 0) return DEFAULT_AUTOMATION_MAX_QUEUE_DELAY_MS;
  return configured;
}

function rssBytes(): number {
  return process.memoryUsage().rss;
}

function queueDelayMs(scheduledFor: string, now: Date): number {
  const scheduledAt = Date.parse(scheduledFor);
  return Number.isFinite(scheduledAt) ? Math.max(0, now.getTime() - scheduledAt) : 0;
}

export interface AutomationSchedulerDependencies {
  expireStaleScheduledAutomationTaskRun?: typeof expireStaleScheduledAutomationTaskRun;
  listDueAutomationTasks: typeof listDueAutomationTasks;
  recoverExpiredAutomationTaskRuns: typeof recoverExpiredAutomationTaskRuns;
  runAutomationTaskNow: typeof runAutomationTaskNow;
}

const defaultDependencies: AutomationSchedulerDependencies = {
  expireStaleScheduledAutomationTaskRun,
  listDueAutomationTasks,
  recoverExpiredAutomationTaskRuns,
  runAutomationTaskNow,
};

/**
 * Scan and dispatch due tasks. Dependencies are injectable for deterministic
 * node:test coverage; production callers keep the same one-argument API.
 */
export async function runAutomationSchedulerTick(now = new Date(), dependencies: AutomationSchedulerDependencies = defaultDependencies) {
  const recovered = await dependencies.recoverExpiredAutomationTaskRuns(now, 100);
  if (recovered > 0) logger.warn(`automation scheduler recovered expired runs count=${recovered}`);
  // Scheduled-cursor reconciliation happens inside listDueAutomationTasks, so
  // the tick must not run it a second time on the same minute.
  const due = await dependencies.listDueAutomationTasks(now, 100);
  let started = 0;
  const maxConcurrency = automationMaxConcurrency();
  const maxQueueDelayMs = automationMaxQueueDelayMs();
  for (const task of due) {
    // P4b: schedulerActivation is retired — an active task IS schedulable.
    const key = `${task.userId}:${task.instanceId}:${task.taskId}:${task.currentRevisionId}`;
    if (runningAutomationTasks.has(key)) {
      logger.info(
        `automation scheduler duplicate due task deferred task=${task.taskId} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
      );
      continue;
    }
    const scheduledFor = task.nextRunAt || now.toISOString();
    const dispatchQueueDelayMs = queueDelayMs(scheduledFor, now);
    if (dispatchQueueDelayMs > maxQueueDelayMs) {
      try {
        const expired = await (dependencies.expireStaleScheduledAutomationTaskRun || expireStaleScheduledAutomationTaskRun)({
          userId: task.userId,
          instanceId: task.instanceId,
          projectId: task.projectId,
          taskId: task.taskId,
          revisionId: task.currentRevisionId || undefined,
          scheduledFor,
          idempotencyKey: `${task.taskId}:${task.currentRevisionId}:${scheduledFor}`,
          queueDelayMs: dispatchQueueDelayMs,
          maxQueueDelayMs,
        });
        logger.warn(
          `automation scheduler queue-expired task=${task.taskId} revision=${task.currentRevisionId} expired=${expired.expired} run=${expired.run.runId} status=${expired.run.status} queue_delay_ms=${dispatchQueueDelayMs} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
        );
      } catch (error) {
        logger.error(
          `automation scheduler failed to terminalize stale queued task=${task.taskId} queue_delay_ms=${dispatchQueueDelayMs} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}:`,
          error,
        );
      }
      continue;
    }
    if (runningAutomationTasks.size >= maxConcurrency) {
      logger.warn(
        `automation scheduler admission full queued=${due.length - started} max=${maxConcurrency} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
      );
      break;
    }
    runningAutomationTasks.add(key);
    started += 1;
    const idempotencyKey = `${task.taskId}:${task.currentRevisionId}:${scheduledFor}`;
    logger.info(
      `automation scheduler dispatch task=${task.taskId} revision=${task.currentRevisionId} queue_delay_ms=${dispatchQueueDelayMs} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
    );
    void dependencies.runAutomationTaskNow({
      scope: { userId: task.userId, instanceId: task.instanceId, projectId: task.projectId },
      taskId: task.taskId,
      origin: "scheduled",
      scheduledFor,
      idempotencyKey,
    }).then((result) => {
      logger.info(
        `automation task finished task=${task.taskId} revision=${task.currentRevisionId} run=${result.run.runId} status=${result.run.status} queue_delay_ms=${dispatchQueueDelayMs} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
      );
    }).catch((error) => {
      logger.error(
        `automation task failed to start task=${task.taskId} queue_delay_ms=${dispatchQueueDelayMs} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}:`,
        error,
      );
    }).finally(() => {
      runningAutomationTasks.delete(key);
      logger.info(
        `automation scheduler release task=${task.taskId} active=${runningAutomationTasks.size} rss_bytes=${rssBytes()}`,
      );
    });
  }
  return { due: due.length, started };
}


export async function startAutomationScheduler() {
  stopAutomationScheduler();
  await runAutomationSchedulerTick().catch((error) => logger.error("自动化任务首次扫描失败:", error));
  automationIntervalId = setInterval(() => {
    runAutomationSchedulerTick().catch((error) => logger.error("自动化任务扫描失败:", error));
  }, 60_000);
  automationIntervalId.unref?.();
}

export function stopAutomationScheduler() {
  if (automationIntervalId !== null) clearInterval(automationIntervalId);
  automationIntervalId = null;
  runningAutomationTasks.clear();
}

export const __test__ = { runningAutomationTasks };
