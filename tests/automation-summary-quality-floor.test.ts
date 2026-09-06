import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * BC-20260904-001（owner 2026-09-06 裁决：服务层质量下限）：wechat_summary
 * 到点必推，但空壳/过短 summary 不得照推——推送入队前降级为服务层模板（引用
 * 原文开头），落库的 result_summary 保持模型原文（诊断证据不被改写）。
 * 全链断言走 runGenericAutomationTaskNow → deliverResult → enqueuePushJob。
 */
const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-summary-floor-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "floor.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  return { db, automation, runner };
})();

async function runSummaryTask(taskId: string, summary: string) {
  const { automation, runner } = await fixture;
  const scope = { userId: "floor-user", projectId: "invest-agent", instanceId: `floor-instance-${taskId}` };
  const task = await automation.createAutomationTask({
    ...scope,
    taskId,
    name: "盘中盯盘",
    instruction: "观察盘中异动并输出摘要。",
    schedule: { frequency: "trading_days" as const, time: "11:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "wechat_summary" as const },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const pushed = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: `${taskId}-once`,
    executor: async () => ({
      content: { type: "text" as const, text: "ok" },
      finished: true,
      data: { summary, shouldNotify: true },
    }),
  });
  return { pushed, scope };
}

test("short shell summary is replaced by the service floor template at push time", async () => {
  const { db } = await fixture;
  const { pushed } = await runSummaryTask("floor-shell", "今日盯盘完成。");
  assert.equal(pushed.run.status, "succeeded");
  assert.ok(pushed.run.pushJobId, "delivery stays enqueued (到点必推不变)");
  const job = db.sqlite.prepare("SELECT message FROM push_jobs WHERE id = ?").get(pushed.run.pushJobId) as { message: string };
  assert.ok(job.message.includes("未达质量下限"), "degraded template marker");
  assert.ok(job.message.includes("今日盯盘完成。"), "original summary quoted");
  assert.ok(job.message.includes("盘中盯盘"), "task name surfaced");
  // 诊断证据保持模型原文：服务层只改推送消息，不改写 result_summary。
  const run = db.sqlite.prepare("SELECT result_summary FROM automation_task_runs WHERE run_id = ?").get(pushed.run.runId) as { result_summary: string | null };
  assert.equal(run.result_summary, "今日盯盘完成。");
});

test("qualified summary passes through to the push job unchanged", async () => {
  const { db } = await fixture;
  const summary = "沪指盘中回落 0.6%，持仓九只全绿，科创50 跌 1.2%，无触发异动；继续持有现有仓位，午后关注 3200 点支撑与量能变化。";
  const { pushed } = await runSummaryTask("floor-pass", summary);
  assert.ok(pushed.run.pushJobId);
  const job = db.sqlite.prepare("SELECT message FROM push_jobs WHERE id = ?").get(pushed.run.pushJobId) as { message: string };
  assert.equal(job.message, summary);
});

test("floor helpers: trim, exact boundary, whitespace collapse, 80-char original cap", async () => {
  const { AUTOMATION_SUMMARY_MIN_CHARS, meetsSummaryQualityFloor, degradedSummaryMessage } =
    await import("../src/services/generic-automation-runner.js");
  assert.equal(meetsSummaryQualityFloor("   "), false, "whitespace-only is a shell");
  assert.equal(meetsSummaryQualityFloor("x".repeat(AUTOMATION_SUMMARY_MIN_CHARS)), true, "exact boundary passes");
  assert.equal(meetsSummaryQualityFloor("x".repeat(AUTOMATION_SUMMARY_MIN_CHARS - 1)), false);
  const degraded = degradedSummaryMessage("a b ".repeat(40), "任务A");
  assert.ok(degraded.includes("任务A"));
  assert.ok(degraded.length < 200, `original must be capped at 80 chars, got ${degraded.length}`);
  const collapsed = degradedSummaryMessage("word\n\n  word2", "t");
  assert.ok(collapsed.includes("word word2"), "whitespace collapsed in quoted original");
});
