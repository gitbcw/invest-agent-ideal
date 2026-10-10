import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-delivery-fallback-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const baseScope = { userId: "fallback-user", projectId: "invest-agent", instanceId: "fallback-instance" };

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const push = await import("../src/services/push-queue.js");
  const weixinDelivery = await import("../src/services/weixin-delivery.js");
  const attention = await import("../src/services/attention-items.js");
  return { db, automation, push, weixinDelivery, attention };
})();

const SUMMARY_MESSAGE = "**本周复盘要点**\n\n上证回落至 3813 后放量反弹，情绪回暖；持仓无触发动作。";

async function createTask(taskId: string) {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...baseScope,
    taskId,
    name: `兜底测试-${taskId}`,
    instruction: "测试任务。",
    schedule: { frequency: "trading_days" as const, time: "18:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...baseScope, taskId: task.taskId, expectedRevision: 1 });
  return task;
}

test("summary push hitting closed WeChat window registers a delivery_fallback attention item (T-584)", async () => {
  const { push, attention, db } = await fixture;
  const task = await createTask("fallback-awaiting");
  await push.enqueuePushJob({
    ...baseScope,
    source: "automation",
    messageKind: "automation_summary",
    originTaskKey: task.taskId,
    originRunId: "atrun-fallback-awaiting",
    message: SUMMARY_MESSAGE,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: "automation:atrun-fallback-awaiting:delivery",
  });

  const outcome = await push.processDuePushJobs(async () => ({ ok: false, reason: "context_expired" as const }));
  assert.equal(outcome.awaitingUser, 1);

  const items = attention.listAttentionItems(baseScope);
  const fallback = items.find((item) => item.kind === "delivery_fallback");
  assert.ok(fallback, "delivery_fallback item must exist");
  assert.equal(fallback.runId, "atrun-fallback-awaiting");
  assert.ok(fallback.title.includes("兜底测试"), fallback.title);
  assert.equal(fallback.status, "open");

  // dedup per run：重复登记不产生第二条。
  attention.recordDeliveryFallbackAttention({ scope: baseScope, taskId: task.taskId, runId: "atrun-fallback-awaiting" });
  const again = attention.listAttentionItems(baseScope).filter((item) => item.kind === "delivery_fallback");
  assert.equal(again.length, 1);

  // 非 summary 的挂起推送不登记兜底。
  await push.enqueuePushJob({
    ...baseScope,
    source: "automation",
    messageKind: "automation_failure",
    originRunId: "atrun-fallback-nosummary",
    message: "【定时任务失败】",
    idempotencyKey: "automation:atrun-fallback-nosummary:failure",
  });
  await push.processDuePushJobs(async () => ({ ok: false, reason: "context_expired" as const }));
  const afterNonSummary = attention.listAttentionItems(baseScope).filter((item) => item.kind === "delivery_fallback");
  assert.equal(afterNonSummary.length, 1);
  void db;
});

test("resumed summary delivery auto-resolves the fallback item", async () => {
  const { push, weixinDelivery, attention } = await fixture;
  const { resumed } = await weixinDelivery.resumeAwaitingWeixinDeliveries(baseScope.userId, baseScope.instanceId);
  assert.equal(resumed, 2, "both awaiting jobs (summary + failure notice) resume");

  const outcome = await push.processDuePushJobs(async () => true);
  assert.equal(outcome.sent, 2);

  const items = attention.listAttentionItems(baseScope, { status: "resolved" });
  const fallback = items.find((item) => item.kind === "delivery_fallback");
  assert.ok(fallback);
  assert.equal(fallback.status, "resolved", "fallback must auto-resolve after successful resume delivery");
});

test("opening the fallback conversation seeds the full summary content", async () => {
  const { push, attention } = await fixture;
  const task = await createTask("fallback-conversation");
  await push.enqueuePushJob({
    ...baseScope,
    source: "automation",
    messageKind: "automation_summary",
    originTaskKey: task.taskId,
    originRunId: "atrun-fallback-conv",
    message: SUMMARY_MESSAGE,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    idempotencyKey: "automation:atrun-fallback-conv:delivery",
  });
  await push.processDuePushJobs(async () => ({ ok: false, reason: "context_expired" as const }));
  const item = attention.listAttentionItems(baseScope).find((row) => row.kind === "delivery_fallback" && row.runId === "atrun-fallback-conv");
  assert.ok(item);

  const opened = attention.openAttentionConversation(baseScope, item.itemId);
  assert.ok(opened.conversationId.startsWith("attention-"));
  const { db } = await fixture;
  const seeded = db.sqlite
    .prepare("SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = 'system'")
    .get(opened.conversationId) as { content: string } | undefined;
  assert.ok(seeded, "system seed message must exist");
  assert.ok(seeded!.content.includes(SUMMARY_MESSAGE), "seed must embed the full summary text");
});
