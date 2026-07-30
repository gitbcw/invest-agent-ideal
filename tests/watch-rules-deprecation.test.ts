import assert from "node:assert/strict";
import test from "node:test";
import { listWatchRuleCatalog, validateWatchRule } from "../src/services/watch-rules.js";

/**
 * WP6: 非价格规则退役测试。
 * 8 类规则 (ma/macd/kdj/rsi/boll/wr/volume/near_plan) 标记 deprecated,禁止新建;
 * price_cross 保持 active 可用。生产零启用,退役无存量负担。
 */

const DEPRECATED_TYPES = [
  "ma_cross", "macd_cross", "kdj_cross", "rsi_threshold",
  "boll_break", "wr_threshold", "volume_ratio", "near_plan_level",
];

test("catalog marks 8 non-price rule types as deprecated", async () => {
  const catalog = await listWatchRuleCatalog();
  for (const ruleType of DEPRECATED_TYPES) {
    const item = catalog.find((c) => c.key === ruleType);
    assert.ok(item, `${ruleType} exists in catalog`);
    assert.equal(item.status, "deprecated", `${ruleType} should be deprecated`);
  }
});

test("price_cross remains active in catalog", async () => {
  const catalog = await listWatchRuleCatalog();
  const priceCross = catalog.find((c) => c.key === "price_cross");
  assert.ok(priceCross);
  assert.equal(priceCross.status, "active");
});

test("deprecated rule types are rejected at validation (no new creation)", async () => {
  for (const ruleType of DEPRECATED_TYPES) {
    const result = await validateWatchRule({
      userId: "test-user",
      instanceId: "test-instance",
      stockCode: "600519",
      ruleType: ruleType as never,
      targetScope: "manual",
      params: {},
    });
    assert.equal(result.ok, false, `${ruleType} should be rejected`);
    assert.ok(
      result.errors.some((e) => e.includes("已退役") || e.includes("deprecated")),
      `${ruleType} rejection should mention deprecation, got: ${result.errors.join("; ")}`,
    );
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

test("deprecated rules appear in catalog output (visible but not creatable)", async () => {
  // catalog 仍列出 deprecated 规则,让用户知道它们存在但不可新建
  const catalog = await listWatchRuleCatalog();
  assert.ok(catalog.length >= 9, "all 9 rule types still in catalog");
  const deprecated = catalog.filter((c) => c.status === "deprecated");
  assert.equal(deprecated.length, 8, "exactly 8 deprecated rules");
});
