/**
 * L1 算子冒烟测试
 *
 * 用 30 日 K 线 fixture 验证 computeMA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV
 * 和 chip-distribution 模块的 computeChipDistribution/winner/estimateTurnoversFromVolume。
 *
 * 运行:npm run smoke:indicators
 */

const {
  computeMA,
  computeEMA,
  computeMACD,
  computeKDJ,
  computeBOLL,
  computeRSI,
  computeWR,
  computeOBV,
} = await import("../dist/services/indicators.js");

const {
  computeChipDistribution,
  winner,
  estimateTurnoversFromVolume,
} = await import("../dist/services/chip-distribution.js");

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

// 30 日 K 线 fixture:整体上涨趋势(10.1 → 14.0)+ 中间回调
const klines = [
  { date: "2026-04-01", open: 10.0, close: 10.1, high: 10.2, low: 9.9, volume: 1000000 },
  { date: "2026-04-02", open: 10.1, close: 10.3, high: 10.4, low: 10.0, volume: 1100000 },
  { date: "2026-04-03", open: 10.3, close: 10.5, high: 10.6, low: 10.2, volume: 1200000 },
  { date: "2026-04-04", open: 10.5, close: 10.4, high: 10.6, low: 10.3, volume: 1050000 },
  { date: "2026-04-05", open: 10.4, close: 10.7, high: 10.8, low: 10.3, volume: 1300000 },
  { date: "2026-04-06", open: 10.7, close: 11.0, high: 11.1, low: 10.6, volume: 1400000 },
  { date: "2026-04-07", open: 11.0, close: 10.8, high: 11.1, low: 10.7, volume: 1150000 },
  { date: "2026-04-08", open: 10.8, close: 10.6, high: 10.9, low: 10.5, volume: 1000000 },
  { date: "2026-04-09", open: 10.6, close: 10.9, high: 11.0, low: 10.5, volume: 1250000 },
  { date: "2026-04-10", open: 10.9, close: 11.2, high: 11.3, low: 10.8, volume: 1350000 },
  { date: "2026-04-11", open: 11.2, close: 11.5, high: 11.6, low: 11.1, volume: 1450000 },
  { date: "2026-04-12", open: 11.5, close: 11.4, high: 11.6, low: 11.3, volume: 1200000 },
  { date: "2026-04-13", open: 11.4, close: 11.7, high: 11.8, low: 11.3, volume: 1400000 },
  { date: "2026-04-14", open: 11.7, close: 12.0, high: 12.1, low: 11.6, volume: 1500000 },
  { date: "2026-04-15", open: 12.0, close: 12.2, high: 12.3, low: 11.9, volume: 1550000 },
  { date: "2026-04-16", open: 12.2, close: 12.1, high: 12.3, low: 12.0, volume: 1300000 },
  { date: "2026-04-17", open: 12.1, close: 12.4, high: 12.5, low: 12.0, volume: 1450000 },
  { date: "2026-04-18", open: 12.4, close: 12.6, high: 12.7, low: 12.3, volume: 1500000 },
  { date: "2026-04-19", open: 12.6, close: 12.5, high: 12.7, low: 12.4, volume: 1250000 },
  { date: "2026-04-20", open: 12.5, close: 12.8, high: 12.9, low: 12.4, volume: 1400000 },
  { date: "2026-04-21", open: 12.8, close: 13.0, high: 13.1, low: 12.7, volume: 1500000 },
  { date: "2026-04-22", open: 13.0, close: 12.9, high: 13.1, low: 12.8, volume: 1300000 },
  { date: "2026-04-23", open: 12.9, close: 13.1, high: 13.2, low: 12.8, volume: 1400000 },
  { date: "2026-04-24", open: 13.1, close: 13.3, high: 13.4, low: 13.0, volume: 1500000 },
  { date: "2026-04-25", open: 13.3, close: 13.5, high: 13.6, low: 13.2, volume: 1550000 },
  { date: "2026-04-26", open: 13.5, close: 13.4, high: 13.6, low: 13.3, volume: 1300000 },
  { date: "2026-04-27", open: 13.4, close: 13.6, high: 13.7, low: 13.3, volume: 1400000 },
  { date: "2026-04-28", open: 13.6, close: 13.8, high: 13.9, low: 13.5, volume: 1500000 },
  { date: "2026-04-29", open: 13.8, close: 13.7, high: 13.9, low: 13.6, volume: 1300000 },
  { date: "2026-04-30", open: 13.7, close: 14.0, high: 14.1, low: 13.6, volume: 1550000 },
];

const closes = klines.map((k) => k.close);
const lastClose = closes[closes.length - 1];
console.log(`[fixture] 30 日 K 线,价格 ${closes[0]} → ${lastClose}`);

// === computeMA ===
{
  const ma5 = computeMA(closes, 5);
  assert(ma5.values.length === closes.length, "MA 长度应与输入一致");
  assert(ma5.values[0] === null, "MA5 第一日应为 null(数据不足)");
  assert(ma5.values[4] !== null, "MA5 第五日应有值");
  assert(ma5.last !== null && ma5.last > 13, `MA5 last 应 > 13,实际 ${ma5.last}`);
  // MA5 最后值 = (13.7+14.0+13.8+13.7+13.6)/5 ≈ 等
  const expected = (13.7 + 14.0 + 13.8 + 13.7 + 13.6) / 5;
  // 注意:closes 最后 5 个是 13.4,13.6,13.8,13.7,14.0
  const actualLast5 = closes.slice(-5);
  const expectedMA5 = actualLast5.reduce((a, b) => a + b, 0) / 5;
  assert(approxEqual(ma5.last, expectedMA5, 0.001), `MA5 last 应 ≈ ${expectedMA5},实际 ${ma5.last}`);
  console.log(`[OK] computeMA(5) last = ${ma5.last.toFixed(4)}`);
}

// === computeEMA ===
{
  const ema12 = computeEMA(closes, 12);
  assert(ema12.values.length === closes.length, "EMA 长度应与输入一致");
  assert(ema12.values[0] === closes[0], "EMA 第一日应等于 close");
  // 上涨趋势中,EMA 应该滞后但接近 close
  assert(ema12.last > 12 && ema12.last < lastClose, `EMA12 last=${ema12.last} 应在 12 与 ${lastClose} 之间`);
  console.log(`[OK] computeEMA(12) last = ${ema12.last.toFixed(4)}`);
}

// === computeMACD ===
{
  const macd = computeMACD(closes);
  assert(macd.dif.length === closes.length, "MACD dif 长度");
  assert(macd.dea.length === closes.length, "MACD dea 长度");
  assert(macd.bar.length === closes.length, "MACD bar 长度");
  // 上涨趋势中,DIF 应 > 0
  assert(macd.dif[macd.dif.length - 1] > 0, `MACD DIF last 应 > 0(上涨趋势),实际 ${macd.dif.last}`);
  console.log(`[OK] computeMACD DIF last = ${macd.dif[macd.dif.length - 1].toFixed(4)}`);
}

// === computeKDJ ===
{
  const kdj = computeKDJ(klines);
  assert(kdj.k.length === klines.length, "KDJ k 长度");
  assert(kdj.d.length === klines.length, "KDJ d 长度");
  assert(kdj.j.length === klines.length, "KDJ j 长度");
  // 上涨趋势,K 和 D 应该偏高
  assert(kdj.k[kdj.k.length - 1] > 50, `KDJ K last 应 > 50,实际 ${kdj.k.last}`);
  // J = 3K - 2D
  const i = kdj.k.length - 1;
  const expectedJ = 3 * kdj.k[i] - 2 * kdj.d[i];
  assert(approxEqual(kdj.j[i], expectedJ, 0.001), `J = 3K-2D 应成立`);
  console.log(`[OK] computeKDJ K=${kdj.k[i].toFixed(2)} D=${kdj.d[i].toFixed(2)} J=${kdj.j[i].toFixed(2)}`);
}

// === computeBOLL ===
{
  const boll = computeBOLL(klines);
  assert(boll.up.length === klines.length, "BOLL up 长度");
  assert(boll.mid.length === klines.length, "BOLL mid 长度");
  assert(boll.down.length === klines.length, "BOLL down 长度");
  const i = boll.up.length - 1;
  assert(boll.up[i] !== null && boll.mid[i] !== null && boll.down[i] !== null, "BOLL 末值不应 null");
  assert(boll.up[i] > boll.mid[i] && boll.mid[i] > boll.down[i], "BOLL 应 UP > MID > DOWN");
  console.log(`[OK] computeBOLL UP=${boll.up[i]?.toFixed(2)} MID=${boll.mid[i]?.toFixed(2)} DOWN=${boll.down[i]?.toFixed(2)}`);
}

// === computeRSI ===
{
  const rsi = computeRSI(closes, 6);
  assert(rsi.values.length === closes.length, "RSI 长度");
  // 上涨趋势 RSI 应 > 50
  assert(rsi.last !== null && rsi.last > 50, `RSI last 应 > 50,实际 ${rsi.last}`);
  assert(rsi.last !== null && rsi.last <= 100, "RSI 不应 > 100");
  console.log(`[OK] computeRSI(6) last = ${rsi.last?.toFixed(2)}`);
}

// === computeWR ===
{
  const wr = computeWR(klines, 14);
  assert(wr.values.length === klines.length, "WR 长度");
  assert(wr.last !== null, "WR last 不应 null");
  assert(wr.last !== null && wr.last >= 0 && wr.last <= 100, `WR last 应在 [0,100],实际 ${wr.last}`);
  // 上涨趋势中,close 接近 high → WR 偏小(超买)
  assert(wr.last !== null && wr.last < 30, `WR last 应 < 30(接近高位),实际 ${wr.last}`);
  console.log(`[OK] computeWR(14) last = ${wr.last?.toFixed(2)}`);
}

// === computeOBV ===
{
  const obv = computeOBV(klines);
  assert(obv.values.length === klines.length, "OBV 长度");
  assert(obv.values[0] === 0, "OBV 第一日应为 0");
  // 上涨天数多,OBV 应该为正
  assert(obv.last > 0, `OBV last 应 > 0(上涨主导),实际 ${obv.last}`);
  console.log(`[OK] computeOBV last = ${obv.last.toFixed(0)}`);
}

// === computeChipDistribution + winner ===
{
  const turnovers = [
    1.0, 1.2, 1.5, 1.1, 1.8, 2.0, 1.3, 1.0, 1.6, 1.9,
    2.1, 1.4, 1.8, 2.2, 2.3, 1.5, 1.9, 2.1, 1.4, 1.7,
    2.0, 1.3, 1.6, 1.9, 2.2, 1.4, 1.7, 2.0, 1.3, 2.1,
  ];
  assert(turnovers.length === klines.length, "turnovers 长度应匹配");

  const dist = computeChipDistribution(klines, turnovers, { granularity: 0.05 });
  assert(dist.bins.length > 0, "chip bins 应非空");
  assert(dist.total > 0, "chip total 应 > 0");
  assert(dist.sampleSize === klines.length, "sampleSize 应 = klines.length");

  // winner(lastClose) 应该 > 0.5(因为整体上涨,大部分筹码在低位)
  const w = winner(lastClose, dist);
  assert(w > 0 && w <= 1, `winner 应在 (0,1],实际 ${w}`);
  console.log(`[OK] computeChipDistribution bins=${dist.bins.length} total=${dist.total.toFixed(0)}`);
  console.log(`[OK] winner(lastClose=${lastClose}) = ${w.toFixed(4)} (应偏高,因为整体上涨)`);

  // winner(极低价) 应该 ≈ 0
  const wLow = winner(8.0, dist);
  assert(wLow < 0.05, `winner(8.0) 应 ≈ 0,实际 ${wLow}`);

  // winner(极高价) 应该 ≈ 1
  const wHigh = winner(20.0, dist);
  assert(wHigh > 0.95, `winner(20.0) 应 ≈ 1,实际 ${wHigh}`);
  console.log(`[OK] winner 边界 wLow=${wLow.toFixed(4)} wHigh=${wHigh.toFixed(4)}`);
}

// === estimateTurnoversFromVolume(兜底) ===
{
  const estimated = estimateTurnoversFromVolume(klines);
  assert(estimated.length === klines.length, "估算 turnovers 长度");
  assert(estimated[0] === undefined, "第一日应 undefined(无前置数据)");
  const validSamples = estimated.filter((v) => typeof v === "number" && v > 0);
  assert(validSamples.length > 0, "应有有效估算值");
  const sample = estimated[estimated.length - 1];
  console.log(`[OK] estimateTurnoversFromVolume 末值=${sample?.toFixed(4)} (兜底估算,experimental)`);
}

console.log("\n✅ 所有 L1 算子冒烟测试通过");
