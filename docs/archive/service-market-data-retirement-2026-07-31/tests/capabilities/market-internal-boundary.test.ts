import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedOperations: Record<string, string[]> = {
  // WP8: 8 类指标规则已退役删除; watch-rules 只剩 price_cross (flag=true 旧路径用 .quote)。
  "src/services/watch-rules.ts": ["quote"],
  "src/handlers/review.ts": ["quote", "kline", "indices"],
  "src/handlers/plan-conditions.ts": ["quote"],
  "src/routes/platform.ts": ["health"],
};

test("internal market readers use the shared capability", async () => {
  for (const [file, operations] of Object.entries(expectedOperations)) {
    const source = await readFile(file, "utf8");
    for (const operation of operations) {
      assert.match(source, new RegExp(`marketDataReadCapability\\.${operation}\\(`));
    }
    assert.doesNotMatch(source, /\bmarketQuote\(/);
    assert.doesNotMatch(source, /\bmarketKline\(/);
    assert.doesNotMatch(source, /\bmarketIndices\(/);
    assert.doesNotMatch(source, /\bmarketHealth\(/);
  }
});

test("WP5: watch-rules uses narrow price fact interface for price_cross", async () => {
  const source = await readFile("src/services/watch-rules.ts", "utf8");
  assert.match(source, /getRulePrices\(/, "price_cross migrated to getRulePrices");
  assert.match(source, /evaluatePriceCrossFromFact/, "dedicated price-cross evaluator exists");
});

test("WP5: alert-check batch-prefetches price facts per tick", async () => {
  const source = await readFile("src/scheduler/alert-check.ts", "utf8");
  assert.match(source, /getRulePrices\(priceCrossCodes\)/, "batch prefetch before rule loop");
});
