import type * as Indicators from "../../services/indicators.js";

export type IndicatorCapabilityContract = Pick<typeof Indicators,
  "analyzeIndicators" | "computeMA" | "computeEMA" | "computeMACD" | "computeKDJ" | "computeBOLL" | "computeRSI" | "computeWR" | "computeOBV"
>;
