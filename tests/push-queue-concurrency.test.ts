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
