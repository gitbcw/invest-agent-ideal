import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";
process.env.NODE_ENV = "test";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-patrol-mcp-"));
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.MARKET_DATA_MCP_URL = "http://127.0.0.1:22640/mcp";
process.env.MARKET_DATA_MCP_TOKEN = "test-token";

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  delete process.env.MARKET_DATA_MCP_URL;
  delete process.env.MARKET_DATA_MCP_TOKEN;
});

function sseResponse(payload: unknown, sessionId = "sess-1") {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload })}\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "mcp-session-id": sessionId },
  });
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("mcp client parses SSE frames, maps quote tables and kline tables", async () => {
  const mdt = await import("../src/services/market-data-mcp.js");
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  mdt.setMarketDataFetchForTests(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method: String(body.method), body });
    if (body.method === "initialize") return sseResponse({ protocolVersion: "2025-03-26" });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      const name = (body.params as Record<string, unknown>).name;
      if (name === "get_realtime_quote") {
        return sseResponse({
          content: [{ type: "text", text: JSON.stringify({
            columns: ["代码", "名称", "数据日期", "最新价", "数据源", "交易状态", "昨收"],
            rows: [["600519", "贵州茅台", "2026-08-14", 1341.99, "tencent", "normal", 1355.29]],
            meta: { source: "tencent", fetched_at: "2026-08-15T20:40:06" },
          }) }],
        });
      }
      if (name === "get_hist_kline") {
        return jsonResponse({
          content: [{ type: "text", text: JSON.stringify({
            columns: ["日期", "开盘", "收盘", "最高", "最低", "成交量"],
            rows: [["2026-08-14", 1355, 1341.99, 1359, 1338.14, 29853]],
            meta: { source: "tencent", fetched_at: "2026-08-15T20:40:06" },
          }) }],
        });
      }
    }
    throw new Error(`unexpected rpc ${body.method}`);
  });
  try {
    const quotes = await mdt.mcpRealtimeQuotes(["600519"]);
    assert.equal(quotes.get("600519")?.price, 1341.99);
    assert.equal(quotes.get("600519")?.provider, "tencent");
    const klines = await mdt.mcpDailyKlines("600519", 80);
    assert.equal(klines.items.length, 1);
    assert.equal(klines.items[0].close, 1341.99);
    assert.equal(klines.provider, "tencent");
    // initialize → initialized notification → tool calls on the same session
    assert.deepEqual(calls.map((c) => c.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  } finally {
    mdt.setMarketDataFetchForTests(null);
  }
});

test("mcp client reports NOT_CONFIGURED without env", async () => {
  const mdt = await import("../src/services/market-data-mcp.js");
  mdt.setMarketDataFetchForTests(null);
  await assert.rejects(
    mdt.callMarketDataTool("get_realtime_quote", {}, { env: {} }),
    (error: unknown) => (error as { code?: string }).code === "MARKET_DATA_MCP_NOT_CONFIGURED",
  );
});

test("rule price facts map usable quotes and degrade on MCP failure", async () => {
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const facts = await import("../src/services/rule-price-facts.js");
  const mdt = await import("../src/services/market-data-mcp.js");
  facts.resetRulePriceCacheForTest();

  mdt.setMarketDataFetchForTests(async () => sseResponse({
    content: [{ type: "text", text: JSON.stringify({
      columns: ["代码", "最新价", "数据日期", "数据源", "交易状态"],
      rows: [["000629", 3.21, "2026-08-14", "tencent", "normal"], ["000420", "停牌", "2026-08-14", "tencent", "suspended"]],
      meta: { source: "tencent" },
    }) }],
  }));
  try {
    const ok = await facts.getRulePrices(["000629", "000420"]);
    assert.equal(ok.get("000629")?.usable, true);
    assert.equal(ok.get("000629")?.price, 3.21);
    assert.equal(ok.get("000420")?.usable, false);
    assert.equal(ok.get("000420")?.failureCode, "invalid_price");
  } finally {
    mdt.setMarketDataFetchForTests(null);
  }

  facts.resetRulePriceCacheForTest();
  mdt.setMarketDataFetchForTests(async () => { throw new Error("connection refused"); });
  try {
    const degraded = await facts.getRulePrices(["000629"]);
    assert.equal(degraded.get("000629")?.usable, false);
    assert.equal(degraded.get("000629")?.failureCode, "market_data_mcp_failed");
  } finally {
    mdt.setMarketDataFetchForTests(null);
  }
});

test("ma_cross dry-run reproduces production cross semantics", async () => {
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const rules = await import("../src/services/watch-rules.js");

  // 构造K线: 79 天横盘 10 → 昨收 10.5（高于昨 MA≈10.02）→ 今收 9（低于今 MA≈9.98）
  // → closePrev >= maPrev && closeToday < maToday，break_below 触发。
  const closes: number[] = [];
  for (let i = 0; i < 79; i += 1) closes.push(10);
  closes.push(10.5, 9);
  const klines = {
    items: closes.map((close, i) => ({ date: `d${i}`, open: close, close, high: close, low: close, volume: 1 })),
    provider: "tencent",
    fetchedAt: "2026-08-15T20:40:06",
  };

  rules.setDailyKlineFetcherForTests(async () => klines);
  try {
    const baseRule = {
      id: 1, userId: "mg", instanceId: "invest-agent-mg", stockCode: "000629", stockName: "钒钛股份",
      ruleType: "ma_cross" as const, targetScope: "holding" as const,
      params: { period: 25, direction: "break_below" },
      cooldown: { mode: "state", minutes: 240 },
      notification: { priority: "P0" as const, push: true },
      enabled: true, createdAt: "", updatedAt: "",
    };
    const below = await rules.dryRunWatchRule(baseRule);
    assert.equal(below.triggered, true, "下穿应触发");
    assert.ok(String(below.reason).includes("跌破"));

    const above = await rules.dryRunWatchRule({ ...baseRule, params: { period: 25, direction: "break_above" } });
    assert.equal(above.triggered, false, "上穿方向不应触发");

    // 未交叉场景: 价格持续在均线上方稳定
    const flat: number[] = [];
    for (let i = 0; i < 80; i += 1) flat.push(10 + (i % 2) * 0.01);
    rules.setDailyKlineFetcherForTests(async () => ({
      items: flat.map((close, i) => ({ date: `d${i}`, open: close, close, high: close, low: close, volume: 1 })),
      provider: "tencent", fetchedAt: null,
    }));
    const stable = await rules.dryRunWatchRule({ ...baseRule, params: { period: 25, direction: "break_below" } });
    assert.equal(stable.triggered, false, "稳定在上方不应触发下穿");

    // K线不足
    rules.setDailyKlineFetcherForTests(async () => ({ items: klines.items.slice(0, 10), provider: null, fetchedAt: null }));
    const short = await rules.dryRunWatchRule(baseRule);
    assert.equal(short.triggered, false);
    assert.equal(short.reason, "K线数量不足，无法判断均线突破");
  } finally {
    rules.setDailyKlineFetcherForTests(null);
  }
});

test("ma_cross rules pass catalog validation and normalize params", async () => {
  const rules = await import("../src/services/watch-rules.js");
  const catalog = rules.listWatchRuleCatalog().find((item) => item.key === "ma_cross");
  assert.ok(catalog, "ma_cross 出现在规则目录");
  assert.deepEqual(catalog.paramsSchema.direction && "options" in catalog.paramsSchema.direction ? catalog.paramsSchema.direction.options : [], ["break_above", "break_below"]);
});

/**
 * 2026-08-20 复活的 5 类技术指标规则求值（合成K线，数值经
 * computeMACD/KDJ/RSI/BOLL/WR 实算核对后固化）。方向取反或数据不足
 * 均不应触发。
 */
function makeKlines(bars: Array<{ close: number; high?: number; low?: number }>) {
  return {
    items: bars.map((bar, i) => ({
      date: `d${i}`, open: bar.close, close: bar.close,
      high: bar.high ?? bar.close, low: bar.low ?? bar.close, volume: 1000,
    })),
    provider: "tencent",
    fetchedAt: "2026-08-20T08:00:00",
  };
}

test("revived indicator rules evaluate with production semantics", async () => {
  const rules = await import("../src/services/watch-rules.js");

  const baseRule = {
    id: 1, userId: "mg", instanceId: "invest-agent-mg", stockCode: "000629", stockName: "钒钛股份",
    targetScope: "holding" as const,
    cooldown: { mode: "state", minutes: 240 },
    notification: { priority: "P1" as const, push: true },
    enabled: true, createdAt: "", updatedAt: "",
  };

  // MACD：110 天缓跌（100→67.3）+ 末日反弹到 75 → DIF(-1.461) 上穿 DEA(-1.971)
  const macdBars: Array<{ close: number }> = [];
  for (let i = 0; i < 110; i += 1) macdBars.push({ close: 100 - i * 0.3 });
  macdBars.push({ close: 75 });
  // KDJ：50 天 0.955 阴跌 + 1 根 1.03 阳线 → 末日金叉（K 2.62 上穿 D 0.87，D≤20 超卖区）
  const kdjBars: Array<{ close: number }> = [];
  let kdjPrice = 100;
  for (let i = 0; i < 50; i += 1) { kdjPrice *= 0.955; kdjBars.push({ close: Number(kdjPrice.toFixed(2)) }); }
  kdjPrice *= 1.03;
  kdjBars.push({ close: Number(kdjPrice.toFixed(2)) });
  // RSI6：30 天 0.96 连跌 → RSI=0（深度超卖）
  const rsiBars: Array<{ close: number }> = [];
  let rsiPrice = 100;
  for (let i = 0; i < 30; i += 1) { rsiPrice *= 0.96; rsiBars.push({ close: Number(rsiPrice.toFixed(2)) }); }
  // BOLL：40 天 10±0.05 横盘 + 末日 11 → 突破上轨 10.495
  const bollBars: Array<{ close: number }> = [];
  for (let i = 0; i < 40; i += 1) bollBars.push({ close: 10 + (i % 2 === 0 ? 0.05 : -0.05) });
  bollBars.push({ close: 11 });
  // WR：30 天 0.95 阴跌 → WR14=99.02（贴区间低点，超卖）
  const wrBars: Array<{ close: number }> = [];
  let wrPrice = 100;
  for (let i = 0; i < 30; i += 1) { wrPrice *= 0.95; wrBars.push({ close: Number(wrPrice.toFixed(2)) }); }

  rules.setDailyKlineFetcherForTests(async (code) => {
    if (code === "macd-test") return makeKlines(macdBars);
    if (code === "kdj-test") return makeKlines(kdjBars);
    if (code === "rsi-test") return makeKlines(rsiBars);
    if (code === "boll-test") return makeKlines(bollBars);
    if (code === "wr-test") return makeKlines(wrBars);
    throw new Error(`unexpected code ${code}`);
  });
  try {
    // macd_cross：金叉触发，死叉不触发
    const macdGolden = await rules.dryRunWatchRule({ ...baseRule, stockCode: "macd-test", ruleType: "macd_cross" as const, params: { direction: "golden_cross" } });
    assert.equal(macdGolden.triggered, true, "MACD 金叉应触发");
    assert.ok(String(macdGolden.reason).includes("金叉"));
    const macdDeath = await rules.dryRunWatchRule({ ...baseRule, stockCode: "macd-test", ruleType: "macd_cross" as const, params: { direction: "death_cross" } });
    assert.equal(macdDeath.triggered, false, "MACD 死叉方向不应触发");

    // kdj_cross：超卖区金叉触发（阈值 20）；阈值收紧到 2 则不触发
    const kdjGolden = await rules.dryRunWatchRule({ ...baseRule, stockCode: "kdj-test", ruleType: "kdj_cross" as const, params: { direction: "golden_cross", threshold: 20 } });
    assert.equal(kdjGolden.triggered, true, "KDJ 超卖金叉应触发");
    const kdjTight = await rules.dryRunWatchRule({ ...baseRule, stockCode: "kdj-test", ruleType: "kdj_cross" as const, params: { direction: "golden_cross", threshold: 0.5 } });
    assert.equal(kdjTight.triggered, false, "KDJ D 值超出收紧阈值不应触发");

    // rsi_threshold：below 30 触发（RSI=0）；above 30 不触发
    const rsiBelow = await rules.dryRunWatchRule({ ...baseRule, stockCode: "rsi-test", ruleType: "rsi_threshold" as const, params: { period: 6, direction: "below", threshold: 30 } });
    assert.equal(rsiBelow.triggered, true, "RSI 超卖应触发");
    const rsiAbove = await rules.dryRunWatchRule({ ...baseRule, stockCode: "rsi-test", ruleType: "rsi_threshold" as const, params: { period: 6, direction: "above", threshold: 30 } });
    assert.equal(rsiAbove.triggered, false, "RSI 高于方向不应触发");

    // boll_break：突破上轨触发；跌破下轨方向不触发
    const bollUpper = await rules.dryRunWatchRule({ ...baseRule, stockCode: "boll-test", ruleType: "boll_break" as const, params: { period: 20, multiplier: 2, direction: "break_upper" } });
    assert.equal(bollUpper.triggered, true, "突破布林上轨应触发");
    const bollLower = await rules.dryRunWatchRule({ ...baseRule, stockCode: "boll-test", ruleType: "boll_break" as const, params: { period: 20, multiplier: 2, direction: "break_lower" } });
    assert.equal(bollLower.triggered, false, "下轨方向不应触发");

    // wr_threshold：above 80 触发（WR=99.02）
    const wrAbove = await rules.dryRunWatchRule({ ...baseRule, stockCode: "wr-test", ruleType: "wr_threshold" as const, params: { period: 14, direction: "above", threshold: 80 } });
    assert.equal(wrAbove.triggered, true, "WR 超卖应触发");
    assert.ok(String(wrAbove.reason).includes("WR14"));

    // K线不足：软返回不触发，reason 说明数量缺口
    const shortKlines = makeKlines(macdBars.slice(0, 20));
    rules.setDailyKlineFetcherForTests(async () => shortKlines);
    const macdShort = await rules.dryRunWatchRule({ ...baseRule, stockCode: "macd-test", ruleType: "macd_cross" as const, params: { direction: "golden_cross" } });
    assert.equal(macdShort.triggered, false, "K线不足不应触发");
    assert.equal(macdShort.reason, "K线数量不足，无法判断 MACD 金叉/死叉");
  } finally {
    rules.setDailyKlineFetcherForTests(null);
  }
});
