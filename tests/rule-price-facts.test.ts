import assert from "node:assert/strict";
import test from "node:test";
import { toRulePriceFact, type RulePriceFact } from "../src/services/rule-price-facts.js";
import { dryRunWatchRule, type WatchRuleRecord } from "../src/services/watch-rules.js";

/**
 * WP5/F4: 窄价格事实接口测试。
 *
 * F4: toRulePriceFact 现在接收 StockQuote + provider 参数（脱离 marketDataReadCapability）。
 * getRulePrices 直接组合 getQuote + getSinaQuote（需网络），这里用导出的纯函数
 * toRulePriceFact 覆盖映射逻辑; evaluatePriceCrossFromFact 通过 dryRunWatchRule(rule, fact) 注入测试。
 */

function makeQuote(overrides: Partial<{ price: number | null; time: string }> = {}) {
  return {
    code: "600519", name: "贵州茅台", price: 100.5, yesterdayClose: 99, open: 99.5,
    volume: 1000, amount: 100, high: 101, low: 99, change: 1.5, changePercent: 1.5,
    turnoverRate: 0.1, time: "2026-07-30 15:00:00",
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

// ─── toRulePriceFact 纯映射逻辑 (F4: StockQuote + provider) ─────

test("usable quote maps to usable fact with provider", () => {
  const fact = toRulePriceFact("600519", makeQuote() as any, "tencent_quote");
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
  const fact = toRulePriceFact("600519", makeQuote({ price: NaN }) as any, "tencent_quote");
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("Infinity price maps to invalid_price", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: Infinity }) as any, "tencent_quote");
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("null price maps to invalid_price", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: null }) as any, "tencent_quote");
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("zero or negative price maps to invalid_price (F4)", () => {
  const fact = toRulePriceFact("600519", makeQuote({ price: 0 }) as any, "tencent_quote");
  assert.equal(fact.usable, false);
  assert.equal(fact.failureCode, "invalid_price");
});

test("sina fallback provider is preserved", () => {
  const fact = toRulePriceFact("600519", makeQuote() as any, "sina_quote");
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

// ─── F4: 解耦验证 ───────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { validateWatchRule } from "../src/services/watch-rules.js";

test("F4: rule-price-facts does not import marketDataReadCapability", () => {
  const source = readFileSync("src/services/rule-price-facts.ts", "utf8");
  const importLines = source.split("\n").filter((l) => l.trim().startsWith("import"));
  assert.ok(
    !importLines.some((l) => l.includes("marketDataReadCapability")),
    "rule-price-facts must not import marketDataReadCapability",
  );
  assert.ok(source.includes("getQuote"), "rule-price-facts uses getQuote (tencent) directly");
  assert.ok(source.includes("getSinaQuote"), "rule-price-facts uses getSinaQuote (fallback) directly");
});

test("F4: rule-price-facts has TTL cache", () => {
  const source = readFileSync("src/services/rule-price-facts.ts", "utf8");
  assert.ok(source.includes("CACHE_TTL_MS"), "TTL cache constant exists");
});

test("F4: validateWatchRule rejects non-6-digit stock codes", async () => {
  const bad = await validateWatchRule({
    userId: "test", instanceId: "test", stockCode: "sh600519",
    ruleType: "price_cross", targetScope: "manual", params: { operator: ">=", value: 100 },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes("6 位数字")), `should reject sh-prefixed code: ${bad.errors}`);

  const bad2 = await validateWatchRule({
    userId: "test", instanceId: "test", stockCode: "123",
    ruleType: "price_cross", targetScope: "manual", params: { operator: ">=", value: 100 },
  });
  assert.equal(bad2.ok, false);
  assert.ok(bad2.errors.some((e) => e.includes("6 位数字")));
});

test("F4: validateWatchRule accepts clean 6-digit codes", async () => {
  const ok = await validateWatchRule({
    userId: "test", instanceId: "test", stockCode: "600519",
    ruleType: "price_cross", targetScope: "manual", params: { operator: ">=", value: 100 },
  });
  assert.equal(ok.ok, true, "clean 6-digit code should be accepted");
});
