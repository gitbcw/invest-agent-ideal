import { computeMA, type IndicatorContext, type IndicatorResult } from "invest-agent-runtime";

export const definition = {
  key: "double_ma_cross",
  name: "Double MA cross test fixture",
  reliability: "stable",
  dataRequirements: ["kline"],
  outputSchema: {},
};

export function compute(ctx: IndicatorContext): IndicatorResult {
  const closes = ctx.klines.map((item) => item.close);
  const ma5 = computeMA(closes, 5).last ?? 0;
  const ma20 = computeMA(closes, 20).last ?? 0;
  return {
    values: {
      ma5: Math.round(ma5 * 100) / 100,
      ma20: Math.round(ma20 * 100) / 100,
      crossed_up: ma5 > ma20,
      crossed_down: ma5 < ma20,
    },
    notes: ["test fixture"],
  };
}
