#!/usr/bin/env node
/** 一次性/可重复修复：为镜像里 active 但 next_run_at 为 NULL 的定时任务重算
 * 下一个未来执行时刻（2026-10-08 镜像定性：导入脚本清空 next_run_at 后无自愈
 * 路径，调度器只扫非空行，任务永久哑火——镜像里测不到任何定时产出）。
 * 幂等：只改 active 且为空的行；已有值不覆盖。 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(process.env.MIRROR_ROOT ?? path.join(REPO_ROOT, ".state", "production-mirror"));
process.env.DB_PATH = path.join(mirrorRoot, "runtime.db");

const dbModule = await import("../../../src/db/index.ts");
const { sqlite } = dbModule.default ?? dbModule;
const { nextAutomationRunAt } = await import("../../../src/services/automation-tasks.ts");

const rows = sqlite.prepare(`
  SELECT t.task_id, t.user_id, t.project_id, t.instance_id, t.status, r.schedule_json
  FROM automation_tasks t
  JOIN automation_task_revisions r ON r.revision_id = t.current_revision_id
  WHERE t.status = 'active' AND t.next_run_at IS NULL`).all();
const now = new Date();
const results = [];
for (const row of rows) {
  try {
    const next = nextAutomationRunAt(JSON.parse(row.schedule_json), now);
    const updated = sqlite.prepare(
      "UPDATE automation_tasks SET next_run_at=?, updated_at=? WHERE task_id=? AND status='active' AND next_run_at IS NULL",
    ).run(next, now.toISOString(), row.task_id);
    results.push({ task: row.task_id, user: row.user_id, nextRunAt: updated.changes > 0 ? next : "race-skipped" });
  } catch (error) {
    results.push({ task: row.task_id, user: row.user_id, error: String(error?.message ?? error) });
  }
}
console.log(JSON.stringify({ scanned: rows.length, results }, null, 1));
sqlite.close();
