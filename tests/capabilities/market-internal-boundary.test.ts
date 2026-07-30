import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedOperations: Record<string, string[]> = {
  "src/services/watch-rules.ts": ["quote", "kline"],
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
