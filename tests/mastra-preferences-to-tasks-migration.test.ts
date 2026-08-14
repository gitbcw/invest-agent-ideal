import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
process.env.WORKSPACE_BACKEND = "mastra";

test("preferences-to-tasks migration is idempotent and preserves user times", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-pref-migration-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.MASTRA_PROJECTS_ROOT = path.join(tempRoot, "projects");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    initDb();
    const now = new Date().toISOString();
    sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("mig-user", "invest-agent", "invest-agent-mig-user", JSON.stringify({
        schedules: {
          timezone: "Asia/Shanghai",
          daily_review: { enabled: true, auto_run: true, default_time: "20:30" },
          monthly_review: { enabled: true, auto_run: true, default_time: "day_2 08:15" },
          market_watch: { enabled: true, auto_run: true, default_windows: ["10:00", "14:00"] },
        },
      }), "{}", "test", "test", now, now);

    const run = () => execFileAsync(process.execPath, ["--import", "tsx", "scripts/mastra-preferences-to-tasks-migration.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    const first = await run();
    assert.match(first.stdout, /created=3 skipped=0/);

    const rows = sqlite.prepare("SELECT task_type AS taskType, status FROM automation_tasks WHERE user_id='mig-user'").all() as Array<{ taskType: string; status: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === "active"));
    const daily = JSON.parse(sqlite.prepare("SELECT schedule_json AS s FROM automation_task_revisions r JOIN automation_tasks t ON t.task_id=r.task_id WHERE t.task_type='scheduled-daily-review'").get().s);
    assert.equal(daily.time, "20:30");
    const monthly = JSON.parse(sqlite.prepare("SELECT schedule_json AS s FROM automation_task_revisions r JOIN automation_tasks t ON t.task_id=r.task_id WHERE t.task_type='scheduled-monthly-review'").get().s);
    assert.equal(monthly.monthlyDay, 2);
    assert.equal(monthly.time, "08:15");
    const watch = JSON.parse(sqlite.prepare("SELECT schedule_json AS s FROM automation_task_revisions r JOIN automation_tasks t ON t.task_id=r.task_id WHERE t.task_type='scheduled-market-watch'").get().s);
    assert.deepEqual(watch.windows, ["10:00", "14:00"]);

    // Idempotent: re-run creates nothing.
    const second = await run();
    assert.match(second.stdout, /created=0 skipped=3/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
