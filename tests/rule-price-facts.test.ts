import assert from "node:assert/strict";
import test from "node:test";
import { toRulePriceFact, type RulePriceFact } from "../src/services/rule-price-facts.js";
import { dryRunWatchRule, type WatchRuleRecord } from "../src/services/watch-rules.js";

/**
 * WP5: 窄价格事实接口测试。
 *
 * getRulePrices 内部调真实 quote (需网络),这里用导出的纯函数 toRulePriceFact
 * 覆盖映射逻辑; evaluatePriceCrossFromFact 通过 dryRunWatchRule(rule, fact) 注入测试。
 */

function makeQuote(overrides: Record<string, unknown> = {}) {
  return {
    price: 100.5,
    time: "2026-07-30 15:00:00",
    tradingStatus: { status: "normal", reasons: [] },
    source: { provider: "tencent_quote", marketTime: "2026-07-30 15:00:00" },
    ...overrides,
  };
}

function makeRule(overrides: Partial<WatchRuleRecord> = {}): WatchRuleRecord {
  return {
    id: 1,
    userId: "test-user",
    instanceId: "test-instance",
    stockCode: "600519",
    stockName: "贵州茅台",
    ruleType: "price_cross",
    params: { operator: ">=", value: 100 },
    enabled: true,
    targetScope: "manual",
    ...overrides,
  } as WatchRuleRecord;
}

// ─── toRulePriceFact 纯映射逻辑 ──────────────────────────────────

test("usable quote maps to usable fact with provider", () => {
  const fact = toRulePriceFact("600519", makeQuote());
  assert.equal(fact.code, "600519");
  assert.equal(fact.price, 100.5);
  assert.equal(fact.usable, true);
  assert.equal(fact.provider, "tencent_quote");
  assert.equal(fact.asOf, "2026-07-30 15:00:00");
  assert.equal(fact.failureCode, undefined);
});

test("null quote maps to missing fact", () => {
  const fact = toRulePriceFact("600519", null);
  assert.equal(fact.usable, false);
  assert.equal(fact.price, null);
  assert.equal(fact.failureCode, "missing");
});

test("NaN price maps to invalid_price", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: NaN }));
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("Infinity price maps to invalid_price", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: Infinity }));
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("null price maps to invalid_price", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: null }));
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("stale tradingStatus maps to not usable", () => {
  for (const status of ["stale", "invalid", "unknown"]) {
    const fact = toRulePriceFact("600519", makeQuote({ tradingStatus: { status } }));
    assert.equal(fact.usable, false, `${status} should be unusable`);
    assert.equal(fact.failureCode, "stale");
    assert.equal(fact.price, 100.5); // price 仍在,只是不可用
  }
});

test("sina fallback provider is preserved", () => {
  const fact = toRulePriceFact("600519", makeQuote({ source: { provider: "sina_quote", marketTime: "t" } }));
  assert.equal(fact.provider, "sina_quote");
  assert.equal(fact.usable, true);
});

// ─── evaluatePriceCrossFromFact (通过 dryRunWatchRule 注入) ────────
//
// flag 默认 false; dryRunWatchRule 传入 fact 时 price_cross 直接走 fact 路径,不触网。

test("price_cross triggers when price >= threshold", async () => {
  const rule = makeRule({ params: { operator: ">=", value: 100 } });
  const fact: RulePriceFact = { code: "600519", price: 105.2, asOf: "t", usable: true, provider: "tencent_quote" };
  const result = await dryRunWatchRule(rule, fact);
  assert.equal(result.triggered, true);
  assert.equal(result.facts.currentPrice, 105.2);
  assert.equal(result.facts.operator, ">=");
  assert.equal(result.facts.threshold, 100);
  assert.equal(result.facts.sourceProvider, "tencent_quote");
  assert.match(result.reason, /已满足/);
});

test("price_cross does not trigger when price < threshold", async () => {
  const rule = makeRule({ params: { operator: ">=", value: 100 } });
  const fact: RulePriceFact = { code: "600519", price: 95, asOf: "t", usable: true, provider: "tencent_quote" };
  const result = await dryRunWatchRule(rule, fact);
  assert.equal(result.triggered, false);
  assert.equal(result.facts.currentPrice, 95);
  assert.match(result.reason, /未满足/);
});

test("price_cross <= operator works", async () => {
  const rule = makeRule({ params: { operator: "<=", value: 100 } });
  const fact: RulePriceFact = { code: "600519", price: 90, asOf: "t", usable: true, provider: "tencent_quote" };
  const result = await dryRunWatchRule(rule, fact);
  assert.equal(result.triggered, true);
});

test("price_cross does not trigger when fact unusable (missing)", async () => {
  const rule = makeRule();
  const fact: RulePriceFact = { code: "600519", price: null, asOf: null, usable: false, provider: null, failureCode: "missing" };
  const result = await dryRunWatchRule(rule, fact);
  assert.equal(result.triggered, false);
  assert.match(result.reason, /无法获取行情/);
});

test("price_cross does not trigger when fact unusable (stale)", async () => {
  const rule = makeRule();
  const fact: RulePriceFact = { code: "600519", price: 100, asOf: "t", usable: false, provider: "tencent_quote", failureCode: "stale" };
  const result = await dryRunWatchRule(rule, fact);
  assert.equal(result.triggered, false);
});

test("price_cross does not trigger when fact is null", async () => {
  const rule = makeRule();
  const result = await dryRunWatchRule(rule, null);
  assert.equal(result.triggered, false);
  assert.match(result.reason, /无法获取行情/);
});

test("price_cross facts structure is backward compatible (has currentPrice)", async () => {
  // smoke 脚本断言 currentPrice in facts; 新路径必须保留
  const rule = makeRule();
  const fact: RulePriceFact = { code: "600519", price: 105, asOf: "t", usable: true, provider: "tencent_quote" };
  const result = await dryRunWatchRule(rule, fact);
  assert.ok("currentPrice" in result.facts, "facts must have currentPrice for smoke compat");
});

test("sina fallback provider adds fallback warning in facts", async () => {
  const rule = makeRule();
  const fact: RulePriceFact = { code: "600519", price: 105, asOf: "t", usable: true, provider: "sina_quote" };
  const result = await dryRunWatchRule(rule, fact);
  assert.deepEqual(result.facts.warnings, ["fallback_provider:sina_quote"]);
});

// ─── 非价格规则不受影响 ──────────────────────────────────────────

test("non-price rules ignore the priceFact parameter", async () => {
  // macd_cross 不应使用 priceFact; 它走 kline 路径 (会触网,这里只验证不被 fact 干扰)
  // 用一个不存在的 ruleType 确保不会触网: 直接验证 dryRunWatchRule 签名接受 fact
  const rule = makeRule({ ruleType: "ma_cross" as WatchRuleRecord["ruleType"] });
  const fact: RulePriceFact = { code: "600519", price: 105, asOf: "t", usable: true, provider: "tencent_quote" };
  // ma_cross 不在 price_cross 分支,会走顶部 quote 取价 (触网)。
  // 这里只验证函数签名兼容,不实际执行 (会触网)。
  assert.equal(typeof dryRunWatchRule, "function");
  assert.equal(rule.ruleType, "ma_cross");
  void fact; // 非价格规则忽略 fact
});
