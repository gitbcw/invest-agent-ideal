import assert from "node:assert/strict";
import test from "node:test";
import { listWatchRuleCatalog, validateWatchRule } from "../src/services/watch-rules.js";

/**
 * 规则退役/复活边界。
 *
 * WP6 曾把 8 类非价格规则标记 deprecated；WP8 删除求值代码。
 * 2026-08-15 ma_cross 经 market-data MCP 复活；2026-08-20 再复活 5 类
 * 技术指标规则（macd_cross/kdj_cross/rsi_threshold/boll_break/wr_threshold，
 * 求值测试见 rule-patrol-mcp.test.ts）。
 * volume_ratio 与 near_plan_level 保持退役（摩擦驱动：等真实需求再动）。
 */
const RETIRED_TYPES = ["volume_ratio", "near_plan_level"];
const REVIVED_TYPES = [
  "ma_cross", "macd_cross", "kdj_cross", "rsi_threshold", "boll_break", "wr_threshold",
];

test("catalog contains price_cross plus revived ma_cross and 5 indicator rules", async () => {
  const catalog = await listWatchRuleCatalog();
  assert.equal(catalog.length, 1 + REVIVED_TYPES.length, "price_cross + 6 类复活规则");
  assert.equal(catalog.find((c) => c.key === "price_cross")?.status, "active");
  for (const ruleType of REVIVED_TYPES) {
    assert.equal(catalog.find((c) => c.key === ruleType)?.status, "active", `${ruleType} 应为 active`);
  }
});

test("retired rule types no longer in catalog", async () => {
  const catalog = await listWatchRuleCatalog();
  for (const ruleType of RETIRED_TYPES) {
    assert.ok(!catalog.some((c) => c.key === ruleType), `${ruleType} removed from catalog`);
  }
});

test("price_cross validation still succeeds", async () => {
  const result = await validateWatchRule({
    userId: "test-user",
    instanceId: "test-instance",
    stockCode: "600519",
    ruleType: "price_cross",
    targetScope: "manual",
    params: { operator: ">=", value: 100 },
  });
  assert.equal(result.ok, true, "price_cross should still be creatable");
});

test("revived indicator rules pass validation with normalized params", async () => {
  const cases: Array<{ ruleType: string; params: Record<string, unknown>; expect: Record<string, unknown> }> = [
    { ruleType: "macd_cross", params: { direction: "death_cross" }, expect: { direction: "death_cross" } },
    { ruleType: "kdj_cross", params: { direction: "golden_cross", threshold: 15 }, expect: { direction: "golden_cross", threshold: 15 } },
    { ruleType: "rsi_threshold", params: { direction: "below", threshold: 30 }, expect: { period: 6, direction: "below", threshold: 30 } },
    { ruleType: "boll_break", params: { direction: "break_upper" }, expect: { period: 20, multiplier: 2, direction: "break_upper" } },
    { ruleType: "wr_threshold", params: { direction: "above", threshold: 80 }, expect: { period: 14, direction: "above", threshold: 80 } },
  ];
  for (const { ruleType, params, expect } of cases) {
    const result = await validateWatchRule({
      userId: "test-user",
      instanceId: "test-instance",
      stockCode: "600519",
      ruleType,
      targetScope: "manual",
      params,
    });
    assert.equal(result.ok, true, `${ruleType} 应可创建`);
    assert.deepEqual(result.normalized?.params, expect, `${ruleType} 参数应归一化`);
  }
});

test("retired rule types are rejected with 不支持的 ruleType", async () => {
  for (const ruleType of RETIRED_TYPES) {
    const result = await validateWatchRule({
      userId: "test-user",
      instanceId: "test-instance",
      stockCode: "600519",
      ruleType,
      targetScope: "manual",
      params: {},
    });
    assert.equal(result.ok, false, `${ruleType} 不应可创建`);
    assert.ok(result.errors.some((e) => e.includes("不支持的 ruleType")), `${ruleType} 拒绝原因`);
  }
});
