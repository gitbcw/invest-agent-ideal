import { randomUUID } from "node:crypto";
import { sqlite } from "../db/index.js";
import { classifyTaskError, isPastDeadline, resolveTaskTiming, type TaskErrorCategory } from "./task-execution.js";

export type ConversationTaskRunStatus = "running" | "succeeded" | "failed" | "expired";

export interface ConversationTaskScope {
  userId: string;
  projectId: string;
  instanceId: string;
}

export interface ConversationTaskRun extends ConversationTaskScope {
  runId: string;
  conversationId: string;
  requestId: string;
  channel: "web" | "weixin-mobile";
  status: ConversationTaskRunStatus;
  attempt: number;
  responseDeadlineAt: string;
  executionDeadlineAt: string;
  errorCategory?: TaskErrorCategory | null;
  retryable?: boolean | null;
  resultMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string | null;
}

export function createConversationTaskRun(input: ConversationTaskScope & {
  conversationId: string;
  requestId: string;
  channel: ConversationTaskRun["channel"];
  responseBudgetMs?: number;
  executionBudgetMs?: number;
}): ConversationTaskRun {
  const timing = resolveTaskTiming({ responseBudgetMs: input.responseBudgetMs, executionBudgetMs: input.executionBudgetMs });
  const run: ConversationTaskRun = {
    ...input,
    runId: `ctrun_${randomUUID()}`,
    status: "running",
    attempt: 1,
    responseDeadlineAt: timing.responseDeadlineAt,
    executionDeadlineAt: timing.executionDeadlineAt,
    createdAt: timing.acceptedAt,
    updatedAt: timing.acceptedAt,
  };
  sqlite.prepare(`
    INSERT INTO conversation_task_runs (
      run_id, user_id, project_id, instance_id, conversation_id, request_id, channel,
      status, attempt, response_deadline_at, execution_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId, run.userId, run.projectId, run.instanceId, run.conversationId, run.requestId, run.channel,
    run.status, run.attempt, run.responseDeadlineAt, run.executionDeadlineAt, run.createdAt, run.updatedAt,
  );
  return run;
}

export function retryConversationTaskRun(input: ConversationTaskScope & { runId: string; error: unknown; maxAttempts?: number }): ConversationTaskRun | null {
  const current = getConversationTaskRun(input);
  const error = classifyTaskError(input.error);
  const maxAttempts = input.maxAttempts ?? 2;
  if (!current || current.status !== "running" || !error.retryable || isPastDeadline(current.executionDeadlineAt) || current.attempt >= maxAttempts) return null;
  sqlite.prepare(`
    UPDATE conversation_task_runs
    SET attempt = ?, error_category = ?, retryable = 1, updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
  `).run(current.attempt + 1, error.category, new Date().toISOString(), input.runId, input.userId, input.projectId, input.instanceId);
  return getConversationTaskRun(input);
}

export function finishConversationTaskRun(input: ConversationTaskScope & {
  runId: string;
  status: Exclude<ConversationTaskRunStatus, "running">;
  resultMessageId?: string;
  error?: unknown;
}): ConversationTaskRun | null {
  const current = getConversationTaskRun(input);
  if (!current || current.status !== "running") return current;
  const now = new Date();
  const expired = isPastDeadline(current.executionDeadlineAt, now);
  const classified = input.error ? classifyTaskError(input.error) : null;
  const status = expired ? "expired" : input.status;
  const errorCategory = expired ? "expired" : classified?.category ?? null;
  const retryable = expired ? false : classified?.retryable ?? null;
  sqlite.prepare(`
    UPDATE conversation_task_runs
    SET status = ?, error_category = ?, retryable = ?, result_message_id = ?, finished_at = ?, updated_at = ?
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ? AND status = 'running'
  `).run(
    status, errorCategory, retryable === null ? null : (retryable ? 1 : 0), input.resultMessageId ?? null,
    now.toISOString(), now.toISOString(), input.runId, input.userId, input.projectId, input.instanceId,
  );
  return getConversationTaskRun(input);
}

export function getConversationTaskRun(input: ConversationTaskScope & { runId: string }): ConversationTaskRun | null {
  const row = sqlite.prepare(`
    SELECT run_id AS runId, user_id AS userId, project_id AS projectId, instance_id AS instanceId,
      conversation_id AS conversationId, request_id AS requestId, channel, status, attempt,
      response_deadline_at AS responseDeadlineAt, execution_deadline_at AS executionDeadlineAt,
      error_category AS errorCategory, retryable, result_message_id AS resultMessageId,
      created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
    FROM conversation_task_runs
    WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
  `).get(input.runId, input.userId, input.projectId, input.instanceId) as ConversationTaskRun | undefined;
  return row ? { ...row, retryable: row.retryable === null ? null : Boolean(row.retryable) } : null;
}

/** A process restart cannot resume an in-flight ACP turn safely. Close it with a durable terminal state. */
export function recoverInterruptedConversationTaskRuns(now = new Date()): number {
  const timestamp = now.toISOString();
  const result = sqlite.prepare(`
    UPDATE conversation_task_runs
    SET status = CASE WHEN execution_deadline_at <= ? THEN 'expired' ELSE 'failed' END,
      error_category = CASE WHEN execution_deadline_at <= ? THEN 'expired' ELSE 'transient' END,
      retryable = 0, finished_at = ?, updated_at = ?
    WHERE status = 'running'
  `).run(timestamp, timestamp, timestamp, timestamp);
  return result.changes;
}
