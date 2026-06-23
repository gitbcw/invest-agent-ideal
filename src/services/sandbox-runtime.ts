/**
 * 沙箱运行时支持模块
 *
 * 用户在 workspace/scripts/indicators/<key>.ts 写:
 *   import { computeMA, type IndicatorContext, type IndicatorResult } from 'invest-agent-runtime';
 *
 * esbuild bundle 时把 'invest-agent-runtime' 解析到本文件,
 * 把所有 L1 算子内联进用户脚本,生成可在 isolated-vm 内运行的纯 JS。
 *
 * ⚠️ 本模块不能 import 任何 Node API(fs / process / require 等),
 *    否则会污染 isolate。
 */

export {
  computeMA,
  computeEMA,
  computeMACD,
  computeKDJ,
  computeBOLL,
  computeRSI,
  computeWR,
  computeOBV,
} from "./indicators.js";

export {
  computeChipDistribution,
  winner,
  estimateTurnoversFromVolume,
} from "./chip-distribution.js";

export type { StockKline } from "./stock.js";

export type {
  MAValue,
  EMAValue,
  MACDValue,
  KDJValue,
  BOLLValue,
  RSIValue,
  WRValue,
  OBVValue,
} from "./indicators.js";

export type {
  ChipDistribution,
  ChipDistributionOptions,
} from "./chip-distribution.js";

/**
 * 引擎传给用户 compute 函数的上下文
 */
export interface IndicatorContext {
  /** 日 K 线,按时间升序(旧→新) */
  klines: import("./stock.js").StockKline[];
  /** 每日换手率(百分比 0-100),与 klines 等长 */
  turnovers: Array<number | undefined>;
  /** 用户在 composite_indicators.yaml 注册时声明的参数 */
  params?: Record<string, unknown>;
}

/**
 * 用户 compute 函数必须返回的结构
 */
export interface IndicatorResult {
  /** 结构化输出,字段对应 definition.outputSchema */
  values: Record<string, number | string | boolean>;
  /** 可选的人类可读说明,会展示在 Dashboard */
  notes?: string[];
  /** 覆盖 definition.reliability(若用户脚本运行时决定降级) */
  reliability?: "stable" | "experimental" | "manual_review";
}
