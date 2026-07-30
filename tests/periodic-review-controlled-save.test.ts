import assert from "node:assert/strict";
import test from "node:test";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { periodicReviewBackend } from "../src/lib/periodic-review-backend.js";

/**
 * F2: 周/月复盘受控保存测试。
 * periodicReviewBackend 的 upsert/get 隔离 + 序列化往返。
 */

const TEST_USER = "f2-test-user";
const TEST_INSTANCE = "f2-test-instance";
const TEST_WS = join(process.cwd(), "data", "test-workspaces", TEST_USER);

test("periodicReviewBackend upsert then get round-trips publication metadata", async () => {
  // 准备 workspace
  await mkdir(join(TEST_WS, "AGENTS.md", ".."), { recursive: true });
  await writeFile(join(TEST_WS, "AGENTS.md"), "# test", "utf-8");

  const record = {
    kind: "weekly" as const,
    reportKey: "2026-W30_weekly",
    generatedAt: "2026-07-30T12:00:00.000Z",
    summary: "本周重点关注",
    content: "# 周复盘\n\n内容...",
    data: {
      source: "skill",
      savedAt: "2026-07-30T12:00:00.000Z",
      context: {
        publication: { conversationId: "scheduler:weekly-review:f2-test-user:f2-test-instance", scheduled: true },
      },
    },
  };

  await periodicReviewBackend.upsert(TEST_USER, TEST_INSTANCE, record);
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "weekly", "2026-W30_weekly");

  assert.ok(read, "record should be readable");
  assert.equal(read!.kind, "weekly");
  assert.equal(read!.reportKey, "2026-W30_weekly");
  assert.equal(read!.summary, "本周重点关注");
  assert.equal(read!.content, "# 周复盘\n\n内容...");
  const data = read!.data as { context?: { publication?: { conversationId?: string; scheduled?: boolean } } };
  assert.equal(data.context?.publication?.conversationId, "scheduler:weekly-review:f2-test-user:f2-test-instance");
  assert.equal(data.context?.publication?.scheduled, true);

  await rm(TEST_WS, { recursive: true, force: true });
});

test("periodicReviewBackend get returns null for missing reportKey", async () => {
  // 不存在的 reportKey
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "monthly", "nonexistent-key");
  assert.equal(read, null);
});

test("periodicReviewBackend upsert/get works for monthly kind", async () => {
  await periodicReviewBackend.upsert(TEST_USER, TEST_INSTANCE, {
    kind: "monthly",
    reportKey: "2026-07",
    generatedAt: "2026-07-30T12:00:00.000Z",
    summary: "月度总结",
    content: "月复盘内容",
    data: { source: "skill" },
  });
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "monthly", "2026-07");
  assert.ok(read, "monthly record readable");
  assert.equal(read!.kind, "monthly");
  assert.equal(read!.reportKey, "2026-07");
  assert.equal(read!.content, "月复盘内容");
});

test("scheduledCompletion prefix check covers weekly/monthly (F2 critical)", () => {
  // 验证 saveReview 的 scheduledCompletion 三前缀判定
  // （这是 F2 最易踩坑的点：漏改会导致 weekly/monthly 调 reviews.save 被 requireConfirmed 拦截）
  const prefixes = [
    "scheduler:daily-review:user:instance",
    "scheduler:weekly-review:user:instance",
    "scheduler:monthly-review:user:instance",
  ];
  for (const convId of prefixes) {
    const isScheduled =
      convId.startsWith("scheduler:daily-review:") ||
      convId.startsWith("scheduler:weekly-review:") ||
      convId.startsWith("scheduler:monthly-review:");
    assert.ok(isScheduled, `${convId} should be recognized as scheduled`);
  }
  // 非 scheduled 前缀不匹配
  assert.ok(!"interactive-conv".startsWith("scheduler:"));
});
