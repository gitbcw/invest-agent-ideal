import { test } from "node:test";
import * as assert from "node:assert/strict";
import { MARKET_WATCH_FACT_TOOLS, marketWatchReplyClaimsMissingData } from "../src/acp/scheduled-tasks.js";

const snapshot = {
  ok: true as const,
  userId: "market-watch-contract",
  instanceId: "market-watch-contract-instance",
  updatedAt: "2026-07-23T03:20:00.000Z",
  holdings: [{
    stockCode: "002460",
    stockName: "fixture",
    quote: {
      price: 1,
      tradingStatus: { status: "normal" as const, reasons: [] },
    },
  }],
  watchlist: [],
  plans: [],
  indices: [],
  warnings: [],
};

test("scheduled market-watch rejects a missing-data claim when the captured snapshot is usable", () => {
  assert.equal(marketWatchReplyClaimsMissingData("本轮实时行情数据暂不可用，暂不判断。", snapshot), true);
  assert.equal(marketWatchReplyClaimsMissingData("数据截至 11:20，腾讯行情正常。", snapshot), false);
});

test("scheduled market-watch accepts several current-fact tools without treating health checks as evidence", () => {
  assert.deepEqual(MARKET_WATCH_FACT_TOOLS, [
    "market_watch.snapshot",
    "market.snapshot",
    "market.quote",
    "market.indices",
    "market.kline",
    "market.capital_flow",
    "market.sector_theme",
    "market.stock_info",
  ]);
  assert.equal(MARKET_WATCH_FACT_TOOLS.includes("market.health" as never), false);
  assert.equal(MARKET_WATCH_FACT_TOOLS.includes("market.calendar" as never), false);
});
