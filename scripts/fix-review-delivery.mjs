#!/usr/bin/env node
/**
 * One-time fix (2026-09-11): the 2026-08-17 preferences→tasks migration set
 * every scheduled review task's delivery to {mode:"none"} while market-watch
 * got wechat_summary — review briefs have never been pushed since (last
 * successful daily_review push: mg/111=8-12, dyk=8-14). Restores
 * wechat_summary with per-kind business validity mirroring
 * scheduled-message-policy.ts expiry semantics (daily: next trading morning
 * ~08:00-08:20 hard stop under the policy's 08:30 boundary; weekly Saturday
 * 09:00 -> next trading day 09:00 = 48h; monthly 1st 09:00 -> +72h).
 *
 * Archived tasks are skipped (updateAutomationTask rejects them); tasks that
 * were active are re-activated after the revision bump, paused ones stay
 * paused. Idempotent: tasks already on wechat_summary are skipped.
 * Usage: node scripts/fix-review-delivery.mjs [--dry-run]
 */
process.env.WORKSPACE_BACKEND ??= "mastra";
const dryRun = process.argv.includes("--dry-run");

const VALIDITY_MINUTES = {
  "scheduled-daily-review": 780,
  "scheduled-weekly-review": 2880,
  "scheduled-monthly-review": 4320,
};

const { initDb, sqlite } = await import("../dist/db/index.js");
initDb();
const { updateAutomationTask, activateAutomationTask } = await import("../dist/services/automation-tasks.js");

const rows = sqlite.prepare(`
  SELECT task_id, task_type, user_id, project_id, instance_id, status, current_revision_id
  FROM automation_tasks
  WHERE task_type IN ('scheduled-daily-review','scheduled-weekly-review','scheduled-monthly-review')
`).all();

let fixed = 0, skipped = 0;
for (const row of rows) {
  if (row.status === "archived") {
    console.log(`skip (archived) task=${row.task_id} user=${row.user_id}`);
    skipped += 1;
    continue;
  }
  const rev = sqlite.prepare("SELECT revision, delivery_json FROM automation_task_revisions WHERE revision_id = ?").get(row.current_revision_id);
  const delivery = JSON.parse(rev?.delivery_json || "{}");
  if (delivery.mode === "wechat_summary") {
    console.log(`skip (already wechat_summary) task=${row.task_id} user=${row.user_id} status=${row.status}`);
    skipped += 1;
    continue;
  }
  const target = { mode: "wechat_summary", validityMinutes: VALIDITY_MINUTES[row.task_type] };
  if (dryRun) {
    console.log(`dry-run would update task=${row.task_id} user=${row.user_id} ${JSON.stringify(delivery)} -> ${JSON.stringify(target)} (was ${row.status})`);
    continue;
  }
  const updated = await updateAutomationTask({
    userId: row.user_id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    taskId: row.task_id,
    delivery: target,
    editSource: "script",
    editSourceRef: "fix-review-delivery-20260911",
  });
  // updateAutomationTask leaves the task paused; only re-activate tasks the
  // user had left active, so an intentionally paused task stays paused.
  if (row.status === "active") {
    await activateAutomationTask({ userId: row.user_id, projectId: row.project_id, instanceId: row.instance_id, taskId: row.task_id });
  }
  console.log(`updated task=${row.task_id} user=${row.user_id} revision=${updated.currentRevision} restored_status=${row.status} delivery=${JSON.stringify(target)}`);
  fixed += 1;
}
console.log(`done: fixed=${fixed} skipped=${skipped}${dryRun ? " (dry-run)" : ""}`);
