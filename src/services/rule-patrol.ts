import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { runAlertCheck } from "../scheduler/alert-check.js";
import type { AutomationScope } from "./automation-tasks.js";

/**
 * E9 v2 / G21: dedicated rule-patrol surface. Rule inspection is deliberately
 * not an automation task (D19 — event-driven evaluation, not rhythmic work);
 * this service exposes its state and scheduled_task_runs history through
 * dedicated connector commands for the Portal patrol page.
 */

export interface RulePatrolRunView {
  runId: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  scheduledFor: string;
  claimedAt: string;
  finishedAt: string | null;
  resultSummary: string | null;
  errorMessage: string | null;
  pushed: boolean;
  attempt: number;
  createdAt: string;
}

export interface RulePatrolStatus {
  rulesTotal: number;
  rulesEnabled: number;
  latestRun: RulePatrolRunView | null;
  /** Patrol cadence during trading hours (from scheduler settings, default 5min). */
  intervalMinutes: number;
}

function mapStatus(status: string): RulePatrolRunView["status"] {
  if (status === "claimed") return "running";
  if (status === "success") return "succeeded";
  if (status === "error") return "failed";
  return "skipped";
}

function patrolIntervalMinutes(): number {
  try {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'alert_check_interval_minutes'").get() as { value: string | number } | undefined;
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.round(parsed) : 5;
  } catch {
    return 5;
  }
}

interface PatrolRunRow {
  task_key: string; status: string; scheduled_for: string; claimed_at: string;
  finished_at: string | null; error_message: string | null; push_job_id: string | null;
  attempt: number; created_at: string;
}

function rowToRunView(row: PatrolRunRow): RulePatrolRunView {
  return {
    runId: row.task_key,
    status: mapStatus(row.status),
    scheduledFor: row.scheduled_for,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    resultSummary: row.status === "skipped" ? "无命中" : row.status === "success" ? "命中并推送" : null,
    errorMessage: row.error_message,
    pushed: Boolean(row.push_job_id),
    attempt: row.attempt,
    createdAt: row.created_at,
  };
}

const RUN_COLUMNS = "task_key, status, task_key, status, scheduled_for, claimed_at, finished_at, error_message, push_job_id, attempts AS attempt, created_at";

export function getRulePatrolStatus(scope: AutomationScope): RulePatrolStatus {
  const counts = sqlite.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled FROM alert_rules WHERE user_id = ? AND instance_id = ?",
  ).get(scope.userId, scope.instanceId) as { total: number; enabled: number };
  const latest = sqlite.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM scheduled_task_runs
    WHERE user_id = ? AND project_id = ? AND instance_id = ? AND task_type = 'rule-alert-check'
    ORDER BY created_at DESC, task_key DESC LIMIT 1
  `).get(scope.userId, scope.projectId, scope.instanceId) as PatrolRunRow | undefined;
  return {
    rulesTotal: counts.total,
    rulesEnabled: counts.enabled,
    latestRun: latest ? rowToRunView(latest) : null,
    intervalMinutes: patrolIntervalMinutes(),
  };
}

export function listRulePatrolRuns(scope: AutomationScope, limit = 20): RulePatrolRunView[] {
  const bounded = Math.max(1, Math.min(Math.round(limit), 100));
  const rows = sqlite.prepare(`
    SELECT ${RUN_COLUMNS}
    FROM scheduled_task_runs
    WHERE user_id = ? AND project_id = ? AND instance_id = ? AND task_type = 'rule-alert-check'
    ORDER BY created_at DESC, task_key DESC
    LIMIT ?
  `).all(scope.userId, scope.projectId, scope.instanceId, bounded) as PatrolRunRow[];
  return rows.map(rowToRunView);
}

export interface RulePatrolRunNowResult {
  ranAt: string;
  /** Alerts hit by this manual patrol; manual patrols never push. */
  items: Array<{ stockCode: string; stockName: string; message: string; severity: string }>;
  error?: string;
}

/** Manual patrol from the Portal page: evaluate rules now, never push. */
export async function runRulePatrolNow(scope: AutomationScope): Promise<RulePatrolRunNowResult> {
  const ranAt = new Date().toISOString();
  try {
    const items = await runAlertCheck({ force: true, userId: scope.userId, instanceId: scope.instanceId });
    return {
      ranAt,
      items: items.map((item) => ({
        stockCode: item.stockCode,
        stockName: item.stockName,
        message: item.message,
        severity: item.severity,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`rule patrol manual run failed user=${scope.userId} instance=${scope.instanceId}: ${message}`);
    return { ranAt, items: [], error: message };
  }
}
