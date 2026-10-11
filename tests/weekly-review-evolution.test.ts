import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 周复盘「策略进化建议」+ htmlReport 可视化报告的 prompt/context 断言。
 * prompt 断言走源码比对（与 tests/scheduled-orchestration-flag.test.ts 同一约定），
 * 两处 prompt（runtime/scheduled-tasks.ts 与 services/scheduled-task-types.ts）是
 * 双份事实，必须保持一致。
 */

test("weekly review prompt requires 策略进化建议 block and htmlReport", () => {
  const source = readFileSync(new URL("../src/runtime/scheduled-tasks.ts", import.meta.url), "utf8");
  const fnIdx = source.indexOf("async function runStructuredReviewPrompt");
  const fnEnd = source.indexOf("interface ScheduledAgentTaskInput", fnIdx);
  assert.ok(fnIdx > 0 && fnEnd > fnIdx);
  const body = source.slice(fnIdx, fnEnd);
  assert.ok(body.includes("策略进化建议"), "weekly prompt requires 策略进化建议 block");
  assert.ok(body.includes("失效信号"), "进化建议须含失效信号");
  assert.ok(body.includes('kind === "weekly"'), "策略进化建议只对 weekly 强制");
  assert.ok(body.includes("htmlReport"), "weekly/monthly prompt requires htmlReport");
});

test("scheduled task type instructions stay in sync with the structured prompt", () => {
  const source = readFileSync(new URL("../src/services/scheduled-task-types.ts", import.meta.url), "utf8");
  assert.ok(source.includes("htmlReport"), "periodic instructions require htmlReport");

  const weeklyIdx = source.indexOf("WEEKLY_REVIEW_INSTRUCTION");
  const monthlyIdx = source.indexOf("MONTHLY_REVIEW_INSTRUCTION");
  assert.ok(weeklyIdx > 0 && monthlyIdx > weeklyIdx, "weekly/monthly instructions defined");
  const weeklyBlock = source.slice(weeklyIdx, monthlyIdx);
  const monthlyBlock = source.slice(monthlyIdx);
  assert.ok(weeklyBlock.includes("策略进化建议"), "weekly instruction requires 策略进化建议 block");
  assert.ok(!monthlyBlock.includes("策略进化建议"), "monthly instruction does not force 策略进化建议");

  // 两处 prompt 的 htmlReport 要求措辞一致（双份事实同步）。
  const sharedLine = "reviews.save 必须同时传 htmlReport";
  const runtimeSource = readFileSync(new URL("../src/runtime/scheduled-tasks.ts", import.meta.url), "utf8");
  assert.ok(source.includes(sharedLine) && runtimeSource.includes(sharedLine), "htmlReport 要求在两处 prompt 保持一致");

  // 周复盘任务类型绑定 weekly 指令，月复盘绑定 monthly 指令。
  const weeklyTypeIdx = source.indexOf('"scheduled-weekly-review"');
  const monthlyTypeIdx = source.indexOf('"scheduled-monthly-review"');
  assert.ok(source.slice(weeklyTypeIdx, monthlyTypeIdx).includes("defaultInstruction: WEEKLY_REVIEW_INSTRUCTION"));
  assert.ok(source.slice(monthlyTypeIdx).includes("defaultInstruction: MONTHLY_REVIEW_INSTRUCTION"));
});

test("buildWeeklyReviewContext injects methodChangeProposals like the monthly context", async () => {
  const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
  const { buildWeeklyReviewContext } = await import("../src/handlers/review.js");

  const suffix = randomUUID();
  const userId = `weekly-evolution-user-${suffix}`;
  const instanceId = `weekly-evolution-instance-${suffix}`;
  await methodChangeBackend.propose({
    userId,
    instanceId,
    proposedChange: "止损线从 -8% 收紧到 -6%",
    reason: "本周两次触及止损后反弹，信号过钝",
    affectedResource: "主策略",
  });

  const context = await buildWeeklyReviewContext({ userId, instanceId, date: "2026-08-13" });
  assert.ok(Array.isArray(context.methodChangeProposals), "weekly context carries methodChangeProposals");
  const proposal = context.methodChangeProposals.find((item) => item.proposedChange.includes("止损线"));
  assert.ok(proposal, "已有候选注入 weekly context，避免重复提议");
  assert.equal(proposal!.status, "proposed");
  assert.ok(proposal!.reason.includes("信号过钝"));
});
