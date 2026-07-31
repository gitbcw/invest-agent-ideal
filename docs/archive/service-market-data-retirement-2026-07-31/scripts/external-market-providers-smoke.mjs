import assert from "node:assert/strict";

const { ExternalProviderError, externalProviderAvailability, integratedFundamentals, tushareDailyBars, tushareDailyBasic, tushareTradeCalendar } =
  await import("../dist/services/external-market-providers.js");

const availability = externalProviderAvailability();
const tushare = availability.find((item) => item.provider === "tushare");
const tdx = availability.find((item) => item.provider === "tdx");

assert.ok(tushare, "Tushare availability must be reported");
assert.ok(tdx, "TDX availability must be reported");

if (!tushare.configured && !tdx.configured) {
  console.log("external market provider smoke skipped: no optional provider credentials configured");
  process.exit(0);
}

if (tushare.configured) {
  const bars = await tushareDailyBars({ code: "600519", startDate: "20250720", endDate: "20250724" });
  assert.ok(bars.data.length > 0, "Tushare daily should return rows");
  assert.equal(bars.source.provider, "tushare");
  const latest = bars.data[0];
  await runLimited("Tushare trade_cal", async () => {
    const calendar = await tushareTradeCalendar({ startDate: "20250720", endDate: "20250724" });
    assert.ok(calendar.data.length > 0, "Tushare trade_cal should return rows");
  });
  await runLimited("Tushare daily_basic", async () => {
    const basic = await tushareDailyBasic({ code: "600519", tradeDate: latest.tradeDate });
    assert.ok(basic.data, "Tushare daily_basic should return a row for its own latest trading date");
    assert.equal(basic.data.tradeDate, latest.tradeDate, "Tushare daily_basic date should match the requested trade date");
  });
  console.log("Tushare smoke passed");
}

if (tdx.configured) {
  const fundamentals = await integratedFundamentals({ code: "600519" });
  assert.equal(fundamentals.code, "600519");
  assert.ok(fundamentals.sources.some((source) => source.provider === "tdx"));
  assert.ok(
    fundamentals.values.pe !== null || fundamentals.values.pb !== null || fundamentals.values.roe !== null,
    "TDX fixed fundamentals prompt should return at least one valuation/profitability field",
  );
  console.log("TDX integrated fundamentals smoke passed");
}

console.log("external market providers smoke passed");

async function runLimited(label, fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ExternalProviderError && (error.code === "rate_limited" || error.code === "permission_denied")) {
      console.log(`${label} unavailable for this run: ${error.code}`);
      return;
    }
    throw error;
  }
}
