import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  MARKET_WATCH_FACT_TOOLS,
  buildMarketWatchTaskPrompt,
  marketWatchReplyClaimsMissingData,
} from "../src/acp/scheduled-tasks.js";

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

test("R4: market-watch prompt does not force named tools or forbid NO_PUSH", () => {
  const prompt = buildMarketWatchTaskPrompt({ userId: "user-a", instanceId: "instance-a" }, "scheduled_intraday_brief");
  // R4: 新 prompt 不含具体读工具名
  assert.doesNotMatch(prompt, /market(?:_watch)?\.(?:snapshot|quote|indices|kline|capital_flow|sector_theme|stock_info|calendar|health)/);
  // R4: 不强制"至少一个具名行情读取能力"
  assert.doesNotMatch(prompt, /至少一个.*具名行情读取能力/);
  // R4: 不禁止 NO_PUSH（NO_PUSH 由 ACP/Skills/通知策略决定）
  assert.doesNotMatch(prompt, /禁止输出 NO_PUSH/);
  // R4: 仍解释精确输出协议
  assert.match(prompt, /NO_PUSH/);
  // R4: 仍委托工具选择给 ACP/Skills
  assert.match(prompt, /工具选择.*自行决定|研究方法.*自行决定/);
});
