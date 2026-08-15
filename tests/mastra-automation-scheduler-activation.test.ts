import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-automation-activation-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(root, "legacy-workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("P4b: automation scheduler dispatches due tasks regardless of schedulerActivation (gate retired)", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const scheduler = await import("../src/scheduler/automation.js");
  const scope = { userId: "automation-scheduler-user", projectId: "invest-agent", instanceId: "automation-scheduler-instance" };
  const dueTask = {
    taskId: "automation-disabled-task",
    userId: scope.userId,
    projectId: scope.projectId,
    instanceId: scope.instanceId,
    currentRevisionId: "revision-1",
    nextRunAt: "2026-08-13T07:30:00.000Z",
  } as never;
  const now = new Date("2026-08-13T07:31:00.000Z");
  const prefs = (activation: string) => sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,project_id,instance_id) DO UPDATE SET preferences_json=excluded.preferences_json").run(scope.userId, scope.projectId, scope.instanceId, JSON.stringify({ schedulerActivation: activation }), "{}", "test", "test", now.toISOString(), now.toISOString());
  const calls: unknown[] = [];
  const dependencies = {
    listDueAutomationTasks: async () => [dueTask],
    runAutomationTaskNow: async (input: unknown) => { calls.push(input); return { run: { runId: "run-1", status: "succeeded" }, task: dueTask } as never; },
  } as scheduler.AutomationSchedulerDependencies;

  // The preference field is inert: due tasks dispatch whether the legacy
  // schedulerActivation value is missing, disabled-named, or enabled.
  prefs("disabled_until_target_cold_start_and_explicit_enable");
  assert.deepEqual(await scheduler.runAutomationSchedulerTick(now, dependencies), { due: 1, started: 1 });
  assert.equal(calls.length, 1);
  // flush the in-flight run so the second tick with the same key dispatches
  await new Promise((resolve) => setImmediate(resolve));
  prefs("enabled");
  assert.deepEqual(await scheduler.runAutomationSchedulerTick(now, dependencies), { due: 1, started: 1 });
  assert.equal(calls.length, 2);
  await new Promise((resolve) => setImmediate(resolve));
});
