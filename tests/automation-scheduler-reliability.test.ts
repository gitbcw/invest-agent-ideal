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

test("scheduler recovery advances a scheduled task so the expired slot is not dispatched every minute", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const dueAt = "2026-08-20T23:30:00.000Z";
  db.sqlite.prepare(`UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?`).run(dueAt, task.taskId);
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: dueAt,
    idempotencyKey: `scheduled-stale-${task.taskId}`,
  });
  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare(`UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?`)
    .run(stale, stale, stale, claimed.run.runId);
  db.sqlite.prepare(`UPDATE automation_tasks SET active_run_lease_expires_at = ?, updated_at = ? WHERE task_id = ?`)
    .run(stale, stale, task.taskId);

  const recoveredAt = new Date("2026-08-21T00:00:00.000Z");
  assert.equal(await automation.recoverExpiredAutomationTaskRuns(recoveredAt), 1);
  const current = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(current?.consecutiveFailures, 1);
  assert.ok(current?.nextRunAt && current.nextRunAt > recoveredAt.toISOString());
  assert.deepEqual(await automation.listDueAutomationTasks(new Date("2026-08-21T00:01:00.000Z")), []);
});

test("a scheduled run completed after its execution deadline advances failure state, not success state", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-21T00:00:00.000Z",
    idempotencyKey: `scheduled-expired-finish-${task.taskId}`,
    executionDeadlineAt: "2020-01-01T00:00:00.000Z",
  });
  const futureLease = new Date(Date.now() + 60_000).toISOString();
  db.sqlite.prepare(`UPDATE automation_task_runs SET lease_expires_at = ? WHERE run_id = ?`)
    .run(futureLease, claimed.run.runId);
  db.sqlite.prepare(`UPDATE automation_tasks SET active_run_lease_expires_at = ? WHERE task_id = ?`)
    .run(futureLease, task.taskId);

  const finished = await automation.finishAutomationTaskRun({
    ...scope,
    runId: claimed.run.runId,
    leaseToken: claimed.run.leaseToken,
    status: "succeeded",
    resultSummary: "late result",
  });
  assert.equal(finished.status, "failed");
  assert.equal(finished.errorCategory, "expired");
  const current = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(current?.consecutiveFailures, 1);
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

test("scheduler admission caps process-wide concurrency and leaves later due work for the next tick", async () => {
  const scheduler = await import("../src/scheduler/automation.js");
  scheduler.__test__.runningAutomationTasks.clear();
  const firstTask = await createActiveTask();
  const secondTask = await createActiveTask();
  const due = [
    { ...firstTask, nextRunAt: "2020-01-01T00:00:00.000Z" },
    { ...secondTask, nextRunAt: "2020-01-01T00:01:00.000Z" },
  ];
  const oldLimit = process.env.AUTOMATION_MAX_CONCURRENCY;
  process.env.AUTOMATION_MAX_CONCURRENCY = "1";
  const releases: Array<() => void> = [];
  const calls: string[] = [];
  let listCalls = 0;
  const dependencies = {
    listDueAutomationTasks: async () => {
      listCalls += 1;
      return listCalls >= 3 ? due.slice(1) : due;
    },
    recoverExpiredAutomationTaskRuns: async () => 0,
    runAutomationTaskNow: async (input: { taskId: string }) => {
      calls.push(input.taskId);
      await new Promise<void>((resolve) => releases.push(resolve));
      return { run: { runId: `fake-${calls.length}`, status: "succeeded" }, task: due.find((item) => item.taskId === input.taskId) } as never;
    },
  } as scheduler.AutomationSchedulerDependencies;
  try {
    const firstTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:02:00.000Z"), dependencies);
    assert.deepEqual(firstTick, { due: 2, started: 1 });
    assert.deepEqual(calls, [firstTask.taskId]);

    const blockedTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:02:01.000Z"), dependencies);
    assert.deepEqual(blockedTick, { due: 2, started: 0 });
    assert.deepEqual(calls, [firstTask.taskId]);

    releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
    const secondTick = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T00:03:00.000Z"), dependencies);
    assert.deepEqual(secondTick, { due: 1, started: 1 });
    assert.deepEqual(calls, [firstTask.taskId, secondTask.taskId]);
    releases.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    scheduler.__test__.runningAutomationTasks.clear();
    if (oldLimit === undefined) delete process.env.AUTOMATION_MAX_CONCURRENCY;
    else process.env.AUTOMATION_MAX_CONCURRENCY = oldLimit;
  }
});

test("stale scheduled queue slots terminalize as expired without invoking the model", async () => {
  const { automation } = await fixture();
  const scheduler = await import("../src/scheduler/automation.js");
  scheduler.__test__.runningAutomationTasks.clear();
  const task = await createActiveTask();
  const staleSlot = "2020-01-01T00:00:00.000Z";
  const dueTask = { ...task, nextRunAt: staleSlot };
  const oldLimit = process.env.AUTOMATION_MAX_QUEUE_DELAY_MS;
  process.env.AUTOMATION_MAX_QUEUE_DELAY_MS = "60000";
  const expiredInputs: Array<{ taskId: string; queueDelayMs: number; maxQueueDelayMs: number }> = [];
  let modelCalls = 0;
  const dependencies = {
    listDueAutomationTasks: async () => [dueTask],
    recoverExpiredAutomationTaskRuns: async () => 0,
    expireStaleScheduledAutomationTaskRun: async (input: { taskId: string; queueDelayMs: number; maxQueueDelayMs: number }) => {
      expiredInputs.push(input);
      return { expired: true, run: { runId: "queue-expired-1", status: "failed" } } as never;
    },
    runAutomationTaskNow: async () => {
      modelCalls += 1;
      throw new Error("stale queue slots must not start the model");
    },
  } as scheduler.AutomationSchedulerDependencies;
  try {
    const result = await scheduler.runAutomationSchedulerTick(new Date("2020-01-01T02:00:01.000Z"), dependencies);
    assert.deepEqual(result, { due: 1, started: 0 });
    assert.equal(modelCalls, 0);
    assert.equal(expiredInputs.length, 1);
    assert.ok(expiredInputs[0]!.queueDelayMs > expiredInputs[0]!.maxQueueDelayMs);
    assert.equal(expiredInputs[0]!.maxQueueDelayMs, 60_000);
  } finally {
    scheduler.__test__.runningAutomationTasks.clear();
    if (oldLimit === undefined) delete process.env.AUTOMATION_MAX_QUEUE_DELAY_MS;
    else process.env.AUTOMATION_MAX_QUEUE_DELAY_MS = oldLimit;
  }
});

test("queue expiry is a transactional, idempotent scheduled failure and leaves manual runs alone", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const staleSlot = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare("UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?").run(staleSlot, task.taskId);
  const input = {
    ...scope,
    taskId: task.taskId,
    revisionId: task.currentRevisionId!,
    scheduledFor: staleSlot,
    idempotencyKey: `queue-expiry-${task.taskId}`,
    queueDelayMs: 7_201_000,
    maxQueueDelayMs: 7_200_000,
  };
  const expired = await automation.expireStaleScheduledAutomationTaskRun(input);
  assert.equal(expired.expired, true);
  assert.equal(expired.run.status, "failed");
  assert.equal(expired.run.errorCategory, "expired");
  assert.match(expired.run.errorMessage || "", /QUEUE_DELAY_EXCEEDED/);
  assert.equal(expired.run.outputAssetId, null);
  assert.equal(expired.run.outputVersionId, null);
  const afterExpiry = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(afterExpiry?.consecutiveFailures, 1);
  assert.ok(afterExpiry?.nextRunAt && afterExpiry.nextRunAt > staleSlot);
  assert.ok((await automation.listAutomationTaskAuditLogs({ ...scope, taskId: task.taskId })).some((item) => item.action === "run.queue_expired"));

  const replay = await automation.expireStaleScheduledAutomationTaskRun(input);
  assert.equal(replay.expired, false);
  assert.equal(replay.run.runId, expired.run.runId);
  assert.equal((await automation.getAutomationTask({ ...scope, taskId: task.taskId }))?.consecutiveFailures, 1);

  const manualTask = await createActiveTask();
  db.sqlite.prepare("UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?").run(staleSlot, manualTask.taskId);
  const manual = await automation.claimAutomationTaskRun({ ...scope, taskId: manualTask.taskId, origin: "manual", idempotencyKey: `queue-expiry-manual-${manualTask.taskId}` });
  const manualOutcome = await automation.expireStaleScheduledAutomationTaskRun({
    ...scope,
    taskId: manualTask.taskId,
    revisionId: manualTask.currentRevisionId!,
    scheduledFor: staleSlot,
    idempotencyKey: `queue-expiry-scheduled-${manualTask.taskId}`,
    queueDelayMs: 7_201_000,
    maxQueueDelayMs: 7_200_000,
  });
  assert.equal(manualOutcome.expired, false);
  assert.equal(manualOutcome.run.runId, manual.run.runId);
  assert.equal((await automation.getAutomationTask({ ...scope, taskId: manualTask.taskId }))?.nextRunAt, staleSlot);
  await automation.finishAutomationTaskRun({ ...scope, runId: manual.run.runId, leaseToken: manual.run.leaseToken, status: "succeeded" });
});

test("terminal scheduled replays reconcile a stale cursor exactly once and do not activate needs_attention", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const scheduledFor = "2026-08-23T00:00:00.000Z";
  db.sqlite.prepare("UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?").run(scheduledFor, task.taskId);
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor,
    idempotencyKey: `terminal-replay-${task.taskId}`,
  });
  await automation.finishAutomationTaskRun({ ...scope, runId: claimed.run.runId, leaseToken: claimed.run.leaseToken, status: "succeeded" });
  db.sqlite.prepare("UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?").run(scheduledFor, task.taskId);

  const replay = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor,
    idempotencyKey: `terminal-replay-${task.taskId}`,
  });
  assert.equal(replay.claimed, false);
  const repaired = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.ok(repaired?.nextRunAt && repaired.nextRunAt > scheduledFor);
  const secondReplay = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor,
    idempotencyKey: `terminal-replay-${task.taskId}`,
  });
  assert.equal(secondReplay.claimed, false);
  assert.equal((await automation.listAutomationTaskRuns({ ...scope, taskId: task.taskId })).length, 1);

  const attentionTask = await createActiveTask();
  const failures: Array<{ runId: string; leaseToken?: string | null; idempotencyKey: string; scheduledFor: string }> = [];
  for (let index = 0; index < 3; index += 1) {
    const failureSlot = `2026-08-23T00:0${index}:00.000Z`;
    const failureKey = `attention-replay-${attentionTask.taskId}-${index}`;
    const failure = await automation.claimAutomationTaskRun({ ...scope, taskId: attentionTask.taskId, origin: "scheduled", scheduledFor: failureSlot, idempotencyKey: failureKey });
    failures.push({ runId: failure.run.runId, leaseToken: failure.run.leaseToken, idempotencyKey: failureKey, scheduledFor: failureSlot });
    await automation.finishAutomationTaskRun({ ...scope, runId: failure.run.runId, leaseToken: failure.run.leaseToken, status: "failed", errorMessage: "test failure" });
  }
  db.sqlite.prepare("UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?").run(failures[2]!.scheduledFor, attentionTask.taskId);
  const attentionReplay = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: attentionTask.taskId,
    origin: "scheduled",
    scheduledFor: failures[2]!.scheduledFor,
    idempotencyKey: failures[2]!.idempotencyKey,
  });
  assert.equal(attentionReplay.claimed, false);
  const attention = await automation.getAutomationTask({ ...scope, taskId: attentionTask.taskId });
  assert.equal(attention?.status, "needs_attention");
  assert.equal(attention?.nextRunAt, null);
  assert.equal(attention?.consecutiveFailures, 3);
});

test("failed and recovered runs do not retain uncommitted output version fields", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const failedClaim = await automation.claimAutomationTaskRun({ ...scope, taskId: task.taskId, origin: "manual", idempotencyKey: `output-failed-${task.taskId}` });
  await automation.bindAutomationTaskRunAssets({
    ...scope,
    runId: failedClaim.run.runId,
    leaseToken: failedClaim.run.leaseToken,
    inputs: [],
    outputAssetId: task.workingAsset!.assetId,
    outputVersionId: "uncommitted-version-failed",
  });
  const failed = await automation.finishAutomationTaskRun({
    ...scope,
    runId: failedClaim.run.runId,
    leaseToken: failedClaim.run.leaseToken,
    status: "failed",
    outputAssetId: task.workingAsset!.assetId,
    outputVersionId: "uncommitted-version-failed",
    outputChecksum: "uncommitted-checksum-failed",
  });
  assert.equal(failed.outputAssetId, null);
  assert.equal(failed.outputVersionId, null);
  assert.equal(failed.outputChecksum, null);

  const recoveredClaim = await automation.claimAutomationTaskRun({ ...scope, taskId: task.taskId, origin: "manual", idempotencyKey: `output-recovered-${task.taskId}` });
  await automation.bindAutomationTaskRunAssets({
    ...scope,
    runId: recoveredClaim.run.runId,
    leaseToken: recoveredClaim.run.leaseToken,
    inputs: [],
    outputAssetId: task.workingAsset!.assetId,
    outputVersionId: "uncommitted-version-recovered",
  });
  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare("UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
    .run(stale, stale, stale, recoveredClaim.run.runId);
  db.sqlite.prepare("UPDATE automation_tasks SET active_run_lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
    .run(stale, stale, task.taskId);
  assert.equal(await automation.recoverExpiredAutomationTaskRuns(new Date("2026-08-23T01:00:00.000Z")), 1);
  const recovered = await automation.getAutomationTaskRun({ ...scope, runId: recoveredClaim.run.runId });
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.outputAssetId, null);
  assert.equal(recovered?.outputVersionId, null);
  assert.equal(recovered?.outputChecksum, null);
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

function insertReviewsSaveArtifact(db: typeof import("../src/db/index.js"), scopeKey: { userId: string; instanceId: string }, conversationId: string) {
  db.sqlite.prepare(`
    INSERT INTO conversation_artifacts (
      artifact_id, user_id, instance_id, assistant_id, conversation_id, source, kind,
      preview_mode, title, file_name, mime_type, relative_path, size_bytes, created_at, updated_at
    ) VALUES (@artifactId, @userId, @instanceId, @assistantId, @conversationId,
      'reviews.save', 'report', 'download', 'test review', 'test.md', 'text/markdown',
      @relativePath, @sizeBytes, @createdAt, @updatedAt)
  `).run(
    {
      artifactId: `art_t336_${Math.random().toString(36).slice(2, 10)}`,
      userId: scopeKey.userId,
      instanceId: scopeKey.instanceId,
      assistantId: scopeKey.instanceId,
      conversationId,
      relativePath: "reports/daily/test.md",
      sizeBytes: 16,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  );
}

test("T-336: lease expiry after a durable reviews.save publication recovers the run as succeeded", async () => {
  const { automation, db } = await fixture();
  const task = await createActiveTask();
  const dueAt = "2026-08-21T11:00:00.000Z";
  db.sqlite.prepare(`UPDATE automation_tasks SET next_run_at = ? WHERE task_id = ?`).run(dueAt, task.taskId);
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: dueAt,
    idempotencyKey: `scheduled-t336-${task.taskId}`,
  });
  // The runner addressed the agent turn as automation-run:<runId> and
  // reviews.save already published the durable artifact when the runtime
  // restarted before finalize (2026-08-21 patrol, user 111).
  insertReviewsSaveArtifact(db, scope, `automation-run:${claimed.run.runId}`);

  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare("UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
    .run(stale, stale, stale, claimed.run.runId);
  db.sqlite.prepare("UPDATE automation_tasks SET active_run_lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
    .run(stale, stale, task.taskId);

  const recoveredAt = new Date("2026-08-21T11:16:44.581Z");
  assert.equal(await automation.recoverExpiredAutomationTaskRuns(recoveredAt), 1);
  const recovered = await automation.getAutomationTaskRun({ ...scope, runId: claimed.run.runId });
  assert.equal(recovered?.status, "succeeded");
  assert.ok(recovered?.finishedAt);
  assert.match(recovered?.resultSummary || "", /已持久化发布/);
  // The idempotency key stays intact: replays must return this run, not archive it as stale.
  assert.equal(recovered?.idempotencyKey, `scheduled-t336-${task.taskId}`);

  const current = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(current?.consecutiveFailures, 0);
  assert.ok(current?.nextRunAt && current.nextRunAt > recoveredAt.toISOString());
  const lock = db.sqlite.prepare(`SELECT active_run_id AS activeRunId FROM automation_tasks WHERE task_id = ?`).get(task.taskId) as { activeRunId: string | null };
  assert.equal(lock.activeRunId, null);

  const audit = db.sqlite.prepare(
    "SELECT status FROM automation_task_audit_logs WHERE run_id = ? AND action = 'run.lease_expired' ORDER BY created_at DESC LIMIT 1",
  ).get(claimed.run.runId) as { status: string } | undefined;
  assert.equal(audit?.status, "recovered_completed");
});

test("T-336 boundary: generic agent-output tasks stay failed even with a stray reviews.save artifact", async () => {
  const { automation, db } = await fixture();
  sequence += 1;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: `automation-reliability-agent-${sequence}`,
    name: `智能输出任务 ${sequence}`,
    instruction: "根据任务需要处理文件并汇报结果。",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: task.currentRevision });
  const claimed = await automation.claimAutomationTaskRun({
    ...scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `manual-t336-boundary-${task.taskId}`,
  });
  insertReviewsSaveArtifact(db, scope, `automation-run:${claimed.run.runId}`);

  const stale = "2020-01-01T00:00:00.000Z";
  db.sqlite.prepare("UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ?, updated_at = ? WHERE run_id = ?")
    .run(stale, stale, stale, claimed.run.runId);
  db.sqlite.prepare("UPDATE automation_tasks SET active_run_lease_expires_at = ?, updated_at = ? WHERE task_id = ?")
    .run(stale, stale, task.taskId);

  assert.equal(await automation.recoverExpiredAutomationTaskRuns(new Date("2026-08-23T02:00:00.000Z")), 1);
  const recovered = await automation.getAutomationTaskRun({ ...scope, runId: claimed.run.runId });
  // Agent-output runs still owe a staged output commit; a restart genuinely
  // interrupted them, so lease recovery must keep failing them.
  assert.equal(recovered?.status, "failed");
  assert.match(recovered?.errorMessage || "", /LEASE_EXPIRED/);
});
