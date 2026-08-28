#!/usr/bin/env node
/**
 * One-time fix (2026-08-28): the 2026-08-17 preferences→tasks migration
 * hardcoded every market-watch task to delivery=wechat_on_condition,
 * silently overriding each user's onboarding choice (active_watch =
 * push_mode "scheduled_intraday_brief", only_push_on_exception=false).
 *
 * This restores wechat_summary (push every window) for every
 * scheduled-market-watch task and swaps the instruction to a
 * must-include-live-data variant without the NO_PUSH clause (under
 * wechat_summary the service pushes unconditionally, so a literal NO_PUSH
 * summary would be delivered as-is).
 *
 * Tasks that were already paused stay paused; active tasks are re-activated
 * after the revision bump. Idempotent: tasks already on wechat_summary are
 * skipped. Usage: node scripts/fix-market-watch-delivery.mjs [--dry-run]
 */
process.env.WORKSPACE_BACKEND ??= "mastra";
const dryRun = process.argv.includes("--dry-run");

const INSTRUCTION = [
  "你正在生成当前用户的盘中定时简报。",
  "market-watch 是盘中定时简报/摘要任务，不是明确规则巡检；明确规则巡检只由规则巡检机制执行。",
  "行情事实必须来自实时数据：使用外部 market-data MCP 工具（如实时行情、市场总览、资金流）获取当前时点数据；没有实时数据时明确说明数据缺口，不得用过期数据充当当日行情。",
  "本任务按用户设置的盘中简报时间到点推送：每轮直接输出面向用户的当期简报正文（适合微信阅读的简洁 Markdown，不使用表格），不要输出 NO_PUSH；行情数据缺失时如实说明缺口并照常推送。",
].join("\n");

const { initDb, sqlite } = await import("../dist/db/index.js");
initDb();
const { updateAutomationTask, activateAutomationTask } = await import("../dist/services/automation-tasks.js");

const rows = sqlite.prepare(`
  SELECT task_id, user_id, project_id, instance_id, status, current_revision_id
  FROM automation_tasks WHERE task_type = 'scheduled-market-watch'
`).all();

let fixed = 0, skipped = 0;
for (const row of rows) {
  const rev = sqlite.prepare("SELECT revision, delivery_json FROM automation_task_revisions WHERE revision_id = ?").get(row.current_revision_id);
  const delivery = JSON.parse(rev?.delivery_json || "{}");
  if (delivery.mode === "wechat_summary") {
    console.log(`skip (already wechat_summary) task=${row.task_id} user=${row.user_id} status=${row.status}`);
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(`dry-run would update task=${row.task_id} user=${row.user_id} ${delivery.mode} -> wechat_summary (was ${row.status})`);
    continue;
  }
  const updated = await updateAutomationTask({
    userId: row.user_id,
    projectId: row.project_id,
    instanceId: row.instance_id,
    taskId: row.task_id,
    delivery: { mode: "wechat_summary" },
    instruction: INSTRUCTION,
  });
  // updateAutomationTask leaves the task paused; only re-activate tasks the
  // user had left active, so an intentionally paused task stays paused.
  if (row.status === "active") {
    await activateAutomationTask({ userId: row.user_id, projectId: row.project_id, instanceId: row.instance_id, taskId: row.task_id });
  }
  console.log(`updated task=${row.task_id} user=${row.user_id} revision=${updated.currentRevision} restored_status=${row.status}`);
  fixed += 1;
}
console.log(`done: fixed=${fixed} skipped=${skipped}${dryRun ? " (dry-run)" : ""}`);
