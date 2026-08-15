import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-scheduler-activation-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(root, "legacy-workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("Mastra scheduler scopes stay inert until explicit activation", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const { listSchedulableScopes } = await import("../src/scheduler/index.js");
  const scope = { userId: "scheduler-user", projectId: "invest-agent", instanceId: "scheduler-instance" };
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(id) DO UPDATE SET status='active'").run(scope.userId, "Scheduler test", now, now);
  sqlite.prepare("INSERT OR IGNORE INTO ai_projects (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(scope.projectId, "Invest Agent", now, now);
  sqlite.prepare("INSERT INTO ai_instances (id, owner_user_id, project_id, name, status, config, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', '{}', ?, ?) ON CONFLICT(id) DO UPDATE SET status='active'").run(scope.instanceId, scope.userId, scope.projectId, "scheduler test", now, now);
  const put = (activation: string) => sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,project_id,instance_id) DO UPDATE SET preferences_json=excluded.preferences_json").run(scope.userId, scope.projectId, scope.instanceId, JSON.stringify({ schedulerActivation: activation, schedules: {} }), "{}", "test", "test", now, now);

  // P4b: schedulerActivation no longer gates schedulable scopes; these
  // scopes feed the rule patrol, and reviews/market-watch are typed tasks.
  put("disabled_until_target_cold_start_and_explicit_enable");
  assert.equal((await listSchedulableScopes()).some((item) => item.instanceId === scope.instanceId), true);
  put("enabled");
  assert.equal((await listSchedulableScopes()).some((item) => item.instanceId === scope.instanceId), true);
});
