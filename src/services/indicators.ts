import type { StockKline } from "./stock.js";
import { createIndicatorCapability } from "../capabilities/indicators/capability.js";
import type { IndicatorCapabilityContract } from "../capabilities/indicators/contract.js";

// ==================== 趋势指标 ====================

/** 计算均线 MA */
function ma(closes: number[], period: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < period - 1) return null;
    const slice = closes.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

/** 计算 MACD */
function macd(
  closes: number[],
  short = 12,
  long = 26,
  signal = 9
): { dif: number[]; dea: number[]; macd: number[] } {
  const ema = (data: number[], period: number): number[] => {
    const result: number[] = [data[0]];
    const k = 2 / (period + 1);
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  };

  const emaShort = ema(closes, short);
  const emaLong = ema(closes, long);
  const dif = emaShort.map((v, i) => v - emaLong[i]);
  const dea = ema(dif, signal);
  const macdBar = dif.map((v, i) => 2 * (v - dea[i]));

  return { dif, dea, macd: macdBar };
}

/** 均线多头/空头排列判断 */
function maTrend(ma5: number, ma10: number, ma20: number, ma60: number): string {
  if (ma5 > ma10 && ma10 > ma20 && ma20 > ma60) return "多头排列（强势）";
  if (ma5 < ma10 && ma10 < ma20 && ma20 < ma60) return "空头排列（弱势）";
  if (ma5 > ma10 && ma10 > ma20) return "短期多头";
  if (ma5 < ma10 && ma10 < ma20) return "短期空头";
  return "交织（震荡）";
}

// ==================== 量能指标 ====================

/** 成交量分析 */
function volumeAnalysis(
  volumes: number[],
  currentVol: number
): { ratio5: number; ratio20: number; status: string } {
  const avg5 = volumes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5 || 1;
  const avg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 || 1;
  const ratio5 = currentVol / avg5;
  const ratio20 = currentVol / avg20;

  let status = "正常";
  if (ratio5 > 2) status = "显著放量";
  else if (ratio5 > 1.5) status = "放量";
  else if (ratio5 < 0.5) status = "显著缩量";
  else if (ratio5 < 0.7) status = "缩量";

  return { ratio5: Math.round(ratio5 * 100) / 100, ratio20: Math.round(ratio20 * 100) / 100, status };
}

// ==================== 综合分析 ====================

export interface IndicatorReport {
  trend: {
    ma5: number;
    ma10: number;
    ma20: number;
    ma60: number | null;
    trendDesc: string;
    macdSignal: string;
  };
  volume: {
    ratioToAvg5: number;
    ratioToAvg20: number;
    status: string;
  };
  summary: string;
}

/** 生成技术指标报告 */
export function analyzeIndicators(klines: StockKline[]): IndicatorReport {
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume);
  const last = closes.length - 1;

  // 趋势
  const ma5 = ma(closes, 5);
  const ma10 = ma(closes, 10);
  const ma20 = ma(closes, 20);
  const ma60 = ma(closes, 60);

  const currentMa5 = ma5[last] ?? 0;
  const currentMa10 = ma10[last] ?? 0;
  const currentMa20 = ma20[last] ?? 0;
  const currentMa60 = ma60[last];

  const trendDesc = currentMa60
    ? maTrend(currentMa5, currentMa10, currentMa20, currentMa60)
    : "数据不足（无60日均线）";

  const { dif, dea } = macd(closes);
  const currentDif = dif[last];
  const prevDif = dif[last - 1];
  const currentDea = dea[last];

  let macdSignal = "无明显信号";
  if (prevDif < prevDif - (currentDif - prevDif) && currentDif > currentDea) {
    // 金叉判断：DIF 从下方穿越 DEA
  }
  if (currentDif > currentDea && dif[last - 1] <= dea[last - 1]) {
    macdSignal = "MACD 金叉（买入信号）";
  } else if (currentDif < currentDea && dif[last - 1] >= dea[last - 1]) {
    macdSignal = "MACD 死叉（卖出信号）";
  } else if (currentDif > 0 && currentDif > currentDea) {
    macdSignal = "MACD 多头运行";
  } else if (currentDif < 0 && currentDif < currentDea) {
    macdSignal = "MACD 空头运行";
  }

  // 量能
  const vol = volumeAnalysis(volumes, volumes[last]);

  // 综合评价
  const summary = generateSummary(trendDesc, macdSignal, vol.status, currentMa5 > currentMa20);

  return {
    trend: {
      ma5: Math.round(currentMa5 * 100) / 100,
      ma10: Math.round(currentMa10 * 100) / 100,
      ma20: Math.round(currentMa20 * 100) / 100,
      ma60: currentMa60 ? Math.round(currentMa60 * 100) / 100 : null,
      trendDesc,
      macdSignal,
    },
    volume: {
      ratioToAvg5: vol.ratio5,
      ratioToAvg20: vol.ratio20,
      status: vol.status,
    },
    summary,
  };
}

function generateSummary(
  trendDesc: string,
  macdSignal: string,
  volStatus: string,
  aboveMa20: boolean
): string {
  const bullish = trendDesc.includes("多头") && macdSignal.includes("多");
  const bearish = trendDesc.includes("空头") && macdSignal.includes("空");
  const volConfirm = volStatus.includes("放量");

  if (bullish && volConfirm) return "技术面偏多，量价配合良好，趋势较强";
  if (bullish) return "技术面偏多，但成交量未能有效放大，需关注";
  if (bearish && volStatus.includes("缩量")) return "技术面偏空，缩量下跌，观望为主";
  if (bearish) return "技术面偏空，注意风险控制";
  if (aboveMa20) return "运行在20日均线上方，短期趋势尚可，震荡中偏强";
  return "运行在20日均线下方，短期偏弱，建议谨慎";
}

/** 格式化指标报告为文本 */
export function formatIndicatorReport(report: IndicatorReport): string {
  const lines = [
    "=== 技术指标分析 ===",
    "",
    "【趋势】",
    `  MA5: ${report.trend.ma5} | MA10: ${report.trend.ma10} | MA20: ${report.trend.ma20}${report.trend.ma60 ? ` | MA60: ${report.trend.ma60}` : ""}`,
    `  均线: ${report.trend.trendDesc}`,
    `  MACD: ${report.trend.macdSignal}`,
    "",
    "【量能】",
    `  量比(5日均): ${report.volume.ratioToAvg5} | 量比(20日均): ${report.volume.ratioToAvg20}`,
    `  状态: ${report.volume.status}`,
    "",
    "【综合】",
    `  ${report.summary}`,
  ];
  return lines.join("\n");
}

// ==================== 独立 L1 算子(供未来 L2/L3a/L3b 引用)====================
//
// 这些算子返回结构化结果 + 完整数值序列(而非单一标量),
// 便于 L2 信号、L3a 规则树、L3b 沙箱脚本按字段引用。
// analyzeIndicators 保持不变,5 个调用方零影响。

export interface MAValue {
  period: number;
  /** 与 closes 等长,前 period-1 个为 null(数据不足) */
  values: (number | null)[];
  last: number | null;
}

/** 简单移动平均 */
export function computeMA(closes: number[], period: number): MAValue {
  if (period < 1) throw new Error(`computeMA: period must be >= 1, got ${period}`);
  const values: (number | null)[] = closes.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    return sum / period;
  });
  return { period, values, last: values[values.length - 1] ?? null };
}

export interface EMAValue {
  period: number;
  values: number[];
  last: number;
}

/** 指数移动平均 */
export function computeEMA(data: number[], period: number): EMAValue {
  if (period < 1) throw new Error(`computeEMA: period must be >= 1, got ${period}`);
  if (data.length === 0) return { period, values: [], last: NaN };
  const k = 2 / (period + 1);
  const values: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    values.push(data[i] * k + values[i - 1] * (1 - k));
  }
  return { period, values, last: values[values.length - 1] };
}

export interface MACDValue {
  short: number;
  long: number;
  signal: number;
  dif: number[];
  dea: number[];
  bar: number[];
}

/** MACD: DIF=EMA(short)-EMA(long); DEA=EMA(DIF,signal); BAR=2*(DIF-DEA) */
export function computeMACD(closes: number[], short = 12, long = 26, signal = 9): MACDValue {
  if (closes.length === 0) {
    return { short, long, signal, dif: [], dea: [], bar: [] };
  }
  const emaShort = computeEMA(closes, short).values;
  const emaLong = computeEMA(closes, long).values;
  const dif = emaShort.map((v, i) => v - emaLong[i]);
  const dea = computeEMA(dif, signal).values;
  const bar = dif.map((v, i) => 2 * (v - dea[i]));
  return { short, long, signal, dif, dea, bar };
}

export interface KDJValue {
  n: number;
  m1: number;
  m2: number;
  k: number[];
  d: number[];
  j: number[];
}

/**
 * KDJ(通达信标准)
 * RSV = (CLOSE - LLV(LOW,N)) / (HHV(HIGH,N) - LLV(LOW,N)) * 100
 * K = SMA(RSV, M1, 1)   (SMA 初值取 50)
 * D = SMA(K, M2, 1)     (初值取 50)
 * J = 3*K - 2*D
 */
export function computeKDJ(
  klines: StockKline[],
  n = 9,
  m1 = 3,
  m2 = 3,
): KDJValue {
  if (klines.length === 0) {
    return { n, m1, m2, k: [], d: [], j: [] };
  }
  // SMA(X, N, M) = (REF(SMA,1)*(N-M) + X*M) / N,初值取 init
  const smaWithInit = (data: number[], periodN: number, weightM: number, init: number): number[] => {
    const result: number[] = [];
    let prev = init;
    for (let i = 0; i < data.length; i++) {
      const cur = (prev * (periodN - weightM) + data[i] * weightM) / periodN;
      result.push(cur);
      prev = cur;
    }
    return result;
  };

  const rsv: number[] = klines.map((kl, i) => {
    if (i < n - 1) return 50;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (klines[j].high > hh) hh = klines[j].high;
      if (klines[j].low < ll) ll = klines[j].low;
    }
    if (hh === ll) return 50;
    return ((kl.close - ll) / (hh - ll)) * 100;
  });

  const k = smaWithInit(rsv, m1, 1, 50);
  const d = smaWithInit(k, m2, 1, 50);
  const j = k.map((kv, i) => 3 * kv - 2 * d[i]);

  return { n, m1, m2, k, d, j };
}

export interface BOLLValue {
  period: number;
  multiplier: number;
  up: (number | null)[];
  mid: (number | null)[];
  down: (number | null)[];
}

/** 布林带: MID=MA(close,N); UP=MID+k*STD; DOWN=MID-k*STD (STD 为总体标准差) */
export function computeBOLL(
  klines: StockKline[],
  period = 20,
  multiplier = 2,
): BOLLValue {
  const closes = klines.map((k) => k.close);
  const ma = computeMA(closes, period);
  const up: (number | null)[] = [];
  const down: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      up.push(null);
      down.push(null);
      continue;
    }
    const mean = ma.values[i] as number;
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (closes[j] - mean) ** 2;
    }
    const std = Math.sqrt(sumSq / period);
    up.push(mean + multiplier * std);
    down.push(mean - multiplier * std);
  }
  return { period, multiplier, up, mid: ma.values, down };
}

export interface RSIValue {
  period: number;
  values: (number | null)[];
  last: number | null;
}

/** RSI(Wilder 平滑) */
export function computeRSI(closes: number[], period = 6): RSIValue {
  if (closes.length < period + 1) {
    return { period, values: closes.map(() => null), last: null };
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const values: (number | null)[] = new Array(period).fill(null);
  const firstRS = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + firstRS));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
  }

  return { period, values, last: values[values.length - 1] ?? null };
}

export interface WRValue {
  period: number;
  values: (number | null)[];
  last: number | null;
}

/** WR(威廉指标): (HHV(HIGH,N) - CLOSE) / (HHV(HIGH,N) - LLV(LOW,N)) * 100 */
export function computeWR(klines: StockKline[], period = 14): WRValue {
  const values: (number | null)[] = klines.map((kl, i) => {
    if (i < period - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (klines[j].high > hh) hh = klines[j].high;
      if (klines[j].low < ll) ll = klines[j].low;
    }
    if (hh === ll) return 50;
    return ((hh - kl.close) / (hh - ll)) * 100;
  });
  return { period, values, last: values[values.length - 1] ?? null };
}

export interface OBVValue {
  values: number[];
  last: number;
}

/** OBV: 收盘上涨日累加成交量,下跌日减,平盘不变 */
export function computeOBV(klines: StockKline[]): OBVValue {
  if (klines.length === 0) return { values: [], last: 0 };
  const values: number[] = [0];
  for (let i = 1; i < klines.length; i++) {
    const prev = values[i - 1];
    if (klines[i].close > klines[i - 1].close) {
      values.push(prev + klines[i].volume);
    } else if (klines[i].close < klines[i - 1].close) {
      values.push(prev - klines[i].volume);
    } else {
      values.push(prev);
    }
  }
  return { values, last: values[values.length - 1] };
}

export const indicatorCapability: IndicatorCapabilityContract = createIndicatorCapability({
  analyzeIndicators,
  computeMA,
  computeEMA,
  computeMACD,
  computeKDJ,
  computeBOLL,
  computeRSI,
  computeWR,
  computeOBV,
});
