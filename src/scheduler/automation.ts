import { logger } from "../lib/logger.js";
import { listDueAutomationTasks } from "../services/automation-tasks.js";
import { runAutomationTaskNow } from "../services/automation-runner.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { sqlite } from "../db/index.js";

let automationIntervalId: ReturnType<typeof setInterval> | null = null;
const runningAutomationTasks = new Set<string>();

export interface AutomationSchedulerDependencies {
  listDueAutomationTasks: typeof listDueAutomationTasks;
  runAutomationTaskNow: typeof runAutomationTaskNow;
}

const defaultDependencies: AutomationSchedulerDependencies = { listDueAutomationTasks, runAutomationTaskNow };

/**
 * Scan and dispatch due tasks. Dependencies are injectable for deterministic
 * node:test coverage; production callers keep the same one-argument API.
 */
export async function runAutomationSchedulerTick(now = new Date(), dependencies: AutomationSchedulerDependencies = defaultDependencies) {
  const due = await dependencies.listDueAutomationTasks(now, 100);
  let started = 0;
  for (const task of due) {
    if (ACTIVE_BACKEND === "mastra" && !isMastraSchedulerEnabled(task.userId, task.projectId, task.instanceId)) {
      logger.info(`automation task disabled by Mastra scheduler activation task=${task.taskId} user=${task.userId} instance=${task.instanceId}`);
      continue;
    }
    const key = `${task.userId}:${task.instanceId}:${task.taskId}:${task.currentRevisionId}`;
    if (runningAutomationTasks.has(key)) continue;
    runningAutomationTasks.add(key);
    started += 1;
    const scheduledFor = task.nextRunAt || now.toISOString();
    const idempotencyKey = `${task.taskId}:${task.currentRevisionId}:${scheduledFor}`;
    void dependencies.runAutomationTaskNow({
      scope: { userId: task.userId, instanceId: task.instanceId, projectId: task.projectId },
      taskId: task.taskId,
      origin: "scheduled",
      scheduledFor,
      idempotencyKey,
    }).then((result) => {
      logger.info(`automation task finished task=${task.taskId} revision=${task.currentRevisionId} run=${result.run.runId} status=${result.run.status}`);
    }).catch((error) => {
      logger.error(`automation task failed to start task=${task.taskId}:`, error);
    }).finally(() => {
      runningAutomationTasks.delete(key);
    });
  }
  return { due: due.length, started };
}

function isMastraSchedulerEnabled(userId: string, projectId: string, instanceId: string): boolean {
  const row = sqlite.prepare(
    "SELECT preferences_json AS preferencesJson FROM mastra_runtime_preferences WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
  ).get(userId, projectId, instanceId) as { preferencesJson?: string } | undefined;
  try {
    return JSON.parse(row?.preferencesJson || "{}").schedulerActivation === "enabled";
  } catch {
    return false;
  }
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
