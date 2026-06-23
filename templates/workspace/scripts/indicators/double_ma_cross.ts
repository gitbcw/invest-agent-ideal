/**
 * 示例 L3b 沙箱脚本:5/20 日均线金叉检测
 *
 * 这是模板示例,演示如何在工作空间编写复合指标。
 * 客户创建自己的指标时,可以复制本文件作为起点。
 *
 * 用法(被 ScriptIndicatorEngine 加载):
 *   import { computeMA, type IndicatorContext, type IndicatorResult } from 'invest-agent-runtime';
 *
 * `invest-agent-runtime` 是 host 暴露给沙箱的 helpers 桥,
 * 包含所有 L1 算子(computeMA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV/chipDistribution/winner)。
 *
 * 沙箱限制:
 *   - 不能 import 'fs' / 'process' / 任何 Node API
 *   - 不能 import 项目内其他模块(只能 import 'invest-agent-runtime')
 *   - 内存上限 64MB,超时 5 秒
 */

import {
  computeMA,
  type IndicatorContext,
  type IndicatorResult,
} from "invest-agent-runtime";

export const definition = {
  key: "double_ma_cross",
  name: "5/20 日均线金叉/死叉",
  reliability: "stable" as const,
  dataRequirements: ["daily_kline.close"],
  outputSchema: {
    ma5: "number",
    ma20: "number",
    crossed_up: "boolean",
    crossed_down: "boolean",
  },
};

export function compute(ctx: IndicatorContext): IndicatorResult {
  const { klines } = ctx;
  const closes = klines.map((k) => k.close);

  if (closes.length < 21) {
    return {
      values: { ma5: 0, ma20: 0, crossed_up: false, crossed_down: false },
      notes: ["数据不足 21 日,无法计算 MA20"],
    };
  }

  const ma5 = computeMA(closes, 5);
  const ma20 = computeMA(closes, 20);

  const last = closes.length - 1;
  const ma5Last = ma5.values[last] as number;
  const ma20Last = ma20.values[last] as number;
  const ma5Prev = ma5.values[last - 1] as number;
  const ma20Prev = ma20.values[last - 1] as number;

  const crossedUp = ma5Prev <= ma20Prev && ma5Last > ma20Last;
  const crossedDown = ma5Prev >= ma20Prev && ma5Last < ma20Last;

  return {
    values: {
      ma5: Math.round(ma5Last * 100) / 100,
      ma20: Math.round(ma20Last * 100) / 100,
      crossed_up: crossedUp,
      crossed_down: crossedDown,
    },
    notes: crossedUp
      ? ["MA5 上穿 MA20(金叉)"]
      : crossedDown
        ? ["MA5 下穿 MA20(死叉)"]
        : ["无明显信号"],
  };
}
