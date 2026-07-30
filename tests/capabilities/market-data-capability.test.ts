import assert from "node:assert/strict";
import test from "node:test";
import { createMarketDataCapability } from "../../src/capabilities/market-data/capability.js";
import type { MarketDataCapabilityContract } from "../../src/capabilities/market-data/contract.js";

test("market capability delegates only explicit operations", async () => {
  const calls: string[] = [];
  const operation = async (name: string) => {
    calls.push(name);
    return { items: [], warnings: [] };
  };
  const capability = createMarketDataCapability({
    quote: () => operation("quote") as ReturnType<MarketDataCapabilityContract["quote"]>,
    kline: async () => { throw new Error("not used"); },
    indices: () => operation("indices") as ReturnType<MarketDataCapabilityContract["indices"]>,
    capitalFlow: () => operation("capitalFlow") as ReturnType<MarketDataCapabilityContract["capitalFlow"]>,
    sectorTheme: () => operation("sectorTheme") as ReturnType<MarketDataCapabilityContract["sectorTheme"]>,
    stockInfo: () => operation("stockInfo") as ReturnType<MarketDataCapabilityContract["stockInfo"]>,
    resolve: async () => ({ items: [], warnings: [], source: {} }),
    calendar: async () => ({}) as Awaited<ReturnType<MarketDataCapabilityContract["calendar"]>>,
    health: async () => ({}) as Awaited<ReturnType<MarketDataCapabilityContract["health"]>>,
  });

  await capability.quote(["600519"]);
  await capability.indices();
  assert.deepEqual(calls, ["quote", "indices"]);
  assert.ok(Object.isFrozen(capability));
});
