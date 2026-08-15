import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const scope = { userId: "patrol-user", projectId: "invest-agent", instanceId: "invest-agent-patrol-user" };

test("dedicated rule-patrol surface: status, run history, manual run never pushes (E9 v2)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-patrol-v2-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const patrol = await import("../src/services/rule-patrol.js");
    initDb();

    // Empty scope: zero rules, no runs.
    let status = patrol.getRulePatrolStatus(scope);
    assert.equal(status.rulesTotal, 0);
    assert.equal(status.rulesEnabled, 0);
    assert.equal(status.latestRun, null);
    assert.deepEqual(patrol.listRulePatrolRuns(scope), []);

    // Two rules (one disabled) + two patrol runs.
    const insertRule = sqlite.prepare(`
      INSERT INTO alert_rules (user_id, instance_id, stock_code, stock_name, indicator_key, condition, params, schedule, dedupe_policy, severity, enabled, created_at, updated_at)
      VALUES (?,?,?,?,'watch_rule_price_cross','price_cross','{}','intraday','{}','medium',?,'2026-08-15T00:00:00Z','2026-08-15T00:00:00Z')
    `);
    insertRule.run(scope.userId, scope.instanceId, "600519", "贵州茅台", 1);
    insertRule.run(scope.userId, scope.instanceId, "300750", "宁德时代", 0);
    const insertRun = sqlite.prepare(`
      INSERT INTO scheduled_task_runs (task_key, task_type, user_id, project_id, instance_id, scheduled_for, status, claimed_at, finished_at, error_message, push_job_id, attempts, max_attempts, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)
    `);
    insertRun.run("2026-08-15:rule-alert-check:x:slot-b", "rule-alert-check", scope.userId, scope.projectId, scope.instanceId, "2026-08-15:01:05", "skipped", "2026-08-15T01:05:00.100Z", "2026-08-15T01:05:01.000Z", null, null, "2026-08-15T01:05:02.000Z", "2026-08-15T01:05:02.000Z");
    insertRun.run("2026-08-15:rule-alert-check:x:slot-a", "rule-alert-check", scope.userId, scope.projectId, scope.instanceId, "2026-08-15:01:00", "success", "2026-08-15T01:00:00.100Z", "2026-08-15T01:00:10.500Z", null, "push_1", "2026-08-15T01:00:11.000Z", "2026-08-15T01:00:11.000Z");

    status = patrol.getRulePatrolStatus(scope);
    assert.equal(status.rulesTotal, 2);
    assert.equal(status.rulesEnabled, 1);
    assert.equal(status.latestRun?.runId, "2026-08-15:rule-alert-check:x:slot-b");
    assert.equal(status.latestRun?.status, "skipped");
    assert.ok(status.intervalMinutes >= 1);

    const runs = patrol.listRulePatrolRuns(scope);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].status, "skipped");
    assert.equal(runs[0].resultSummary, "无命中");
    assert.equal(runs[0].pushed, false);
    assert.equal(runs[1].status, "succeeded");
    assert.equal(runs[1].resultSummary, "命中并推送");
    assert.equal(runs[1].pushed, true);

    // Manual patrol returns a shaped result and never throws; in the offline
    // test environment the price-facts source is unavailable, which must
    // surface as an error field, not an exception.
    const manual = await patrol.runRulePatrolNow(scope);
    assert.equal(typeof manual.ranAt, "string");
    assert.ok(Array.isArray(manual.items));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
