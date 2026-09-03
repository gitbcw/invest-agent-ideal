import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-validity-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const baseScope = { userId: "validity-user", projectId: "invest-agent", instanceId: "validity-instance" };

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const pushQueue = await import("../src/services/push-queue.js");
  const weixinDelivery = await import("../src/services/weixin-delivery.js");
  return { db, automation, runner, pushQueue, weixinDelivery };
})();

/** 复刻 2026-09-03 事故链路：dyk 盘中简报因 context_expired 挂起后，带着
 * 超过业务时效的 expiresAt 被次日早间的用户消息 resume 补发。修复 = 任务级
 * validityMinutes 折算成显式 expiresAt，短时效窗口过期后 resume 直接判死。 */
async function runWatchTask(taskId: string, validityMinutes?: number) {
  const { automation, runner } = await fixture;
  // 每个用例独立 instance：resume/process 的作用域按 instance 圈定，
  // 避免其他用例挂起的 job 混进本用例的队列断言。
  const scope = { ...baseScope, instanceId: `validity-instance-${taskId}` };
  const task = await automation.createAutomationTask({
    ...scope,
    taskId,
    name: "盘中盯盘",
    instruction: "观察盘中异动并输出摘要。",
    schedule: { frequency: "trading_days" as const, time: "14:30", timezone: "Asia/Shanghai", windows: ["09:55", "14:30"] },
    output: { mode: "none" },
    delivery: validityMinutes === undefined
      ? { mode: "wechat_summary" as const }
      : { mode: "wechat_summary" as const, validityMinutes },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const pushed = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: `${taskId}-once`,
    executor: async () => ({ content: { type: "text" as const, text: "ok" }, finished: true, data: { summary: "盘中无异动。", shouldNotify: true } }),
  });
  return { pushed, scope };
}

test("delivery validityMinutes overrides the 24h default expiry at enqueue time", async () => {
  const { db } = await fixture;
  const { pushed } = await runWatchTask("validity-watch-short", 120);
  assert.ok(pushed.run.pushJobId);
  const job = db.sqlite.prepare("SELECT expires_at, created_at FROM push_jobs WHERE id = ?").get(pushed.run.pushJobId) as { expires_at: string; created_at: string };
  const ttlMs = Date.parse(job.expires_at) - Date.parse(job.created_at);
  assert.ok(Math.abs(ttlMs - 120 * 60 * 1000) < 5 * 1000, `expected ~120min business validity, got ${Math.round(ttlMs / 60000)}min`);
});

test("tasks without validityMinutes keep the 24h automation default", async () => {
  const { db } = await fixture;
  const { pushed } = await runWatchTask("validity-watch-default");
  assert.ok(pushed.run.pushJobId);
  const job = db.sqlite.prepare("SELECT expires_at, created_at FROM push_jobs WHERE id = ?").get(pushed.run.pushJobId) as { expires_at: string; created_at: string };
  const ttlMs = Date.parse(job.expires_at) - Date.parse(job.created_at);
  assert.ok(Math.abs(ttlMs - 24 * 60 * 60 * 1000) < 60 * 1000, `expected ~24h default validity, got ${Math.round(ttlMs / 60000)}min`);
});

test("an intraday brief parked overnight past its validity expires instead of resuming (2026-09-03 incident)", async () => {
  const { db, pushQueue, weixinDelivery } = await fixture;
  const { pushed, scope } = await runWatchTask("validity-watch-overnight", 120);
  const pushJobId = pushed.run.pushJobId!;

  // 昨天盘中：客服窗口过期，推送挂起 awaiting_user（当时仍在 120min 时效内）。
  await pushQueue.processDuePushJobs(async () => ({ ok: false as const, reason: "context_expired" as const }));
  let parked = db.sqlite.prepare("SELECT status FROM push_jobs WHERE id = ?").get(pushJobId) as { status: string };
  assert.equal(parked.status, "awaiting_user");

  // 时间流逝到次日早晨：把时间基线整体平移 3h —— 超出 120min 时效，
  // 但若任务仍落在 24h 默认窗口内（事故形态），resume 就会错误补发。
  const shifted = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  db.sqlite.prepare("UPDATE push_jobs SET created_at = ?, expires_at = ? WHERE id = ?").run(shifted, shifted, pushJobId);

  const result = await weixinDelivery.resumeAwaitingWeixinDeliveries(scope.userId, scope.instanceId);
  assert.deepEqual(result, { resumed: 0, expired: 1 });
  const job = db.sqlite.prepare("SELECT status, terminal_reason FROM push_jobs WHERE id = ?").get(pushJobId) as { status: string; terminal_reason: string };
  assert.equal(job.status, "expired");
  assert.equal(job.terminal_reason, "expired_while_awaiting_user");

  let sends = 0;
  await pushQueue.processDuePushJobs(async () => {
    sends += 1;
    return { ok: true as const, reason: "sent" as const };
  });
  assert.equal(sends, 0, "an expired intraday brief must never reach the sender");
});

test("invalid validityMinutes values are rejected at task creation", async () => {
  const { automation } = await fixture;
  for (const bad of [0, -30, Number.NaN, "90" as unknown as number]) {
    await assert.rejects(
      automation.createAutomationTask({
        ...baseScope,
        taskId: `validity-watch-bad-${String(bad)}`,
        name: "非法时效",
        instruction: "观察市场。",
        schedule: { frequency: "daily" as const, time: "07:30", timezone: "Asia/Shanghai" },
        output: { mode: "none" },
        delivery: { mode: "wechat_summary", validityMinutes: bad },
      }),
      /AUTOMATION_INVALID_OUTPUT_POLICY/,
    );
  }
  await assert.rejects(
    automation.createAutomationTask({
      ...baseScope,
      taskId: "validity-watch-none-bad",
      name: "none 模式带时效",
      instruction: "观察市场。",
      schedule: { frequency: "daily" as const, time: "07:30", timezone: "Asia/Shanghai" },
      output: { mode: "none" },
      delivery: { mode: "none", validityMinutes: 90 },
    }),
    /AUTOMATION_INVALID_OUTPUT_POLICY/,
  );
});
