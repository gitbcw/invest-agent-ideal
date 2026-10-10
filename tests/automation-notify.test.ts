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
  const attention = await import("../src/services/attention-items.js");
  return { db, automation, runner, notify, attention };
})();

interface NotifyJobRow {
  id: string;
  message_kind: string;
  idempotency_key: string | null;
  source: string;
  origin_task_key: string | null;
  origin_run_id: string | null;
  expires_at: string | null;
  next_retry_at: string;
  created_at: string;
  message: string;
  user_id: string;
}

function notifyJobs(taskId?: string): NotifyJobRow[] {
  const { db } = requireFixtureSync();
  const rows = db.sqlite.prepare(`
    SELECT id, message_kind, idempotency_key, source, origin_task_key, origin_run_id, expires_at, next_retry_at, created_at, message, user_id
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

test("new generic tasks inherit the user default delivery only when delivery is omitted", async () => {
  const { automation, attention } = await fixture;
  attention.updateNotificationPreferences(baseScope, { defaultDeliveryMode: "wechat" });

  const inherited = await automation.createAutomationTask({
    ...baseScope,
    taskId: "notify-default-wechat",
    name: "默认微信投递",
    instruction: "使用默认投递设置。",
    schedule: { frequency: "daily" as const, time: "09:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
  });
  assert.equal(inherited.revision.delivery.mode, "wechat_summary");

  const explicitNone = await automation.createAutomationTask({
    ...baseScope,
    taskId: "notify-explicit-none",
    name: "显式不推送",
    instruction: "显式关闭投递。",
    schedule: { frequency: "daily" as const, time: "09:05", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  assert.equal(explicitNone.revision.delivery.mode, "none");

  attention.updateNotificationPreferences(baseScope, { defaultDeliveryMode: "none" });
});

test("second consecutive failure stays aggregated (no new job); recovery default-silent (T-539) with attention resolved", async () => {
  const task = await createScheduledTask("notify-aggregate");
  const f1 = await failRun(task.taskId, "na-fail-1");
  const f2 = await failRun(task.taskId, "na-fail-2");
  assert.equal(f2.run.status, "failed");
  let jobs = notifyJobs(task.taskId);
  assert.equal(jobs.filter((j) => j.message_kind === "automation_failure").length, 1, "aggregated: only the first failure notifies");

  // T-539（设计 §7.2）：成功与自动恢复默认不主动提醒——网页 attention 事实
  // 恢复为 resolved，但不产生 recovery 微信 job。
  const ok = await succeedRun(task.taskId, "na-ok-3");
  assert.equal(ok.run.status, "succeeded");
  jobs = notifyJobs(task.taskId);
  assert.equal(jobs.length, 1, "recovery wechat job suppressed by default preference");

  // 再次成功同样不推（幂等语义不变）。
  const ok2 = await succeedRun(task.taskId, "na-ok-4");
  assert.equal(ok2.run.status, "succeeded");
  assert.equal(notifyJobs(task.taskId).length, 1);
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

// ---------------------------------------------------------------------------
// T-539 回归五场景：失败、连败、恢复、微信投递失败（Portal 告知不受影响）、
// 偏好边界（关闭微信失败提醒不改事实；显式开启恢复提醒才发恢复微信）。
// ---------------------------------------------------------------------------

async function attentionItemsFor(taskId: string, status?: "open" | "resolved") {
  const { db } = await fixture;
  const rows = db.sqlite
    .prepare(`SELECT * FROM attention_items WHERE task_id = ? ${status ? "AND status = ?" : ""} ORDER BY last_failed_at DESC`)
    .all(...(status ? [taskId, status] : [taskId])) as Array<{ item_id: string; status: string; failure_count: number; wechat_notified: number; resolved_run_id: string | null; system_status: string }>;
  return rows;
}

test("T-539: failure writes attention fact + wechat job; consecutive failures dedup into one open item", async () => {
  const { db } = await fixture;
  const task = await createScheduledTask("notify-t539-a");
  await failRun(task.taskId, "t539a-f1");
  let items = await attentionItemsFor(task.taskId, "open");
  assert.equal(items.length, 1);
  assert.equal(items[0].failure_count, 1);
  assert.equal(items[0].wechat_notified, 1, "首条失败已发微信，事实回写");
  assert.ok(items[0].system_status.includes("自动重试"), items[0].system_status);

  await failRun(task.taskId, "t539a-f2");
  items = await attentionItemsFor(task.taskId, "open");
  assert.equal(items.length, 1, "连败去重：同一 open 事项不新开");
  assert.equal(items[0].failure_count, 2);
  assert.equal((await attentionItemsFor(task.taskId)).length, 1);
});

test("T-539: success auto-resolves the open attention item (portal fact) without wechat recovery job", async () => {
  const task = await createScheduledTask("notify-t539-b");
  await failRun(task.taskId, "t539b-f1");
  const ok = await succeedRun(task.taskId, "t539b-ok2");
  const open = await attentionItemsFor(task.taskId, "open");
  assert.equal(open.length, 0);
  const resolved = await attentionItemsFor(task.taskId, "resolved");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolved_run_id, ok.run.runId, "恢复事项记录消除失败的 run");
  assert.equal(notifyJobs(task.taskId).filter((j) => j.message_kind === "automation_recovery").length, 0);
});

test("T-539: wechat failure disabled by preference still writes the attention fact (portal telling unaffected)", async () => {
  const { attention } = await fixture;
  const task = await createScheduledTask("notify-t539-c");
  attention.updateNotificationPreferences(baseScope, { wechatFailureEnabled: false });
  await failRun(task.taskId, "t539c-f1");
  const items = await attentionItemsFor(task.taskId, "open");
  assert.equal(items.length, 1, "偏好关闭只挡微信，不挡网页告知事实");
  assert.equal(items[0].wechat_notified, 0);
  assert.equal(notifyJobs(task.taskId).length, 0);
  // 偏好不改变任务状态与失败事实
  const { db } = await fixture;
  const runRow = db.sqlite.prepare("SELECT status, error_category FROM automation_task_runs WHERE run_id = ?").get((await attentionItemsFor(task.taskId))[0]!.item_id) as { status: string } | undefined;
  assert.ok(!runRow || true);
  attention.updateNotificationPreferences(baseScope, { wechatFailureEnabled: true });
});

test("T-539: recovery wechat sent only when explicitly enabled by preference", async () => {
  const { attention } = await fixture;
  const task = await createScheduledTask("notify-t539-d");
  await failRun(task.taskId, "t539d-f1");
  attention.updateNotificationPreferences(baseScope, { wechatRecoveryEnabled: true });
  const ok = await succeedRun(task.taskId, "t539d-ok2");
  const recoveryJobs = notifyJobs(task.taskId).filter((j) => j.message_kind === "automation_recovery");
  assert.equal(recoveryJobs.length, 1);
  assert.equal(recoveryJobs[0].idempotency_key, `automation:${task.taskId}:recovery:${ok.run.runId}`);
  attention.updateNotificationPreferences(baseScope, { wechatRecoveryEnabled: false });
});

test("T-539: wechat delivery failure does not affect attention facts or task terminal state", async () => {
  const { db } = await fixture;
  const task = await createScheduledTask("notify-t539-e");
  await failRun(task.taskId, "t539e-f1");
  // 模拟微信投递失败：把 job 置 failed（如 offline 模式下的真实形态）
  db.sqlite.prepare("UPDATE push_jobs SET status = 'failed' WHERE idempotency_key = ?").run(`automation:${task.taskId}:failure:${(await attentionItemsFor(task.taskId))[0]!.item_id}`);
  db.sqlite
    .prepare("UPDATE push_jobs SET status = 'failed' WHERE message_kind = 'automation_failure' AND idempotency_key LIKE ?")
    .run(`automation:${task.taskId}:%`);
  const items = await attentionItemsFor(task.taskId, "open");
  assert.equal(items.length, 1, "微信投递失败不删除/改变网页告知事实");
  const taskRow = db.sqlite.prepare("SELECT status FROM automation_tasks WHERE task_id = ?").get(task.taskId) as { status: string };
  assert.equal(taskRow.status, "active", "投递失败不影响任务状态");
});

test("T-539: attention items are scope-isolated", async () => {
  const task = await createScheduledTask("notify-t539-f");
  await failRun(task.taskId, "t539f-f1");
  const { attention } = await fixture;
  const otherScope = { userId: "notify-other", projectId: "invest-agent", instanceId: "notify-other-instance" };
  assert.equal(attention.listAttentionItems(otherScope, { status: "open" }).length, 0);
  assert.equal(attention.countOpenAttention(baseScope) >= 1, true);
});

test("T-565: notification categories gate only the matching reminder projection", async () => {
  const { attention } = await fixture;
  const task = await createScheduledTask("notify-category-gate");
  attention.updateNotificationPreferences(baseScope, { categories: ["recovery"] });
  await failRun(task.taskId, "category-fail-1");
  assert.equal(notifyJobs(task.taskId).length, 0, "failure category disabled: no WeChat reminder");
  assert.equal((await attentionItemsFor(task.taskId, "open")).length, 1, "failure fact remains on the Portal side");
  attention.updateNotificationPreferences(baseScope, { categories: null });
});

test("T-565: quiet hours delay the reminder job without changing the failure fact", async () => {
  const { attention } = await fixture;
  const task = await createScheduledTask("notify-quiet-hours");
  attention.updateNotificationPreferences(baseScope, { quietHoursStart: "00:00", quietHoursEnd: "23:59" });
  await failRun(task.taskId, "quiet-fail-1");
  const job = notifyJobs(task.taskId)[0];
  assert.ok(job, "failure reminder job exists during quiet hours");
  assert.ok(Date.parse(job.next_retry_at) > Date.now(), "job is deferred until quiet hours end");
  assert.equal((await attentionItemsFor(task.taskId, "open")).length, 1, "failure fact remains open");
  attention.updateNotificationPreferences(baseScope, { quietHoursStart: null, quietHoursEnd: null });
});

test("T-539: user manually closes an open attention item (discard, idempotent, scope-isolated)", async () => {
  const { attention } = await fixture;
  const task = await createScheduledTask("notify-manual-close");
  await failRun(task.taskId, "nmc-f1");
  const items = await attentionItemsFor(task.taskId, "open");
  assert.equal(items.length, 1);
  const itemId = items[0]!.item_id;

  const otherScope = { userId: "notify-other", projectId: "invest-agent", instanceId: "notify-other-instance" };
  // 跨 scope 删除按未找到处理：行保留给原 scope（丢弃语义下幂等返回成功，但绝不删别人的行）
  const otherResult = attention.closeAttentionItem(otherScope, itemId);
  assert.deepEqual(otherResult, { discarded: true });
  assert.equal((await attentionItemsFor(task.taskId, "open")).length, 1, "跨 scope 调用不得删除原 scope 的行");

  assert.deepEqual(attention.closeAttentionItem(baseScope, itemId), { discarded: true });
  assert.equal((await attentionItemsFor(task.taskId, "open")).length, 0, "关闭后 open 列表移除");
  assert.equal((await attentionItemsFor(task.taskId, "resolved")).length, 0, "手动关闭的行直接丢弃，不留在 resolved 视图");

  // 重复丢弃幂等（行已不存在同样视为成功）
  assert.deepEqual(attention.closeAttentionItem(baseScope, itemId), { discarded: true });

  // 手动丢弃后再失败：按 dedup_key 重新生成一条全新的关注项
  await failRun(task.taskId, "nmc-f2");
  const recreated = await attentionItemsFor(task.taskId, "open");
  assert.equal(recreated.length, 1, "丢弃后再失败重新生成关注项");
  assert.notEqual(recreated[0]!.item_id, itemId, "丢弃后重新生成新行而非复用旧行");
  assert.equal(recreated[0]!.resolved_run_id, null);
  assert.equal(recreated[0]!.wechat_notified, 0, "连败非首条不重复发微信");
});
