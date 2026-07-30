import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adapters = [
  "src/mcp/service-tools-core.ts",
  "src/routes/sandbox.ts",
];
const operations = [
  "quote", "kline", "indices", "capitalFlow", "sectorTheme",
  "stockInfo", "resolve", "calendar", "health",
];

test("MCP and sandbox market reads use the shared capability while snapshots stay service-owned", async () => {
  for (const adapter of adapters) {
    const source = await readFile(adapter, "utf8");
    assert.match(source, /marketDataReadCapability/);
    assert.match(source, /marketSnapshot/);
    for (const operation of operations) {
      assert.match(source, new RegExp(`marketDataReadCapability\\.${operation}\\(`));
    }
    assert.doesNotMatch(source, /\bmarketQuote\(/);
    assert.doesNotMatch(source, /\bmarketKline\(/);
    assert.doesNotMatch(source, /\bmarketIndices\(/);
  }
});
