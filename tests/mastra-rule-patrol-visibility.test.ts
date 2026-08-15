import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const scope = { userId: "patrol-user", projectId: "invest-agent", instanceId: "invest-agent-patrol-user" };

test("rule patrol surfaces as a read-only synthetic automation task with scheduled runs (E9/G21)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-patrol-visibility-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const tasks = await import("../src/services/automation-tasks.js");
    initDb();

    // No watch rules yet: the synthetic entry must not appear.
    let page = await tasks.listAutomationTaskPage(scope);
    assert.equal(page.items.some((task) => task.taskId === tasks.RULE_ALERT_CHECK_TASK_ID), false);
    assert.equal(await tasks.getAutomationTask({ ...scope, taskId: tasks.RULE_ALERT_CHECK_TASK_ID }), null);

    // One enabled price_cross rule + two patrol runs in scheduled_task_runs.
    sqlite.prepare(`
      INSERT INTO alert_rules (user_id, instance_id, stock_code, stock_name, indicator_key, condition, params, schedule, dedupe_policy, severity, enabled, created_at, updated_at)
      VALUES (?,?,'600519','贵州茅台','watch_rule_price_cross','price_cross','{}','intraday','{}','medium',1,'2026-08-15T00:00:00.000Z','2026-08-15T00:00:00.000Z')
    `).run(scope.userId, scope.instanceId);
    const insertScoped = sqlite.prepare(`
      INSERT INTO scheduled_task_runs (task_key, task_type, user_id, project_id, instance_id, scheduled_for, status, claimed_at, finished_at, error_message, push_job_id, attempts, max_attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)
    `);
    insertScoped.run("2026-08-15:rule-alert-check:x:slot-b", "rule-alert-check", scope.userId, scope.projectId, scope.instanceId, "2026-08-15:01:05", "skipped", "2026-08-15T01:05:00.100Z", "2026-08-15T01:05:01.000Z", null, null, "2026-08-15T01:05:02.000Z", "2026-08-15T01:05:02.000Z");
    insertScoped.run("2026-08-15:rule-alert-check:x:slot-a", "rule-alert-check", scope.userId, scope.projectId, scope.instanceId, "2026-08-15:01:00", "success", "2026-08-15T01:00:00.100Z", "2026-08-15T01:00:10.500Z", null, "push_1", "2026-08-15T01:00:11.000Z", "2026-08-15T01:00:11.000Z");
    // Task list: synthetic entry present with the latest run attached.
    page = await tasks.listAutomationTaskPage(scope);
    const synthetic = page.items.find((task) => task.taskId === tasks.RULE_ALERT_CHECK_TASK_ID);
    assert.ok(synthetic, "synthetic patrol task appears in the automation list");
    assert.equal(synthetic.taskType, "rule-alert-check");
    assert.equal(synthetic.status, "active");
    assert.equal(synthetic.revision.name, "规则巡检");
    assert.equal(synthetic.latestRun?.runId, "2026-08-15:rule-alert-check:x:slot-b");
    assert.equal(synthetic.latestRun?.status, "skipped");

    // get + runs mapping.
    const fetched = await tasks.getAutomationTask({ ...scope, taskId: tasks.RULE_ALERT_CHECK_TASK_ID });
    assert.equal(fetched?.taskId, tasks.RULE_ALERT_CHECK_TASK_ID);
    const runs = await tasks.listAutomationTaskRunsPage({ ...scope, taskId: tasks.RULE_ALERT_CHECK_TASK_ID, limit: 10 });
    assert.equal(runs.items.length, 2);
    assert.equal(runs.items[0].runId, "2026-08-15:rule-alert-check:x:slot-b");
    assert.equal(runs.items[0].status, "skipped");
    assert.equal(runs.items[0].resultSummary, "无命中");
    assert.equal(runs.items[1].runId, "2026-08-15:rule-alert-check:x:slot-a");
    assert.equal(runs.items[1].status, "succeeded");
    assert.equal(runs.items[1].deliveryStatus, "sent");

    // Lifecycle actions on the synthetic id stay rejected (read-only by design).
    await assert.rejects(
      () => tasks.pauseAutomationTask({ ...scope, taskId: tasks.RULE_ALERT_CHECK_TASK_ID }),
      (error: Error & { code?: string }) => error.message.includes("AUTOMATION_TASK_NOT_FOUND"),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
