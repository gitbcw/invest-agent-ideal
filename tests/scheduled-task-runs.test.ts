import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";

const databaseDir = join(tmpdir(), `invest-agent-scheduled-task-runs-${randomUUID()}`);
process.env.DB_PATH = join(databaseDir, "invest-agent.db");

let closeDatabase: (() => void) | undefined;

before(async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  closeDatabase = () => sqlite.close();
});

after(async () => {
  closeDatabase?.();
  await rm(databaseDir, { recursive: true, force: true });
});

test("scheduled task claims receive a lease and only active claims can finish", async () => {
  const { db } = await import("../src/db/index.js");
  const { scheduledTaskRuns } = await import("../src/db/schema.js");
  const { claimScheduledTaskRun, finishScheduledTaskRun } = await import("../src/services/scheduled-task-runs.js");
  const taskKey = "2026-08-08:market-watch:lease-test:09:55";

  const claimed = await claimScheduledTaskRun({
    taskKey,
    taskType: "market-watch",
    scheduledFor: "2026-08-08:09:55",
    userId: "lease-test",
    instanceId: "invest-agent-lease-test",
    leaseMs: 60_000,
  });
  assert.equal(claimed, true);
  assert.equal(await claimScheduledTaskRun({ taskKey, taskType: "market-watch", scheduledFor: "2026-08-08:09:55" }), false);

  const claimedRow = (await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, taskKey)))[0];
  assert.equal(claimedRow.status, "claimed");
  assert.equal(claimedRow.attempts, 1);
  assert.ok(claimedRow.leaseExpiresAt);
  assert.ok(Date.parse(claimedRow.leaseExpiresAt as string) > Date.parse(claimedRow.claimedAt));

  assert.equal(await finishScheduledTaskRun(taskKey, { status: "success" }), true);
  const finishedRow = (await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, taskKey)))[0];
  assert.equal(finishedRow.status, "success");
  assert.equal(finishedRow.leaseExpiresAt, null);
  assert.equal(await finishScheduledTaskRun(taskKey, { status: "error", errorMessage: "late worker" }), false);
  const unchangedRow = (await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, taskKey)))[0];
  assert.equal(unchangedRow.status, "success");
});

test("reconciliation closes expired and legacy claims without touching live claims", async () => {
  const { db } = await import("../src/db/index.js");
  const { scheduledTaskRuns } = await import("../src/db/schema.js");
  const {
    claimScheduledTaskRun,
    finishScheduledTaskRun,
    reconcileExpiredScheduledTaskRuns,
  } = await import("../src/services/scheduled-task-runs.js");
  const now = new Date("2026-08-08T12:00:00.000Z");
  const expiredKey = "2026-08-08:market-watch:expired:09:55";
  const legacyKey = "2026-08-08:market-watch:legacy:09:55";
  const liveLegacyKey = "2026-08-08:market-watch:live-legacy:09:55";

  for (const taskKey of [expiredKey, legacyKey, liveLegacyKey]) {
    assert.equal(await claimScheduledTaskRun({
      taskKey,
      taskType: "market-watch",
      scheduledFor: "2026-08-08:09:55",
      userId: taskKey,
      instanceId: `invest-agent-${taskKey}`,
    }), true);
  }
  await db.update(scheduledTaskRuns).set({
    claimedAt: "2026-08-08T11:00:00.000Z",
    leaseExpiresAt: "2026-08-08T11:15:00.000Z",
  }).where(eq(scheduledTaskRuns.taskKey, expiredKey));
  await db.update(scheduledTaskRuns).set({
    claimedAt: "2026-08-08T11:00:00.000Z",
    leaseExpiresAt: null,
  }).where(eq(scheduledTaskRuns.taskKey, legacyKey));
  await db.update(scheduledTaskRuns).set({
    claimedAt: "2026-08-08T11:45:00.000Z",
    leaseExpiresAt: null,
  }).where(eq(scheduledTaskRuns.taskKey, liveLegacyKey));

  assert.equal(await reconcileExpiredScheduledTaskRuns(now), 2);
  const rows = await db.select().from(scheduledTaskRuns);
  const byKey = new Map(rows.map((row) => [row.taskKey, row]));
  for (const taskKey of [expiredKey, legacyKey]) {
    assert.equal(byKey.get(taskKey)?.status, "error");
    assert.equal(byKey.get(taskKey)?.errorClass, "lease_expired");
    assert.equal(byKey.get(taskKey)?.leaseExpiresAt, null);
  }
  assert.equal(byKey.get(liveLegacyKey)?.status, "claimed");
  assert.equal(await finishScheduledTaskRun(expiredKey, { status: "success" }), false);
  const expiredAfterLateFinish = (await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, expiredKey)))[0];
  assert.equal(expiredAfterLateFinish.status, "error");
});
