import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isLegacyReviewOrch } from "../src/acp/scheduled-tasks.js";

const source = readFileSync(new URL("../src/acp/scheduled-tasks.ts", import.meta.url), "utf-8");

/**
 * WP4: 预编排 feature flag 测试。
 *
 * market-watch 旧编排已退役；这里保留 review legacy flag 与新路径静态契约。
 */

test("legacy review orchestration flag defaults to false", () => {
  delete process.env.SCHEDULED_REVIEW_LEGACY_ORCH;
  assert.equal(isLegacyReviewOrch(), false);
});

test("legacy review orchestration flag enabled by explicit true", () => {
  process.env.SCHEDULED_REVIEW_LEGACY_ORCH = "true";
  assert.equal(isLegacyReviewOrch(), true);
  delete process.env.SCHEDULED_REVIEW_LEGACY_ORCH;
});

test("WP4 new daily-review path does not pass reviewContext by default", () => {
  // 新路径 (isLegacyReviewOrch() false) 不调 buildDailyReviewContext
  const dailyFnIdx = source.indexOf("async function runScheduledDailyReview");
  const buildContextIdx = source.indexOf("buildDailyReviewContext", dailyFnIdx);
  assert.ok(dailyFnIdx > 0);
  assert.ok(buildContextIdx > dailyFnIdx, "buildDailyReviewContext is in daily function");
  // 它前面应有 legacy 判断
  const beforeContext = source.slice(dailyFnIdx, buildContextIdx);
  assert.ok(beforeContext.includes("isLegacyReviewOrch()"), "buildDailyReviewContext guarded by legacy flag");
});

test("WP4 new weekly/monthly path does not inject context JSON", () => {
  // runStructuredReviewPrompt: context 为 null 时不拼 JSON
  const fnIdx = source.indexOf("async function runStructuredReviewPrompt");
  const jsonIdx = source.indexOf("复盘上下文 JSON", fnIdx);
  const ifIdx = source.indexOf("if (context)", fnIdx);
  assert.ok(jsonIdx > 0);
  assert.ok(ifIdx > 0 && ifIdx < jsonIdx, "context JSON guarded by `if (context)`");
});

test("WP4 new market-watch NO_PUSH returns null without fallback", () => {
  // 新路径: NO_PUSH 统一 return null (无 buildMarketWatchFallbackBrief)
  // 验证新路径的 NO_PUSH return 不在 legacy 函数内,且其后无 fallback 调用
  const newReturnIdx = source.indexOf("if (!cleaned || cleaned === \"NO_PUSH\") return null;");
  assert.ok(newReturnIdx > 0, "new path has NO_PUSH return null");
  assert.equal(source.includes("runLegacyMarketWatchTask"), false, "legacy market-watch branch is retired");
  assert.equal(source.includes("buildMarketWatchFallbackBrief"), false, "fallback brief is retired");
});
