import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const databaseDir = join(tmpdir(), `invest-agent-weixin-governance-${randomUUID()}`);
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

test("weixinErrorCode classifies the four canonical cases from structured codes and legacy strings (T-452)", async () => {
  const { WeixinPushError, weixinErrorCode } = await import("../src/channels/weixin-shared.js");

  assert.equal(weixinErrorCode(new WeixinPushError("context_expired", "x")), "context_expired");
  assert.equal(weixinErrorCode(new WeixinPushError("session_expired", "x")), "session_expired");
  assert.equal(weixinErrorCode(new WeixinPushError("wechat_api_error", "x")), "wechat_api_error");
  // Legacy job lastError strings from before the structured codes existed.
  assert.equal(weixinErrorCode(new Error("微信主动推送失败: ret=-2 context expired")), "context_expired");
  assert.equal(weixinErrorCode(new Error("微信主动推送失败: errcode=-14 请重新扫码")), "session_expired");
  assert.equal(weixinErrorCode(new Error("微信主动推送失败: session timeout")), "session_expired");
  assert.equal(weixinErrorCode(new Error("微信主动推送失败: errcode=1 other")), "wechat_api_error");
  assert.equal(weixinErrorCode(null), "wechat_api_error");
});

test("partnerFailureCategory keeps context_expired distinct from session_expired (T-452)", () => {
  const platform = readFileSync(new URL("../src/routes/platform.ts", import.meta.url), "utf8");
  // The classifier must consult the shared weixinErrorCode and surface
  // context_expired before the blanket session_expired branch.
  assert.match(platform, /import \{ weixinErrorCode \} from "\.\.\/channels\/weixin-shared\.js";/);
  assert.match(platform, /if \(weixinCode === "context_expired"\) return "context_expired";/);
  assert.doesNotMatch(platform, /text\.includes\("context"\) \|\| text\.includes\("session"\)/);
});

test("a mid-message chunk failure persists sentChunks and the retry skips already-delivered chunks (T-452)", async () => {
  const { enqueuePushJob, getPushJob, processDuePushJobs } = await import("../src/services/push-queue.js");
  const { db, sqlite } = await import("../src/db/index.js");
  const { pushJobs } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");

  const job = await enqueuePushJob({
    userId: "weixin-governance-user",
    instanceId: "invest-agent-weixin-governance",
    message: "分片重投测试",
  });

  const receivedSkipChunks: number[] = [];
  const sender = async (input: { sentChunks: number }) => {
    receivedSkipChunks.push(input.sentChunks);
    // First attempt: chunks 0 and 1 delivered, chunk 2 fails.
    if (receivedSkipChunks.length === 1) {
      return { ok: false as const, reason: "wechat_api_error" as const, sentChunks: 2 };
    }
    // Retry: skipChunks must be 2 — only chunk 2 is sent again.
    return { ok: true as const, reason: "sent" as const, sentChunks: 3 };
  };

  const first = await processDuePushJobs(sender);
  assert.equal(first.retried, 1);
  const afterFailure = await getPushJob(job.id);
  assert.equal(afterFailure?.status, "retry");
  assert.equal(afterFailure?.sentChunks, 2, "partial delivery progress must be persisted for the retry");

  // The retry is scheduled 60s out; age the job so the next drain picks it up.
  await db.update(pushJobs)
    .set({ nextRetryAt: new Date(Date.now() - 1_000).toISOString() })
    .where(eq(pushJobs.id, job.id));

  const second = await processDuePushJobs(sender);
  assert.equal(second.sent, 1);
  assert.deepEqual(receivedSkipChunks, [0, 2], "retry must skip the two already-delivered chunks");
  const done = await getPushJob(job.id);
  assert.equal(done?.status, "sent");

  // awaiting_user (context_expired mid-delivery) also keeps its progress.
  const heldJob = await enqueuePushJob({
    userId: "weixin-governance-user",
    instanceId: "invest-agent-weixin-governance",
    message: "挂起进度测试",
  });
  const deferSender = async () => ({ ok: false as const, reason: "context_expired" as const, sentChunks: 1 });
  await processDuePushJobs(deferSender);
  const held = sqlite.prepare("SELECT status, sent_chunks FROM push_jobs WHERE id = ?").get(heldJob.id) as { status: string; sent_chunks: number };
  assert.equal(held.status, "awaiting_user");
  assert.equal(held.sent_chunks, 1);
});
