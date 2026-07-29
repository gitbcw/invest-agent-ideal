import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const databaseDir = join(tmpdir(), `invest-agent-push-queue-${randomUUID()}`);
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

test("concurrent queue drains send one due job only once", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const { db } = await import("../src/db/index.js");
  const { weixinDeliveryAttempts } = await import("../src/db/schema.js");

  const job = await enqueuePushJob({
    userId: "push-queue-test-user",
    instanceId: "invest-agent-push-queue-test",
    message: "并发推送去重测试",
  });

  let sends = 0;
  let releaseSender: (() => void) | undefined;
  const senderStarted = new Promise<void>((resolve) => {
    releaseSender = resolve;
  });
  const sender = async () => {
    sends += 1;
    await senderStarted;
    return { ok: true as const, reason: "sent" as const };
  };

  const firstDrain = processDuePushJobs(sender);
  const secondDrain = processDuePushJobs(sender);

  for (let i = 0; i < 20 && sends === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sends, 1, "exactly one worker should acquire the job lease");

  releaseSender?.();
  await Promise.all([firstDrain, secondDrain]);

  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "sent");
  assert.equal(saved?.attempts, 1);

  const attempts = await db.select().from(weixinDeliveryAttempts);
  assert.equal(attempts.filter((attempt) => attempt.pushJobId === job.id).length, 1);
});

test("expired jobs never call the external sender", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const job = await enqueuePushJob({
    userId: "expired-push-user",
    instanceId: "invest-agent-expired-push",
    messageKind: "daily_review",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    message: "过期推送不应发送",
  });
  let sends = 0;
  const result = await processDuePushJobs(async () => {
    sends += 1;
    return { ok: true as const, reason: "sent" as const };
  });

  assert.equal(sends, 0);
  assert.equal(result.expired, 1);
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "expired");
  assert.equal(saved?.terminalReason, "expired_before_delivery");
});

test("a retry that would outlive its business expiry becomes expired", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const job = await enqueuePushJob({
    userId: "retry-expiry-user",
    instanceId: "invest-agent-retry-expiry",
    messageKind: "daily_review",
    expiresAt: new Date(Date.now() + 500).toISOString(),
    message: "重试不能越过有效期",
  });
  const result = await processDuePushJobs(async () => ({ ok: false as const, reason: "wechat_api_error" as const }));

  assert.equal(result.expired, 1);
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "expired");
  assert.equal(saved?.attempts, 1);
  assert.equal(saved?.terminalReason, "expired_before_next_delivery_retry");
});

test("permanent delivery failures stop without a retry timer", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const job = await enqueuePushJob({
    userId: "permanent-push-user",
    instanceId: "invest-agent-permanent-push",
    message: "永久错误不应重试",
  });
  const result = await processDuePushJobs(async () => ({ ok: false as const, reason: "no_connected_account" as const }));

  assert.equal(result.dead, 1);
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "dead");
  assert.equal(saved?.attempts, 1);
  assert.equal(saved?.terminalReason, "permanent_error");
});

test("expired awaiting-user jobs are not offered after the user restores a conversation", async () => {
  const { enqueuePushJob, getPushJob } = await import("../src/services/push-queue.js");
  const { listPendingWeixinDeliveries } = await import("../src/services/weixin-delivery.js");
  const { db } = await import("../src/db/index.js");
  const { pushJobs } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const job = await enqueuePushJob({
    userId: "awaiting-expiry-user",
    instanceId: "invest-agent-awaiting-expiry",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    message: "不能在恢复会话后补发的旧复盘",
  });
  await db.update(pushJobs).set({ status: "awaiting_user" }).where(eq(pushJobs.id, job.id));

  const pending = await listPendingWeixinDeliveries("awaiting-expiry-user", "invest-agent-awaiting-expiry");
  assert.deepEqual(pending, []);
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "expired");
  assert.equal(saved?.terminalReason, "expired_while_awaiting_user");
});
