import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("applying the low-disturbance preset creates typed tasks and compat preferences", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-preset-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.MASTRA_PROJECTS_ROOT = path.join(tempRoot, "projects");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { applyPreset, getPreset } = await import("../src/services/presets.js");
    const { nextAutomationRunAt } = await import("../src/services/automation-tasks.js");
    const { MastraUserPreferenceStore } = await import("../src/services/user-preferences.js");

    initDb();
    const scope = { userId: "preset-user", projectId: "invest-agent", instanceId: "invest-agent-preset-user" };

    const result = await applyPreset(scope, "low-disturbance-review");
    assert.equal(result.presetId, "low-disturbance-review");
    assert.equal(result.created.length, 4);
    assert.deepEqual(result.skipped, []);

    // Four typed tasks exist; review tasks activate (P2 executor live) while
    // market-watch stays paused until its executor lands (P3).
    const rows = sqlite.prepare("SELECT task_id AS taskId, task_type AS taskType, status FROM automation_tasks WHERE user_id=? ORDER BY task_id").all(scope.userId) as Array<{ taskId: string; taskType: string; status: string }>;
    assert.equal(rows.length, 4);
    const byType = new Map(rows.map((row) => [row.taskType, row.status]));
    assert.equal(byType.get("scheduled-daily-review"), "active");
    assert.equal(byType.get("scheduled-weekly-review"), "active");
    assert.equal(byType.get("scheduled-monthly-review"), "active");
    assert.equal(byType.get("scheduled-market-watch"), "active");
    assert.deepEqual(rows.map((row) => row.taskType).sort(), ["scheduled-daily-review", "scheduled-market-watch", "scheduled-monthly-review", "scheduled-weekly-review"]);

    const revisions = sqlite.prepare("SELECT schedule_json AS scheduleJson FROM automation_task_revisions WHERE task_id LIKE 'preset_%'").all() as Array<{ scheduleJson: string }>;
    const monthlySchedule = revisions.map((row) => JSON.parse(row.scheduleJson)).find((schedule) => schedule.frequency === "monthly");
    assert.equal(monthlySchedule?.monthlyDay, 1);
    const marketWatchSchedule = JSON.parse(sqlite.prepare("SELECT schedule_json AS s FROM automation_task_revisions r JOIN automation_tasks t ON t.task_id=r.task_id WHERE t.task_type='scheduled-market-watch'").get().s);
    assert.deepEqual(marketWatchSchedule.windows, ["09:55", "11:20", "14:30"]);

    // Re-applying skips existing tasks and does not duplicate.
    const second = await applyPreset(scope, "low-disturbance-review");
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 4);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS c FROM automation_tasks WHERE user_id=?").get(scope.userId).c, 4);

    // P4b: applyPreset no longer mirrors scheduling into runtime
    // preferences — tasks are the only schedule source.
    const store = new MastraUserPreferenceStore(scope.userId, scope.instanceId, scope.projectId);
    const schedules = await store.readSchedules() as Record<string, unknown>;
    assert.equal(schedules.daily_review, undefined);
    assert.equal(schedules.market_watch, undefined);

    // Schedule math: monthly lands on monthlyDay; windows expand trigger times.
    const monthlyNext = nextAutomationRunAt({ frequency: "monthly", time: "09:00", timezone: "Asia/Shanghai", monthlyDay: 1 }, new Date("2026-08-14T00:00:00Z"));
    assert.equal(new Date(monthlyNext).toISOString().slice(0, 10), "2026-09-01");
    const windowsNext = nextAutomationRunAt({ frequency: "trading_days", time: "14:30", timezone: "Asia/Shanghai", windows: ["09:55", "11:20", "14:30"] }, new Date("2026-08-13T01:00:00Z"));
    const windowsNextDate = new Date(windowsNext);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(windowsNextDate);
    assert.equal(parts, "09:55");

    // Unknown preset fails closed.
    assert.throws(() => getPreset("no-such-preset"), /PRESET_UNKNOWN/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
