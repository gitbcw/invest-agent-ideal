import assert from "node:assert/strict";
import test from "node:test";
import { listWatchRuleCatalog, validateWatchRule } from "../src/services/watch-rules.js";

/**
 * WP6/WP8: 非价格规则退役验证。
 *
 * WP6 标记 8 类规则 deprecated 并禁止新建; WP8 彻底删除了它们的求值代码。
 * 现在 catalog 只剩 price_cross,退役规则类型不再存在于 WatchRuleType 联合中。
 */

// ma_cross 于 2026-08-15 经 market-data MCP 复活（K线由 MCP 提供）；
// 其余 7 类非价格规则保持退役。
const RETIRED_TYPES = [
  "macd_cross", "kdj_cross", "rsi_threshold",
  "boll_break", "wr_threshold", "volume_ratio", "near_plan_level",
];

test("catalog contains price_cross and the revived ma_cross", async () => {
  const catalog = await listWatchRuleCatalog();
  assert.equal(catalog.length, 2, "price_cross + ma_cross");
  assert.equal(catalog.find((c) => c.key === "price_cross")?.status, "active");
  assert.equal(catalog.find((c) => c.key === "ma_cross")?.status, "active");
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
