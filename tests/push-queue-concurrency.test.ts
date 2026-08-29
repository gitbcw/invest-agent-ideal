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

test("restoring a conversation resumes only unexpired awaiting-user jobs", async () => {
  const { enqueuePushJob, getPushJob } = await import("../src/services/push-queue.js");
  const { resumeAwaitingWeixinDeliveries } = await import("../src/services/weixin-delivery.js");
  const { db } = await import("../src/db/index.js");
  const { pushJobs } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const job = await enqueuePushJob({
    userId: "awaiting-expiry-user",
    instanceId: "invest-agent-awaiting-expiry",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    message: "过期后不能自动重试的旧复盘",
  });
  await db.update(pushJobs).set({ status: "awaiting_user" }).where(eq(pushJobs.id, job.id));

  const result = await resumeAwaitingWeixinDeliveries("awaiting-expiry-user", "invest-agent-awaiting-expiry");
  assert.deepEqual(result, { resumed: 0, expired: 1 });
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "expired");
  assert.equal(saved?.terminalReason, "expired_while_awaiting_user");
});

test("restoring a conversation automatically requeues an unexpired awaiting-user job", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const { resumeAwaitingWeixinDeliveries } = await import("../src/services/weixin-delivery.js");
  const { db } = await import("../src/db/index.js");
  const { pushJobs } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const job = await enqueuePushJob({
    userId: "awaiting-retry-user",
    instanceId: "invest-agent-awaiting-retry",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    message: "会话恢复后由队列自动重试",
  });
  await db.update(pushJobs).set({ status: "awaiting_user" }).where(eq(pushJobs.id, job.id));

  const result = await resumeAwaitingWeixinDeliveries("awaiting-retry-user", "invest-agent-awaiting-retry");
  assert.deepEqual(result, { resumed: 1, expired: 0 });
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "retry");
  assert.ok(saved?.nextRetryAt);

  let sends = 0;
  await processDuePushJobs(async () => {
    sends += 1;
    return { ok: true as const, reason: "sent" as const };
  });
  assert.equal(sends, 1);
  assert.equal((await getPushJob(job.id))?.status, "sent");
});

test("automation push hitting context_expired parks as awaiting_user with a default validity window", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const job = await enqueuePushJob({
    userId: "automation-awaiting-user",
    instanceId: "invest-agent-automation-awaiting",
    source: "automation",
    messageKind: "automation_summary",
    message: "复盘推送等待用户回到微信会话",
  });
  assert.ok(job.expiresAt, "automation enqueue gets a default business validity window");
  assert.ok(Date.parse(job.expiresAt) > Date.now());

  const result = await processDuePushJobs(async () => ({ ok: false as const, reason: "context_expired" as const }));
  assert.equal(result.awaitingUser, 1);
  assert.equal(result.dead, 0);
  const saved = await getPushJob(job.id);
  assert.equal(saved?.status, "awaiting_user");
  assert.equal(saved?.terminalReason, null);
});

test("automation awaiting_user job resumes and sends after the user conversation returns", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const { resumeAwaitingWeixinDeliveries } = await import("../src/services/weixin-delivery.js");
  const job = await enqueuePushJob({
    userId: "automation-resume-user",
    instanceId: "invest-agent-automation-resume",
    source: "automation",
    messageKind: "automation_summary",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    message: "会话恢复后补投的复盘推送",
  });
  const parked = await processDuePushJobs(async () => ({ ok: false as const, reason: "context_expired" as const }));
  assert.equal(parked.awaitingUser, 1);

  const result = await resumeAwaitingWeixinDeliveries("automation-resume-user", "invest-agent-automation-resume");
  assert.deepEqual(result, { resumed: 1, expired: 0 });

  let sends = 0;
  await processDuePushJobs(async () => {
    sends += 1;
    return { ok: true as const, reason: "sent" as const };
  });
  assert.equal(sends, 1);
  assert.equal((await getPushJob(job.id))?.status, "sent");
});
