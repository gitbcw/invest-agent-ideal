#!/usr/bin/env node
/**
 * One-time idempotent migration: materialize review/market-watch preference
 * schedules as typed automation tasks (design doc P4). Preferences are left
 * in place as compat fallback; the scheduler skip rules make active typed
 * tasks authoritative. Re-running skips scopes that already own typed tasks.
 *
 * Usage: node scripts/mastra-preferences-to-tasks-migration.mjs [--dry-run]
 */
import { randomUUID } from "node:crypto";

const dryRun = process.argv.includes("--dry-run");
process.env.WORKSPACE_BACKEND ??= "mastra";
const { initDb, sqlite } = await import("../src/db/index.js");
initDb();
const { createAutomationTask, activateAutomationTask } = await import("../src/services/automation-tasks.js");
const { getScheduledTaskType } = await import("../src/services/scheduled-task-types.js");

const TEMPLATES = [
  { key: "daily_review", taskType: "scheduled-daily-review", frequency: (s) => (s.trading_days_only === false ? "daily" : "trading_days"), time: (s) => s.default_time ?? "19:00" },
  { key: "weekly_review", taskType: "scheduled-weekly-review", frequency: () => "weekly", time: (s) => (s.default_time ?? "Saturday 09:00").split(" ")[1] ?? "09:00" },
  { key: "monthly_review", taskType: "scheduled-monthly-review", frequency: () => "monthly", time: (s) => (s.default_time ?? "day_1 09:00").split(" ")[1] ?? "09:00", monthlyDay: (s) => Number((s.default_time ?? "day_1 09:00").match(/day_(\d+)/)?.[1] ?? 1) },
  { key: "market_watch", taskType: "scheduled-market-watch", frequency: () => "trading_days", time: (s) => (s.default_windows ?? ["14:30"]).at(-1), windows: (s) => s.default_windows ?? ["14:30"] },
];

const rows = sqlite.prepare("SELECT user_id, project_id, instance_id, preferences_json FROM mastra_runtime_preferences").all();
let created = 0, skipped = 0;
for (const row of rows) {
  let schedules = {};
  try { schedules = JSON.parse(row.preferences_json || "{}").schedules ?? {}; } catch { continue; }
  for (const template of TEMPLATES) {
    const section = schedules[template.key];
    if (!section || section.enabled === false || section.auto_run === false) continue;
    const exists = sqlite.prepare("SELECT 1 AS one FROM automation_tasks WHERE user_id=? AND project_id=? AND instance_id=? AND task_type=? LIMIT 1").get(row.user_id, row.project_id, row.instance_id, template.taskType);
    if (exists) { skipped += 1; continue; }
    const definition = getScheduledTaskType(template.taskType);
    const schedule = {
      frequency: template.frequency(section),
      time: template.time(section),
      timezone: schedules.timezone ?? "Asia/Shanghai",
      ...(template.monthlyDay ? { monthlyDay: template.monthlyDay(section) } : {}),
      ...(template.windows ? { windows: template.windows(section) } : {}),
      ...(template.taskType === "scheduled-weekly-review" ? { weekdays: [6] } : {}),
    };
    if (dryRun) { console.log(`[dry-run] would create ${template.taskType} for ${row.user_id}/${row.instance_id}: ${JSON.stringify(schedule)}`); continue; }
    const task = await createAutomationTask({
      userId: row.user_id, projectId: row.project_id, instanceId: row.instance_id,
      taskId: `migrated_${template.taskType}_${randomUUID().slice(0, 8)}`,
      name: definition.name, description: `偏好迁移 · ${definition.description}`,
      taskType: template.taskType, schedule, instruction: definition.defaultInstruction,
      output: { mode: "none" },
      delivery: template.taskType === "scheduled-market-watch" ? { mode: "wechat_on_condition", conditionVersion: 1 } : { mode: "none" },
    });
    await activateAutomationTask({ userId: row.user_id, projectId: row.project_id, instanceId: row.instance_id, taskId: task.taskId });
    created += 1;
    console.log(`created ${template.taskType} task=${task.taskId} for ${row.user_id}/${row.instance_id}`);
  }
}
console.log(`migration done: created=${created} skipped=${skipped}${dryRun ? " (dry-run)" : ""}`);
