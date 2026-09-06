import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-notify-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const baseScope = { userId: "notify-user", projectId: "invest-agent", instanceId: "notify-instance" };

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const notify = await import("../src/services/automation-notify.js");
  return { db, automation, runner, notify };
})();

interface NotifyJobRow {
  id: string;
  message_kind: string;
  idempotency_key: string | null;
  source: string;
  origin_task_key: string | null;
  origin_run_id: string | null;
  expires_at: string | null;
  created_at: string;
  message: string;
  user_id: string;
}

function notifyJobs(taskId?: string): NotifyJobRow[] {
  const { db } = requireFixtureSync();
  const rows = db.sqlite.prepare(`
    SELECT id, message_kind, idempotency_key, source, origin_task_key, origin_run_id, expires_at, created_at, message, user_id
    FROM push_jobs
    WHERE message_kind IN ('automation_failure', 'automation_recovery')
    ORDER BY created_at ASC, id ASC
  `).all() as NotifyJobRow[];
  return taskId ? rows.filter((row) => row.idempotency_key?.startsWith(`automation:${taskId}:`)) : rows;
}

let fixtureRef: Awaited<typeof fixture> | undefined;
function requireFixtureSync(): Awaited<typeof fixture> {
  if (!fixtureRef) throw new Error("fixture not ready");
  return fixtureRef;
}
fixture.then((value) => { fixtureRef = value; });

async function createScheduledTask(taskId: string) {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId,
    name: `通知测试-${taskId}`,
    instruction: "测试任务。",
    schedule: { frequency: "trading_days" as const, time: "14:30", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });
  return task;
}

async function failRun(taskId: string, key: string) {
  const { runner } = await fixture;
  return runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId, origin: "scheduled", idempotencyKey: key,
    executor: async () => { throw new Error("simulated model failure"); },
  });
}

async function succeedRun(taskId: string, key: string) {
  const { runner } = await fixture;
  return runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId, origin: "scheduled", idempotencyKey: key,
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: { summary: "今日任务完成，数据已更新。", shouldNotify: false },
    }),
  });
}

test("first scheduled failure enqueues exactly one automation_failure job with the notify contract", async () => {
  const { db } = await fixture;
  const task = await createScheduledTask("notify-first-fail");
  const result = await failRun(task.taskId, "nf-fail-1");
  assert.equal(result.run.status, "failed");

  const jobs = notifyJobs(task.taskId);
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  assert.equal(job.message_kind, "automation_failure");
  assert.equal(job.idempotency_key, `automation:${task.taskId}:failure:${result.run.runId}`);
  assert.equal(job.source, "automation");
  assert.equal(job.origin_task_key, task.taskId);
  assert.equal(job.origin_run_id, null, "notify job must not attach originRunId (delivery_status semantics belong to summary jobs)");
  assert.equal(job.user_id, baseScope.userId);
  const ttlMs = Date.parse(job.expires_at!) - Date.parse(job.created_at);
  assert.ok(Math.abs(ttlMs - 2 * 60 * 60 * 1000) < 60 * 1000, `expected ~2h validity, got ${Math.round(ttlMs / 60000)}min`);
  assert.ok(job.message.includes("【定时任务失败】"), job.message);
  assert.ok(job.message.includes(task.taskId.slice(0, 8)) || job.message.includes("·"), job.message);

  const audit = db.sqlite.prepare(`
    SELECT action, status FROM automation_task_audit_logs
    WHERE run_id = ? AND action = 'run.failure_notified'
  `).get(result.run.runId) as { action: string; status: string } | undefined;
  assert.ok(audit, "failure notify audit row must exist");
  assert.equal(audit.status, "sent");
});

test("second consecutive failure stays aggregated (no new job) and recovery success notifies once", async () => {
  const task = await createScheduledTask("notify-aggregate");
  const f1 = await failRun(task.taskId, "na-fail-1");
  const f2 = await failRun(task.taskId, "na-fail-2");
  assert.equal(f2.run.status, "failed");
  let jobs = notifyJobs(task.taskId);
  assert.equal(jobs.filter((j) => j.message_kind === "automation_failure").length, 1, "aggregated: only the first failure notifies");

  const ok = await succeedRun(task.taskId, "na-ok-3");
  assert.equal(ok.run.status, "succeeded");
  jobs = notifyJobs(task.taskId);
  assert.equal(jobs.length, 2);
  const recovery = jobs.find((j) => j.message_kind === "automation_recovery")!;
  assert.equal(recovery.idempotency_key, `automation:${task.taskId}:recovery:${ok.run.runId}`);
  assert.ok(recovery.message.includes("【任务已恢复】"), recovery.message);

  // 已恢复后再次成功不得重复推恢复（最新通知 job 已是 recovery）。
  const ok2 = await succeedRun(task.taskId, "na-ok-4");
  assert.equal(ok2.run.status, "succeeded");
  assert.equal(notifyJobs(task.taskId).length, 2);
});

test("a task with no failure history does not notify on success", async () => {
  const task = await createScheduledTask("notify-healthy");
  const ok = await succeedRun(task.taskId, "nh-ok-1");
  assert.equal(ok.run.status, "succeeded");
  assert.equal(notifyJobs(task.taskId).length, 0);
});

test("manual-origin failures never notify", async () => {
  const { runner } = await fixture;
  const task = await createScheduledTask("notify-manual");
  const result = await runner.runGenericAutomationTaskNow({
    scope: baseScope, taskId: task.taskId, origin: "manual", idempotencyKey: "nm-manual-1",
    executor: async () => { throw new Error("manual failure"); },
  });
  assert.equal(result.run.status, "failed");
  assert.equal(notifyJobs(task.taskId).length, 0);
});

test("concurrent failures of different tasks stay isolated", async () => {
  const t1 = await createScheduledTask("notify-iso-a");
  const t2 = await createScheduledTask("notify-iso-b");
  const r1 = await failRun(t1.taskId, "ni-a-1");
  const r2 = await failRun(t2.taskId, "ni-b-1");
  // 只看本用例两个任务的 job（库里还有前面用例的通知）。
  const jobs = notifyJobs().filter((j) => j.idempotency_key!.startsWith("automation:notify-iso-"));
  const ids = new Set(jobs.map((j) => j.idempotency_key));
  assert.equal(ids.size, 2);
  assert.equal(jobs.filter((j) => j.idempotency_key!.startsWith(`automation:${t1.taskId}:`)).length, 1);
  assert.equal(jobs.filter((j) => j.idempotency_key!.startsWith(`automation:${t2.taskId}:`)).length, 1);
  assert.notEqual(r1.run.runId, r2.run.runId);
});

test("notify decision is idempotent on replay for the same run", async () => {
  const { notify } = await fixture;
  const task = await createScheduledTask("notify-idempotent");
  const result = await failRun(task.taskId, "ni-fail-1");
  await notify.notifyAutomationRunTerminal({ scope: baseScope, taskId: task.taskId, runId: result.run.runId });
  await notify.notifyAutomationRunTerminal({ scope: baseScope, taskId: task.taskId, runId: result.run.runId });
  assert.equal(notifyJobs(task.taskId).length, 1);
});

test("a new failure round after needs_attention recovery notifies again (cf reset to 1)", async () => {
  const { db } = await fixture;
  const task = await createScheduledTask("notify-round2");
  await failRun(task.taskId, "nr-fail-1");
  await failRun(task.taskId, "nr-fail-2");
  await failRun(task.taskId, "nr-fail-3");
  let jobs = notifyJobs(task.taskId);
  assert.equal(jobs.filter((j) => j.message_kind === "automation_failure").length, 1, "three straight failures still notify once");
  const taskRow = db.sqlite.prepare("SELECT status FROM automation_tasks WHERE task_id = ?").get(task.taskId) as { status: string };
  assert.equal(taskRow.status, "needs_attention");

  // 模拟管理员恢复：任务回到 active、连败计数清零。
  db.sqlite.prepare("UPDATE automation_tasks SET status = 'active', consecutive_failures = 0 WHERE task_id = ?").run(task.taskId);
  const fresh = await failRun(task.taskId, "nr-fail-4");
  assert.equal(fresh.run.status, "failed");
  jobs = notifyJobs(task.taskId);
  assert.equal(jobs.filter((j) => j.message_kind === "automation_failure").length, 2, "a fresh failure round notifies again");
  assert.ok(jobs.some((j) => j.idempotency_key === `automation:${task.taskId}:failure:${fresh.run.runId}`));
});

test("lease-expired runs terminalized by the reaper also notify (first failure only)", async () => {
  const { db, automation } = await fixture;
  const task = await createScheduledTask("notify-reaper");
  const claim = await automation.claimAutomationTaskRun({
    ...baseScope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: `nrp-lease-1`,
    scheduledFor: "2026-09-07T06:30:00.000Z",
  });
  assert.ok(claim.claimed);
  // 把租约拨回 25 分钟前，reaper 判过期并终态化为 failed。
  const stale = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  db.sqlite.prepare(`
    UPDATE automation_task_runs SET claimed_at = ?, lease_expires_at = ? WHERE run_id = ?
  `).run(stale, stale, claim.run.runId);
  db.sqlite.prepare(`
    UPDATE automation_tasks SET active_run_lease_expires_at = ? WHERE task_id = ?
  `).run(stale, task.taskId);

  const recovered = await automation.recoverExpiredAutomationTaskRuns(new Date(), 10);
  assert.ok(recovered >= 1);
  const jobs = notifyJobs(task.taskId);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].message_kind, "automation_failure");
  assert.equal(jobs[0].idempotency_key, `automation:${task.taskId}:failure:${claim.run.runId}`);
  const row = db.sqlite.prepare("SELECT error_category FROM automation_task_runs WHERE run_id = ?").get(claim.run.runId) as { error_category: string };
  assert.equal(row.error_category, "expired");
  assert.ok(jobs[0].message.includes("运行超时被系统回收"), jobs[0].message);
});
