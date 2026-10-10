import { sqlite } from "../db/index.js";

import { listAttentionItems, type AttentionItemView } from "./attention-items.js";

/**
 * T-539 定时任务详情聚合读模型（设计 §6 四块）：
 * 目标 / 依赖与产物 / 最近结果（执行·产物·投递分层）/ 需要注意。
 * 只读组装，不复制既有事实；scope 强制在每个查询上。
 */

type Scope = { userId: string; projectId: string; instanceId: string };

export interface AutomationTaskDetail {
  goal: { name: string; description: string | null; frequency: string | null; deliveryMode: string | null };
  dependencies: Array<{
    kind: string;
    refId: string;
    versionPolicy: string;
    pinnedVersionId: string | null;
    displayName: string | null;
  }>;
  recentRuns: Array<{
    runId: string;
    status: string;
    origin: string;
    startedAt: string | null;
    finishedAt: string | null;
    errorCategory: string | null;
    artifacts: string[];
    deliveries: Array<{ kind: string; status: string; at: string | null }>;
  }>;
  attention: AttentionItemView[];
}

export function getAutomationTaskDetail(scope: Scope, taskId: string, options: { recentRuns?: number } = {}): AutomationTaskDetail | null {
  const task = sqlite
    .prepare(
      `SELECT t.task_id, t.status, r.name, r.description, r.schedule_json, r.output_json
       FROM automation_tasks t
       LEFT JOIN automation_task_revisions r ON r.revision_id = t.current_revision_id
       WHERE t.task_id = ? AND t.user_id = ? AND t.project_id = ? AND t.instance_id = ?`,
    )
    .get(taskId, scope.userId, scope.projectId, scope.instanceId) as
    | { task_id: string; name: string; description: string | null; schedule_json: string; output_json: string }
    | undefined;
  if (!task) return null;

  let frequency: string | null = null;
  let deliveryMode: string | null = null;
  try {
    const schedule = task.schedule_json ? (JSON.parse(task.schedule_json) as { frequency?: string }) : null;
    frequency = schedule?.frequency ?? null;
  } catch { /* keep null */ }
  try {
    const output = task.output_json ? (JSON.parse(task.output_json) as { mode?: string }) : null;
    deliveryMode = output?.mode ?? null;
  } catch { /* keep null */ }

  const dependencies = (
    sqlite
      .prepare(
        `SELECT d.kind, d.ref_id, d.version_policy, d.pinned_version_id,
                CASE d.kind
                  WHEN 'method' THEN (SELECT m.name FROM agent_space_methods m WHERE m.method_id = d.ref_id)
                  WHEN 'skill' THEN (SELECT s.name FROM agent_space_skills s WHERE s.skill_id = d.ref_id)
                  WHEN 'asset' THEN (SELECT a.name FROM user_assets a WHERE a.asset_id = d.ref_id)
                  ELSE NULL END AS display_name
         FROM agent_space_task_dependencies d
         WHERE d.task_id = ? AND d.user_id = ? AND d.project_id = ? AND d.instance_id = ?
         ORDER BY d.created_at ASC`,
      )
      .all(taskId, scope.userId, scope.projectId, scope.instanceId) as Array<{
        kind: string;
        ref_id: string;
        version_policy: string;
        pinned_version_id: string | null;
        display_name: string | null;
      }>
  ).map((d) => ({
    kind: d.kind,
    refId: d.ref_id,
    versionPolicy: d.version_policy,
    pinnedVersionId: d.pinned_version_id,
    displayName: d.display_name,
  }));

  const runs = sqlite
    .prepare(
      `SELECT run_id, status, origin, started_at, finished_at, error_category
       FROM automation_task_runs
       WHERE task_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(taskId, scope.userId, scope.projectId, scope.instanceId, options.recentRuns ?? 10) as Array<{
      run_id: string;
      status: string;
      origin: string;
      started_at: string | null;
      finished_at: string | null;
      error_category: string | null;
    }>;

  const recentRuns = runs.map((run) => {
    // 分层事实：产物（run outcomes kind=artifact*/output）与投递（push_jobs per run/task）
    const outcomes = sqlite
      .prepare(
        `SELECT kind, detail_json FROM agent_space_run_outcomes
         WHERE run_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?`,
      )
      .all(run.run_id, scope.userId, scope.projectId, scope.instanceId) as Array<{ kind: string; detail_json: string | null }>;
    const artifacts = outcomes
      .filter((o) => o.kind === "artifact" || o.kind === "output")
      .map((o) => {
        try {
          const detail = o.detail_json ? (JSON.parse(o.detail_json) as { assetId?: string; name?: string }) : {};
          return detail.name || detail.assetId || o.kind;
        } catch {
          return o.kind;
        }
      });
    const deliveries = (
      sqlite
        .prepare(
          `SELECT message_kind, status, created_at FROM push_jobs
           WHERE origin_task_key = ? AND user_id = ?
           ORDER BY created_at DESC LIMIT 3`,
        )
        .all(taskId, scope.userId) as Array<{ message_kind: string; status: string; created_at: string }>
    ).map((job) => ({ kind: job.message_kind, status: job.status, at: job.created_at }));
    return {
      runId: run.run_id,
      status: run.status,
      origin: run.origin,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      errorCategory: run.error_category,
      artifacts,
      deliveries,
    };
  });

  const attention = listAttentionItems(scope, { status: "open", limit: 20 }).filter((item) => item.taskId === taskId);

  return {
    goal: { name: task.name || taskId, description: task.description, frequency, deliveryMode },
    dependencies,
    recentRuns,
    attention,
  };
}
