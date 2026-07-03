import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { resolveChatModelTier, resolveScheduledModelTier } from "../src/acp/model-router.js";

describe("ACP model tier router", () => {
  test("routes routine chat to simple tier", () => {
    assert.equal(resolveChatModelTier("今天有哪些提醒？"), "simple");
    assert.equal(resolveChatModelTier("帮我看一下自选列表"), "simple");
    assert.equal(resolveChatModelTier(""), "simple");
  });

  test("routes investment reasoning requests to complex tier", () => {
    assert.equal(resolveChatModelTier("给我做一下今天的持仓复盘"), "complex");
    assert.equal(resolveChatModelTier("帮我筛选一下机器人主题里的候选股"), "complex");
    assert.equal(resolveChatModelTier("用中线策略给 600519 出预案"), "complex");
    assert.equal(resolveChatModelTier("分析一下这只股票的财报和估值"), "complex");
  });

  test("keeps scheduled market watch on simple tier", () => {
    assert.equal(resolveScheduledModelTier("scheduled-market-watch"), "simple");
    assert.equal(resolveScheduledModelTier("rule-alert-check"), "simple");
  });

  test("routes scheduled reviews to complex tier", () => {
    assert.equal(resolveScheduledModelTier("scheduled-daily-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-weekly-review"), "complex");
    assert.equal(resolveScheduledModelTier("scheduled-monthly-review"), "complex");
  });
});
