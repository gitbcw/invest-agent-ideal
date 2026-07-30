import assert from "node:assert/strict";
import test from "node:test";
import {
  isLegacyMarketWatchOrch,
  isLegacyReviewOrch,
} from "../src/acp/scheduled-tasks.js";

/**
 * WP4: 预编排 feature flag 测试。
 *
 * 新路径 (flag=false, 默认) 把开放研究交还 ACP; flag=true 保留旧编排可回切。
 * 这里测 flag 读取逻辑 + 新路径的行为契约。
 */

// ─── flag 读取 ──────────────────────────────────────────────────

test("legacy market-watch orchestration flag defaults to false", () => {
  delete process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH;
  assert.equal(isLegacyMarketWatchOrch(), false);
});

test("legacy market-watch orchestration flag enabled by explicit true", () => {
  process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH = "true";
  assert.equal(isLegacyMarketWatchOrch(), true);
  delete process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH;
});

test("legacy market-watch flag is not tripped by non-true values", () => {
  for (const v of ["false", "1", "yes", "", "undefined"]) {
    process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH = v;
    assert.equal(isLegacyMarketWatchOrch(), false, `flag tripped by "${v}"`);
  }
  delete process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH;
});

test("legacy review orchestration flag defaults to false", () => {
  delete process.env.SCHEDULED_REVIEW_LEGACY_ORCH;
  assert.equal(isLegacyReviewOrch(), false);
});

test("legacy review orchestration flag enabled by explicit true", () => {
  process.env.SCHEDULED_REVIEW_LEGACY_ORCH = "true";
  assert.equal(isLegacyReviewOrch(), true);
  delete process.env.SCHEDULED_REVIEW_LEGACY_ORCH;
});

test("market-watch and review flags are independent", () => {
  process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH = "true";
  delete process.env.SCHEDULED_REVIEW_LEGACY_ORCH;
  assert.equal(isLegacyMarketWatchOrch(), true);
  assert.equal(isLegacyReviewOrch(), false);
  delete process.env.SCHEDULED_MARKET_WATCH_LEGACY_ORCH;
});

// ─── 新路径行为契约 (静态断言) ────────────────────────────────────
//
// runScheduledMarketWatchTask / runScheduledReviewTask 是异步函数且依赖 DB/ACP,
// 无法纯单测。这里用源码静态断言验证新路径不约束工具、不预聚合、不兜底。

import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/acp/scheduled-tasks.ts", import.meta.url), "utf-8");

test("WP4 new market-watch path does not apply MARKET_WATCH_ALLOWED_TOOLS", () => {
  // 新路径的 buildScheduledUserContext 调用不应带 mcpAllowedTools (旧路径才带)
  // 验证: isLegacyMarketWatchOrch() 分支后才出现 mcpAllowedTools: MARKET_WATCH_ALLOWED_TOOLS
  const legacyBranchIdx = source.indexOf("runLegacyMarketWatchTask");
  const allowedToolsIdx = source.indexOf("mcpAllowedTools: MARKET_WATCH_ALLOWED_TOOLS");
  assert.ok(legacyBranchIdx > 0, "legacy branch exists");
  assert.ok(allowedToolsIdx > legacyBranchIdx, "MARKET_WATCH_ALLOWED_TOOLS only in legacy branch");
});

test("WP4 new market-watch path does not capture snapshot or use fallback brief", () => {
  // captureMarketWatchSnapshot 和 buildMarketWatchFallbackBrief 应只在 legacy 函数内
  const captureIdx = source.indexOf("captureMarketWatchSnapshot(");
  const fallbackIdx = source.indexOf("buildMarketWatchFallbackBrief()");
  const legacyFnIdx = source.indexOf("async function runLegacyMarketWatchTask");
  assert.ok(captureIdx > legacyFnIdx, "captureMarketWatchSnapshot only in legacy function");
  assert.ok(fallbackIdx > legacyFnIdx, "fallback brief only in legacy function");
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
  const legacyFnIdx = source.indexOf("async function runLegacyMarketWatchTask");
  const newReturnIdx = source.indexOf("if (!cleaned || cleaned === \"NO_PUSH\") return null;");
  assert.ok(newReturnIdx > 0, "new path has NO_PUSH return null");
  assert.ok(newReturnIdx < legacyFnIdx, "new path NO_PUSH return is before legacy function definition");
  // 新路径 return 后到 legacy 函数定义之间不应有 fallback brief 调用
  const between = source.slice(newReturnIdx, legacyFnIdx);
  assert.ok(!between.includes("buildMarketWatchFallbackBrief"), "no fallback brief in new path");
});
