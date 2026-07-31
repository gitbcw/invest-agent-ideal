import assert from "node:assert/strict";
import test from "node:test";
import { marketKline } from "../src/services/market-data.js";

test("daily K-line exposes forward-adjusted price precision contract", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: {
      sh600519: {
        qfqday: [["2025-07-24", "1434.231", "1439.519", "1450.000", "1420.120", "38804"]],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await marketKline({
      code: "600519",
      period: "day",
      count: 1,
      startDate: "2025-07-24",
      endDate: "2025-07-24",
    });

    assert.equal(result.items[0]?.close, 1439.519);
    assert.deepEqual(result.priceConvention, {
      unit: "CNY_per_share",
      adjustment: "forward_adjusted",
      displayDecimals: 3,
      roundingMode: "half_up",
      comparisonTolerance: 0.0005,
      valuePolicy: "preserve_provider_precision",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Sina fallback fetches enough history and returns only the requested date range", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes("web.ifzq.gtimg.cn")) {
      return new Response(JSON.stringify({ data: { sh600519: { qfqday: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { day: "2025-07-24", open: "1434.20", close: "1439.50", high: "1450.00", low: "1420.10", volume: "38804" },
      { day: "2026-07-24", open: "1305.00", close: "1297.41", high: "1309.21", low: "1286.20", volume: "3569892" },
    ]), { status: 200 });
  };

  try {
    const result = await marketKline({
      code: "600519",
      period: "day",
      count: 1,
      startDate: "20250724",
      endDate: "20250724",
    });

    assert.deepEqual(result.items.map((item) => item.date), ["2025-07-24"]);
    assert.equal(result.items[0]?.close, 1439.5);
    assert.equal(result.source.provider, "sina");
    assert.match(result.source.referenceUrl || "", /datalen=500/);
    assert.ok(result.source.warnings.includes("fallback_used:sina_kline_d:1"));
    assert.ok(requestedUrls.some((url) => url.includes("datalen=500")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Sina fallback rejects bars outside an explicitly requested date range", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("web.ifzq.gtimg.cn")) {
      return new Response(JSON.stringify({ data: { sh600519: { qfqday: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { day: "2026-07-24", open: "1305.00", close: "1297.41", high: "1309.21", low: "1286.20", volume: "3569892" },
    ]), { status: 200 });
  };

  try {
    const result = await marketKline({
      code: "600519",
      period: "day",
      count: 1,
      startDate: "2025-07-24",
      endDate: "2025-07-24",
    });

    assert.deepEqual(result.items, []);
    assert.ok(result.source.warnings.includes(
      "fallback_date_range_unavailable:sina_kline_d:2025-07-24:2025-07-24",
    ));
    assert.ok(result.source.warnings.includes("empty_daily_kline"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
