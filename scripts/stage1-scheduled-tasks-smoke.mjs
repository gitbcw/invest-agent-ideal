#!/usr/bin/env node
/**
 * 阶段一烟测:复盘/定时推送可靠承接的核心契约。
 *
 * 约束:
 * - 不创建新的测试用户或实例。
 * - 使用主用户投资助手 scope: primary / invest-agent-primary。
 * - 会创建临时 push_jobs 记录,结束前按 id 清理。
 *
 * 用法:npm run build && node scripts/stage1-scheduled-tasks-smoke.mjs
 */

import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildScheduledReviewPush, sanitizeScheduledReply } from "../dist/acp/scheduled-tasks.js";
import { readSchedules, entryHitsNow } from "../dist/lib/schedules-loader.js";
import { enqueuePushJob, getPushJob, processDuePushJobs } from "../dist/services/push-queue.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../dist/lib/user-context.js";
import { db } from "../dist/db/index.js";
import { pushJobs, scheduledTaskRuns } from "../dist/db/schema.js";
import { claimScheduledTaskRun, finishScheduledTaskRun } from "../dist/services/scheduled-task-runs.js";

const createdJobIds = [];
const createdTaskKeys = [];

function log(label) {
  console.log(`\n[stage1] ${label}`);
}

async function cleanup() {
  for (const id of createdJobIds) {
    await db.delete(pushJobs).where(eq(pushJobs.id, id)).catch(() => undefined);
  }
  for (const key of createdTaskKeys) {
    await db.delete(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, key)).catch(() => undefined);
  }
}

try {
  log("scheduled reply 清洗");
  assert.equal(sanitizeScheduledReply("NO_PUSH"), "NO_PUSH");
  assert.equal(sanitizeScheduledReply("NO_PUSH。"), "NO_PUSH");
  assert.equal(sanitizeScheduledReply("当前无提醒。"), "NO_PUSH");
  assert.equal(sanitizeScheduledReply("暂无提醒，今天不用打扰用户。"), "NO_PUSH");
  assert.equal(sanitizeScheduledReply("无需推送：没有 P0/P1。"), "NO_PUSH");
  assert.equal(sanitizeScheduledReply("我先核对低打扰规则，再调用本轮巡检接口。\nNO_PUSH"), "NO_PUSH");
  assert.match(sanitizeScheduledReply("赛轮轮胎触发 P0,需要确认。"), /赛轮轮胎/);
  console.log("  ✓ NO_PUSH 与中文无推送语义清洗正确");

  log("scheduled review 推送保留最终正文");
  const longReview = [
    "# 2026-07-01 周复盘",
    "",
    "## 一、核心结论",
    "本周以观察为主。",
    "",
    "## 二、事实",
    "事实 1",
    "事实 2",
    "事实 3",
    "事实 4",
    "事实 5",
    "事实 6",
    "事实 7",
    "事实 8",
    "事实 9",
    "",
    "## 三、后续验证点",
    "这一段位于第 8 个非空行之后，不能被服务层截断。",
  ].join("\n");
  const pushedReview = buildScheduledReviewPush("周复盘", longReview);
  assert.equal(pushedReview, longReview);
  assert.match(pushedReview, /后续验证点/);
  console.log("  ✓ 周/月复盘推送不再裁剪为前 8 行摘要");

  log("主用户 schedules.yaml 解析");
  const schedules = readSchedules(DEFAULT_USER_ID);
  assert.equal(schedules.timezone, "Asia/Shanghai");
  assert.equal(schedules.daily_review?.enabled, true);
  assert.equal(schedules.market_watch?.enabled, true);
  assert.ok(Array.isArray(schedules.market_watch?.default_windows), "market_watch.default_windows should be an array");
  assert.equal(entryHitsNow({ enabled: true, default_time: "19:00" }, new Date("2026-06-22T11:00:00.000Z")), true);
  assert.equal(entryHitsNow({ enabled: true, auto_run: false, default_time: "19:00" }, new Date("2026-06-22T11:00:00.000Z")), false);
  console.log(`  ✓ 主用户 ${DEFAULT_USER_ID}/${DEFAULT_INSTANCE_ID} schedules 可读`);

  log("scheduled_task_runs 跨进程抢锁契约");
  const taskKey = `stage1-smoke:${Date.now()}`;
  createdTaskKeys.push(taskKey);
  const firstClaim = await claimScheduledTaskRun({
    taskKey,
    taskType: "stage1-smoke",
    scheduledFor: "2026-06-28T19:00",
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
  });
  const secondClaim = await claimScheduledTaskRun({
    taskKey,
    taskType: "stage1-smoke",
    scheduledFor: "2026-06-28T19:00",
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
  });
  assert.equal(firstClaim, true);
  assert.equal(secondClaim, false);
  await finishScheduledTaskRun(taskKey, { status: "success", pushJobId: "stage1-smoke-job" });
  const [taskRun] = await db.select().from(scheduledTaskRuns).where(eq(scheduledTaskRuns.taskKey, taskKey)).limit(1);
  assert.equal(taskRun.status, "success");
  assert.equal(taskRun.pushJobId, "stage1-smoke-job");
  console.log("  ✓ 同一 taskKey 只能被领取一次,完成状态可记录");

  log("push_jobs 成功投递状态流转");
  const okJob = await enqueuePushJob({
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
    source: "stage1-smoke",
    message: "[stage1-smoke] push queue success contract",
    maxAttempts: 2,
  });
  createdJobIds.push(okJob.id);
  const okResult = await processDuePushJobs(async (job) => {
    assert.equal(job.userId, DEFAULT_USER_ID);
    assert.equal(job.instanceId, DEFAULT_INSTANCE_ID);
    assert.equal(job.backend, "codex");
    return true;
  }, { limit: 5 });
  assert.equal(okResult.sent, 1);
  const okUpdated = await getPushJob(okJob.id);
  assert.equal(okUpdated?.status, "sent");
  assert.equal(okUpdated?.attempts, 1);
  console.log("  ✓ push job 成功时进入 sent");

  log("push_jobs 失败重试状态流转");
  const retryJob = await enqueuePushJob({
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
    source: "stage1-smoke",
    message: "[stage1-smoke] push queue retry contract",
    maxAttempts: 2,
  });
  createdJobIds.push(retryJob.id);
  const retryResult = await processDuePushJobs(async () => false, { limit: 5 });
  assert.equal(retryResult.retried, 1);
  const retryUpdated = await getPushJob(retryJob.id);
  assert.equal(retryUpdated?.status, "retry");
  assert.equal(retryUpdated?.attempts, 1);
  assert.match(retryUpdated?.lastError ?? "", /push sender returned false/);
  console.log("  ✓ push job 失败时进入 retry 并记录原因");

  log("push_jobs 达到最大尝试后 dead");
  const deadJob = await enqueuePushJob({
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
    source: "stage1-smoke",
    message: "[stage1-smoke] push queue dead contract",
    maxAttempts: 1,
  });
  createdJobIds.push(deadJob.id);
  const deadResult = await processDuePushJobs(async () => {
    throw new Error("stage1 smoke sender failure");
  }, { limit: 5 });
  assert.equal(deadResult.dead, 1);
  const deadUpdated = await getPushJob(deadJob.id);
  assert.equal(deadUpdated?.status, "dead");
  assert.equal(deadUpdated?.attempts, 1);
  assert.match(deadUpdated?.lastError ?? "", /stage1 smoke sender failure/);
  console.log("  ✓ push job 达到 maxAttempts 后进入 dead");

  await cleanup();
  console.log("\n阶段一 smoke 通过: scheduled reply / schedules / push queue 契约正常");
} catch (error) {
  await cleanup();
  console.error("\n阶段一 smoke 失败");
  console.error(error);
  process.exit(1);
}
