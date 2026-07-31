import type { StockKline } from "./market-types.js";

/**
 * 筹码分布模型(基于换手率衰减)
 *
 * 算法:
 *   1. 维护 "价格档 → 筹码量" 的直方图(粒度 granularity 元/档)
 *   2. 每天开盘前,把所有历史筹码按 (1 - 换手率) 衰减
 *   3. 当天新增筹码 = 当天成交量,按当天价格区间均匀注入
 *   4. WINNER(x) = 累加所有 price < x 的筹码量 / 总筹码量
 *
 * 数据源:
 *   - 日 K 线(开高低收成交量)
 *   - 换手率(百分比 0-100)
 *
 * 限制(reliability: experimental):
 *   - 假设"成交均匀分布",与真实筹码分布有差距
 *   - 换手率取自行情源,异常股票(新股、ST)可能不准
 *   - turnover 缺失时走 estimateTurnoversFromVolume 兜底,精度更低
 *
 * @see docs/composite-indicator-system.md 第 5.3 节
 */

export interface ChipDistribution {
  /** 价格档(元) */
  bins: number[];
  /** 每个价格档的筹码权重 */
  weights: Float64Array;
  /** 价格档粒度(元/档) */
  granularity: number;
  /** 总筹码量 */
  total: number;
  /** 计算时使用的 K 线数量 */
  sampleSize: number;
}

export interface ChipDistributionOptions {
  /** 价格档粒度,默认 0.05 元/档 */
  granularity?: number;
}

/**
 * 计算筹码分布
 * @param klines     日 K 线(按时间升序,旧→新)
 * @param turnovers  每日换手率(百分比 0-100,与 klines 等长);某日缺数据传 undefined
 * @param options
 */
export function computeChipDistribution(
  klines: StockKline[],
  turnovers: Array<number | undefined>,
  options: ChipDistributionOptions = {},
): ChipDistribution {
  const granularity = options.granularity ?? 0.05;
  if (klines.length === 0) {
    return { bins: [], weights: new Float64Array(0), granularity, total: 0, sampleSize: 0 };
  }
  if (klines.length !== turnovers.length) {
    throw new Error(
      `computeChipDistribution: klines.length (${klines.length}) !== turnovers.length (${turnovers.length})`,
    );
  }

  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const kl of klines) {
    if (kl.low < priceMin) priceMin = kl.low;
    if (kl.high > priceMax) priceMax = kl.high;
  }
  priceMin = Math.max(0, priceMin - granularity);
  priceMax = priceMax + granularity;

  const binCount = Math.max(1, Math.ceil((priceMax - priceMin) / granularity));
  const bins: number[] = new Array(binCount);
  for (let i = 0; i < binCount; i++) bins[i] = priceMin + i * granularity;
  const weights = new Float64Array(binCount);
  let total = 0;

  for (let i = 0; i < klines.length; i++) {
    const kl = klines[i];
    const turnoverPct = turnovers[i];
    const turnover =
      typeof turnoverPct === "number" && Number.isFinite(turnoverPct)
        ? Math.min(1, Math.max(0, turnoverPct / 100))
        : 0;

    if (turnover > 0) {
      const decay = 1 - turnover;
      for (let b = 0; b < binCount; b++) weights[b] *= decay;
      total *= decay;
    }

    const dayLow = Math.min(kl.open, kl.close, kl.low);
    const dayHigh = Math.max(kl.open, kl.close, kl.high);
    const lo = Math.max(0, Math.floor((dayLow - priceMin) / granularity));
    const hi = Math.min(binCount - 1, Math.ceil((dayHigh - priceMin) / granularity));
    const span = Math.max(1, hi - lo + 1);
    const per = kl.volume / span;
    for (let b = lo; b <= hi; b++) {
      weights[b] += per;
      total += per;
    }
  }

  return { bins, weights, granularity, total, sampleSize: klines.length };
}

/**
 * 计算在给定价格下的获利盘比例(0-1)
 * 等价于通达信 WINNER(price)
 */
export function winner(price: number, dist: ChipDistribution): number {
  if (!(dist.total > 0)) return 0;
  let acc = 0;
  for (let i = 0; i < dist.bins.length; i++) {
    if (dist.bins[i] < price) {
      acc += dist.weights[i];
    } else {
      break;
    }
  }
  return acc / dist.total;
}

/**
 * 从 K 线成交量估算换手率(兜底方案,当真实换手率缺失时使用)
 *
 * 估算逻辑:用前 N 日平均成交量作为流通股本的代理,
 * 当日成交量 / 平均成交量 * 经验系数 0.3(经验值)
 *
 * ⚠️ 粗略估算,reliability 必须标 experimental。
 *    生产环境应优先获取真实换手率。
 */
export function estimateTurnoversFromVolume(
  klines: StockKline[],
  windowSize = 60,
): Array<number | undefined> {
  if (klines.length === 0) return [];
  return klines.map((kl, i) => {
    if (i === 0) return undefined;
    const start = Math.max(0, i - windowSize);
    let sum = 0;
    let count = 0;
    for (let j = start; j < i; j++) {
      sum += klines[j].volume;
      count++;
    }
    if (count === 0) return undefined;
    const avg = sum / count;
    if (avg === 0) return undefined;
    return (kl.volume / avg) * 0.3;
  });
}
