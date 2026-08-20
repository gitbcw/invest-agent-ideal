import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Import the runtime only after this test has isolated all persistent paths.
const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-reliability-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "workspace";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// E8: the mastra registry is the only storage root; isolate it per run so
// asset files never leak across test runs (AUTOMATION_ASSET_SOURCE_IMMUTABLE).
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scope = { userId: "automation-reliability-user", instanceId: "automation-reliability-instance", projectId: "invest-agent" };
let fixturePromise: Promise<{
  automation: typeof import("../src/services/automation-tasks.js");
  db: typeof import("../src/db/index.js");
}> | null = null;
let sequence = 0;

async function fixture() {
  if (!fixturePromise) {
    fixturePromise = (async () => {
      const db = await import("../src/db/index.js");
      db.initDb();
      const automation = await import("../src/services/automation-tasks.js");
      return { automation, db };
    })();
  }
  return fixturePromise;
}

async function createActiveTask() {
  const { automation } = await fixture();
  sequence += 1;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: `automation-reliability-${sequence}`,
    name: `可靠性任务 ${sequence}`,
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "tracking.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1500\n") },
  });
  return automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: task.currentRevision });
}

test("task mutex rejects manual-versus-scheduled overlap and releases after finish", async () => {
  const { automation } = await fixture();
  const task = await createActiveTask();
  const first = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `manual-${task.taskId}`,
  });
  const contender = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey: `scheduled-${task.taskId}`,
  });

  assert.equal(first.claimed, true);
  assert.equal(contender.claimed, false);
  assert.equal(contender.run.runId, first.run.runId);
  assert.equal(contender.run.origin, "manual");

  await automation.finishAutomationTaskRun({ ...scope, runId: first.run.runId, leaseToken: first.run.leaseToken, status: "succeeded" });
  const afterFinish = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey: `scheduled-${task.taskId}`,
  });
  assert.equal(afterFinish.claimed, true);
  await automation.finishAutomationTaskRun({ ...scope, runId: afterFinish.run.runId, leaseToken: afterFinish.run.leaseToken, status: "succeeded" });
});

test("expired leases become terminal attempts and a retry gets a new fenced attempt", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const idempotencyKey = `scheduled-recovery-${task.taskId}`;
  const first = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey,
  });
  assert.equal(first.claimed, true);
  assert.ok(first.run.leaseToken);

  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare(`
    UPDATE automation_task_runs
    SET claimed_at = ?, lease_expires_at = ?, updated_at = ?
    WHERE run_id = ?
  `).run(stale, stale, stale, first.run.runId);
  db.sqlite.prepare(`
    UPDATE automation_tasks
    SET active_run_lease_expires_at = ?, updated_at = ?
    WHERE task_id = ?
  `).run(stale, stale, task.taskId);

  const recovered = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey,
  });
  assert.equal(recovered.claimed, true);
  assert.notEqual(recovered.run.runId, first.run.runId);
  assert.equal(recovered.run.attempt, first.run.attempt + 1);

  const oldRow = await automation.getAutomationTaskRun({ ...scope, runId: first.run.runId });
  assert.equal(oldRow?.status, "failed");
  assert.match(oldRow?.errorMessage || "", /LEASE_EXPIRED/);
  await assert.rejects(
    () => automation.assertAutomationTaskRunLease({ ...scope, runId: first.run.runId, leaseToken: first.run.leaseToken }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_RUN_LEASE_LOST",
  );
  await automation.assertAutomationTaskRunLease({ ...scope, runId: recovered.run.runId, leaseToken: recovered.run.leaseToken });

  await automation.finishAutomationTaskRun({ ...scope, runId: recovered.run.runId, leaseToken: recovered.run.leaseToken, status: "succeeded" });
  const lock = db.sqlite.prepare(`SELECT active_run_id AS activeRunId FROM automation_tasks WHERE task_id = ?`).get(task.taskId) as { activeRunId: string | null };
  assert.equal(lock.activeRunId, null);
});

test("scheduler recovery terminalizes an expired run without a later claimant", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `manual-stale-${task.taskId}`,
  });
  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare(`
    UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?
  `).run(stale, stale, stale, claimed.run.runId);
  db.sqlite.prepare(`
    UPDATE automation_tasks SET active_run_lease_expires_at = ?, updated_at = ? WHERE task_id = ?
  `).run(stale, stale, task.taskId);

  assert.equal(await automation.recoverExpiredAutomationTaskRuns(new Date("2026-08-20T13:42:30.000Z")), 1);
  const recovered = await automation.getAutomationTaskRun({ ...scope, runId: claimed.run.runId });
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.errorCategory, "expired");
  const lock = db.sqlite.prepare(`SELECT active_run_id AS activeRunId FROM automation_tasks WHERE task_id = ?`).get(task.taskId) as { activeRunId: string | null };
  assert.equal(lock.activeRunId, null);
});

test("manual run outcomes do not change the scheduled cadence or failure circuit breaker", async () => {
  const { automation } = await fixture();
  const task = await createActiveTask();
  const initialNextRunAt = task.nextRunAt;

  for (let index = 0; index < 3; index += 1) {
    const claimed = await automation.claimAutomationTaskRun({
      ...scope,
      taskId: task.taskId,
      origin: "manual",
      idempotencyKey: `manual-failure-${task.taskId}-${index}`,
    });
    await automation.finishAutomationTaskRun({
      ...scope,
      runId: claimed.run.runId,
      leaseToken: claimed.run.leaseToken,
      status: "failed",
      errorMessage: `manual failure ${index}`,
    });
  }

  const afterFailures = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(afterFailures?.status, "active");
  assert.equal(afterFailures?.consecutiveFailures, 0);
  assert.equal(afterFailures?.nextRunAt, initialNextRunAt);

  const successful = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `manual-success-${task.taskId}`,
  });
  await automation.finishAutomationTaskRun({
    ...scope,
    runId: successful.run.runId,
    leaseToken: successful.run.leaseToken,
    status: "succeeded",
  });
  const afterSuccess = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(afterSuccess?.nextRunAt, initialNextRunAt);
});

test("concurrent claim callers serialize through the SQLite task mutex", async () => {
  const { automation } = await fixture();
  const task = await createActiveTask();
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey: `concurrent-${task.taskId}-${index}`,
  })));
  assert.equal(results.filter((item) => item.claimed).length, 1);
  assert.equal(new Set(results.map((item) => item.run.runId)).size, 1);
  const winner = results.find((item) => item.claimed)!;
  await automation.finishAutomationTaskRun({ ...scope, runId: winner.run.runId, leaseToken: winner.run.leaseToken, status: "succeeded" });
});

test("scheduler tick suppresses same-process duplicate dispatch while a run is in flight", async () => {
  const { automation } = await fixture();
  const scheduler = await import("../src/scheduler/automation.js");
  scheduler.__test__.runningAutomationTasks.clear();
  const task = await createActiveTask();
  const dueTask = { ...task, nextRunAt: "2020-01-01T00:00:00.000Z" };
  let resolveRun!: () => void;
  const runGate = new Promise<void>((resolve) => { resolveRun = resolve; });
  let calls = 0;
  const dependencies = {
    listDueAutomationTasks: async () => [dueTask],
    recoverExpiredAutomationTaskRuns: async () => 0,
    runAutomationTaskNow: async () => {
      calls += 1;
      await runGate;
      return { run: { runId: `fake-${calls}`, status: "succeeded" }, task: dueTask } as never;
    },
  } as scheduler.AutomationSchedulerDependencies;

  const firstTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:01:00.000Z"), dependencies);
  const secondTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:01:01.000Z"), dependencies);
  assert.deepEqual(firstTick, { due: 1, started: 1 });
  assert.deepEqual(secondTick, { due: 1, started: 0 });
  assert.equal(calls, 1);
  resolveRun();
  await new Promise((resolve) => setImmediate(resolve));
  const thirdTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:02:00.000Z"), dependencies);
  assert.deepEqual(thirdTick, { due: 1, started: 1 });
  assert.equal(calls, 2);
  resolveRun();
  await new Promise((resolve) => setImmediate(resolve));
});

test("initDb adds lease columns needed by an old automation database", async () => {
  const { db } = await fixture();
  const taskColumns = db.sqlite.prepare("PRAGMA table_info(automation_tasks)").all() as Array<{ name: string }>;
  const runColumns = db.sqlite.prepare("PRAGMA table_info(automation_task_runs)").all() as Array<{ name: string }>;
  for (const column of ["active_run_id", "active_run_lease_token", "active_run_lease_expires_at"]) {
    assert.ok(taskColumns.some((item) => item.name === column), `missing automation_tasks.${column}`);
  }
  for (const column of ["idempotency_base_key", "attempt", "lease_token", "lease_expires_at"]) {
    assert.ok(runColumns.some((item) => item.name === column), `missing automation_task_runs.${column}`);
  }
  await mkdir(path.join(root, "runtime"), { recursive: true });
});
