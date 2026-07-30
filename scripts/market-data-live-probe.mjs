#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  marketCalendar,
  marketHealth,
  marketIndices,
  marketKline,
  marketQuote,
  marketSectorTheme,
  marketStockInfo,
} from "../dist/services/market-data.js";
import {
  getSinaKline,
  getSinaMarketIndex,
  getSinaQuote,
} from "../dist/services/stock.js";

const quote = await marketQuote(["002460"]);
assert.equal(quote.items.length, 1, "marketQuote should return one quote");
assert.ok(quote.items[0].source.provider, "quote should include source provider");
assert.ok(quote.items[0].tradingStatus, "quote should include trading status");
assert.notEqual(quote.items[0].tradingStatus.status, "invalid", "normal quote should not be invalid");

const kline = await marketKline({ code: "002460", period: "day", count: 5 });
assert.ok(kline.items.length > 0, "marketKline should return rows");
assert.ok(kline.source.provider, "kline should include source provider");

const indices = await marketIndices();
assert.ok(indices.items.length >= 3, "marketIndices should return core indices");

const sinaQuote = await getSinaQuote(["002460"]);
assert.equal(sinaQuote.length, 1, "sina quote fallback should return one quote");
assert.equal(sinaQuote[0].code, "002460", "sina quote should normalize stock code");

const sinaKline = await getSinaKline("002460", 3);
assert.ok(sinaKline.length > 0, "sina kline fallback should return rows");

const sinaIndices = await getSinaMarketIndex();
assert.ok(
  sinaIndices.some((item) => item.code === "000001"),
  "sina indices fallback should include 上证指数",
);
assert.ok(
  sinaIndices.some((item) => item.code === "000300"),
  "sina indices fallback should include 沪深300",
);

const health = await marketHealth();
const endpointNames = new Set(health.endpoints.map((item) => item.provider));
for (const name of [
  "tencent_quote",
  "tencent_kline_d",
  "tencent_indices",
  "sina_quote",
  "sina_kline_d",
  "sina_indices",
  "service_calendar_cn_ashare",
  "eastmoney_sector_theme",
  "eastmoney_stock_news",
  "eastmoney_stock_reports",
  "cninfo_announcements",
]) {
  assert.ok(endpointNames.has(name), `market health should include ${name}`);
}
for (const endpoint of health.endpoints) {
  assert.ok(endpoint.evidenceLevel, `${endpoint.provider} should include evidenceLevel`);
  assert.ok(endpoint.usageBoundary, `${endpoint.provider} should include usageBoundary`);
}
for (const capability of health.capabilities) {
  assert.ok(capability.evidenceLevel, `${capability.key} should include evidenceLevel`);
  assert.ok(capability.usageBoundary, `${capability.key} should include usageBoundary`);
}
const calendarCapability = health.capabilities.find((item) => item.key === "trading_calendar");
assert.equal(calendarCapability?.status, "partial", "trading calendar should be partial");
const sectorThemeCapability = health.capabilities.find((item) => item.key === "sector_theme");
assert.equal(sectorThemeCapability?.status, "partial", "sector/theme should be partial");
const stockInfoCapability = health.capabilities.find((item) => item.key === "announcement");
assert.equal(stockInfoCapability?.status, "partial", "stock info should be partial");

const calendar = await marketCalendar(new Date("2026-06-28T01:35:00.000Z"));
assert.equal(calendar.isTradingDay, false, "2026-06-28 should be a non-trading day");
assert.equal(calendar.previousTradingDay, "2026-06-26", "calendar should expose previous trading day");

const sectorTheme = await marketSectorTheme(["002460"]);
assert.equal(sectorTheme.items.length, 1, "sector/theme should return one stock profile");
assert.ok(sectorTheme.items[0].industry.length > 0, "sector/theme should include industry tags");
assert.ok(
  sectorTheme.items[0].concepts.length > 0 || sectorTheme.items[0].tags.length > 0,
  "sector/theme should include concepts or tags",
);

const stockInfo = await marketStockInfo([{ code: "002460", name: "赣锋锂业" }], { days: 30 });
assert.equal(stockInfo.items.length, 1, "stock info should return one profile");
assert.ok(Array.isArray(stockInfo.items[0].news), "stock info should include news list");
assert.ok(Array.isArray(stockInfo.items[0].reports), "stock info should include reports list");
assert.ok(Array.isArray(stockInfo.items[0].announcements), "stock info should include announcements list");

console.log("✓ market-data fallback smoke passed");
