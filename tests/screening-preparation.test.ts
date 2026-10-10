import assert from "node:assert/strict";
import test from "node:test";
import { hidePreparedMarketTools, isFullScopeScreeningRequest, preparePortfolioScreening } from "../src/runtime/screening-preparation.js";

test("screening preparation only activates for full-scope requests", async () => {
  assert.equal(isFullScopeScreeningRequest("帮我看看 600519"), false);
  const result = await preparePortfolioScreening({
    userText: "帮我看看 600519",
    userContext: {} as never,
    projection: { holdings: [{ code: "600519", name: "贵州茅台" }] },
    externalToolsets: {},
  });
  assert.equal(result.enabled, false);
});

test("screening preparation batches stocks and separates ETFs", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const tool = (name: string, result: unknown) => ({
    execute: async (input: Record<string, unknown>) => {
      calls.push({ name, input });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  const result = await preparePortfolioScreening({
    userText: "按全持仓筛选下个交易日值得关注的标的",
    userContext: {} as never,
    projection: {
      holdings: [
        { code: "600519", name: "贵州茅台" },
        { code: "159698", name: "粮食ETF" },
      ],
      watchlist: [{ code: "000420", name: "吉林化纤" }],
    },
    externalToolsets: {
      "market-data-tool": {
        get_hist_klines: tool("get_hist_klines", { columns: ["代码"], rows: [["600519"], ["000420"]], meta: { evidence_level: "primary_fact" } }),
        get_realtime_quote: tool("get_realtime_quote", { columns: ["代码"], rows: [["159698"]], meta: { source: "tencent" } }),
      },
    },
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(result.stockCodes, ["600519", "000420"]);
  assert.deepEqual(result.etfCodes, ["159698"]);
  assert.deepEqual(calls.map((call) => call.name), ["get_hist_klines", "get_realtime_quote"]);
  assert.deepEqual(calls[0].input.symbols, ["600519", "000420"]);
  assert.deepEqual(calls[1].input.symbols, ["159698"]);
  assert.match(result.prompt, /股票统一批量取数/);
  assert.match(result.prompt, /本轮已挂载能力/);
  assert.match(result.prompt, /本轮程序实际调用：market-data-tool\.get_hist_klines、market-data-tool\.get_realtime_quote/);
  assert.match(result.prompt, /本轮未挂载而无法验证：无/);
  const filtered = hidePreparedMarketTools({
    "market-data-tool": {
      get_hist_klines: {},
      get_hist_kline: {},
      get_realtime_quote: {},
      get_stock_news: {},
    },
  }, result);
  assert.deepEqual(Object.keys(filtered["market-data-tool"] as object), ["get_stock_news"]);
});
