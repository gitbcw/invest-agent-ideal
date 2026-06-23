import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { indicatorDefinitions } from "../db/schema.js";

export interface IndicatorDefinitionSeed {
  key: string;
  name: string;
  category: string;
  timeframe: string;
  formulaType: "builtin" | "expression" | "script" | "manual_spec";
  formula: string;
  paramsSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  dataRequirements?: string[];
  reliability?: "stable" | "experimental" | "manual_review";
  enabled?: boolean;
  owner?: "system" | "customer" | "ai_draft";
  description?: string;
}

const BUILT_IN_INDICATORS: IndicatorDefinitionSeed[] = [
  {
    key: "price_change",
    name: "涨跌幅异动",
    category: "price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "priceChange",
    paramsSchema: { threshold: { type: "number", default: 3, unit: "percent" } },
    outputSchema: { triggered: "boolean", changePercent: "number" },
    dataRequirements: ["quote.price", "quote.changePercent"],
    description: "股价涨跌幅超过阈值时触发。",
  },
  {
    key: "near_support",
    name: "接近预案支撑位",
    category: "plan_price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "nearPlanSupport",
    dataRequirements: ["quote.price", "stock_plans.support"],
    description: "价格接近交易预案支撑位时触发。",
  },
  {
    key: "near_resistance",
    name: "接近预案压力位",
    category: "plan_price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "nearPlanResistance",
    dataRequirements: ["quote.price", "stock_plans.resistance"],
    description: "价格接近交易预案压力位时触发。",
  },
  {
    key: "near_target",
    name: "接近预案目标位",
    category: "plan_price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "nearPlanTarget",
    dataRequirements: ["quote.price", "stock_plans.target_price"],
    description: "价格接近交易预案目标位时触发。",
  },
  {
    key: "custom_target_price",
    name: "达到自定义目标价",
    category: "price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "customTargetPrice",
    paramsSchema: { value: { type: "number", unit: "price" } },
    dataRequirements: ["quote.price", "alert_rule.params.value"],
    description: "价格达到用户设置的目标价提醒。",
  },
  {
    key: "custom_support_price",
    name: "跌到自定义支撑价",
    category: "price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "customSupportPrice",
    paramsSchema: { value: { type: "number", unit: "price" } },
    dataRequirements: ["quote.price", "alert_rule.params.value"],
    description: "价格跌到用户设置的支撑价提醒。",
  },
  {
    key: "stop_loss",
    name: "跌破预案止损位",
    category: "plan_price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "breakPlanStopLoss",
    dataRequirements: ["quote.price", "stock_plans.stop_loss"],
    description: "价格跌破交易预案止损位时触发。",
  },
  {
    key: "breakout_with_volume",
    name: "放量突破预案压力位",
    category: "price_volume",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "breakoutWithVolume",
    paramsSchema: { volumeThreshold: { type: "number", default: 1.5 } },
    dataRequirements: ["quote.price", "daily_kline.volume", "stock_plans.resistance"],
    description: "价格突破预案压力位且量能配合时触发。",
  },
  {
    key: "break_support",
    name: "跌破预案支撑位",
    category: "plan_price",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "breakPlanSupport",
    dataRequirements: ["quote.price", "stock_plans.support"],
    description: "价格跌破交易预案支撑位时触发。",
  },
  {
    key: "turnover",
    name: "换手率异常",
    category: "volume",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "turnoverThreshold",
    paramsSchema: { threshold: { type: "number", default: 5, unit: "percent" } },
    dataRequirements: ["quote.turnover"],
    reliability: "experimental",
    enabled: false,
    description: "换手率超过阈值时触发；取决于行情源是否稳定提供换手字段。",
  },
  {
    key: "volume_ratio",
    name: "量比触发",
    category: "volume",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "volumeRatioThreshold",
    paramsSchema: { threshold: { type: "number", default: 2 } },
    dataRequirements: ["daily_kline.volume"],
    enabled: false,
    description: "当前成交量相对均量超过倍数时触发。",
  },
  {
    key: "macd",
    name: "MACD 金叉/死叉",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "macdCross",
    dataRequirements: ["daily_kline.close"],
    enabled: false,
    description: "MACD 出现金叉或死叉信号时触发。",
  },
  {
    key: "volume_price_divergence",
    name: "盘中放量滞涨/滞跌",
    category: "intraday",
    timeframe: "1m",
    formulaType: "builtin",
    formula: "volumePriceDivergence",
    paramsSchema: {
      volumeMultiplier: { type: "number", default: 3 },
      priceRangePercent: { type: "number", default: 0.5 },
    },
    dataRequirements: ["minute_kline.open", "minute_kline.high", "minute_kline.low", "minute_kline.close", "minute_kline.volume"],
    description: "分时 K 线中成交量显著放大但价格波动很小的异常。",
  },
  {
    key: "ma_breakout_above",
    name: "突破X日均线",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "maBreakoutAbove",
    paramsSchema: { period: { type: "number", default: 20, min: 1 } },
    dataRequirements: ["daily_kline.close"],
    description: "收盘价由下而上穿越 X 日均线。",
  },
  {
    key: "ma_breakout_below",
    name: "跌破X日均线",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "maBreakoutBelow",
    paramsSchema: { period: { type: "number", default: 20, min: 1 } },
    dataRequirements: ["daily_kline.close"],
    description: "收盘价由上而下穿越 X 日均线。",
  },
  {
    key: "macd_golden_cross",
    name: "MACD 金叉",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "macdGoldenCross",
    dataRequirements: ["daily_kline.close"],
    description: "DIF 由下上穿 DEA,短期转多信号。",
  },
  {
    key: "macd_death_cross",
    name: "MACD 死叉",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "macdDeathCross",
    dataRequirements: ["daily_kline.close"],
    description: "DIF 由上下穿 DEA,短期转空信号。",
  },
  {
    key: "kdj_oversold",
    name: "KDJ 超卖反弹",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "kdjOversold",
    paramsSchema: { threshold: { type: "number", default: 20, min: 0, max: 100 } },
    dataRequirements: ["daily_kline.high", "daily_kline.low", "daily_kline.close"],
    description: "KDJ 在超卖区(D 值低于阈值)出现 K 上穿 D。",
  },
  {
    key: "kdj_overbought",
    name: "KDJ 超买回落",
    category: "trend",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "kdjOverbought",
    paramsSchema: { threshold: { type: "number", default: 80, min: 0, max: 100 } },
    dataRequirements: ["daily_kline.high", "daily_kline.low", "daily_kline.close"],
    description: "KDJ 在超买区(D 值高于阈值)出现 K 下穿 D。",
  },
  {
    key: "capital_flow_main",
    name: "主力资金净流入异动",
    category: "capital_flow",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "capitalFlowMainThreshold",
    paramsSchema: { threshold: { type: "number", default: 5000, unit: "wan" } },
    dataRequirements: ["eastmoney.capital_flow.mainNetInflow"],
    reliability: "experimental",
    enabled: false,
    description: "东方财富资金流数据，仅用于巡检异动，不作为主力建仓或控盘结论。",
  },
  {
    key: "capital_flow_super_large",
    name: "超大单资金净流入异动",
    category: "capital_flow",
    timeframe: "realtime",
    formulaType: "builtin",
    formula: "capitalFlowSuperLargeThreshold",
    paramsSchema: { threshold: { type: "number", default: 3000, unit: "wan" } },
    dataRequirements: ["eastmoney.capital_flow.superLargeNetInflow"],
    reliability: "experimental",
    enabled: false,
    description: "东方财富超大单资金流数据，仅用于巡检异动，不作为主力建仓或控盘结论。",
  },
  {
    key: "main_force_control_proxy",
    name: "主力控盘迹象代理",
    category: "control_proxy",
    timeframe: "daily",
    formulaType: "manual_spec",
    formula: "controlProxyResearchPending",
    dataRequirements: ["daily_kline", "minute_kline", "chip_distribution(optional)", "tick(optional)"],
    reliability: "manual_review",
    enabled: false,
    description: "主力控盘只能作为迹象评分，不能作为确定结论；实现前需参考主力控盘调研文档。",
  },

  // ==================== L1 算子(category: "operator")====================
  // 这些是原子算子,返回结构化数值序列(非单一标量),
  // 供 L2 信号、L3a 规则树、L3b 沙箱脚本按字段引用。
  // 与上方 16 条(L2 信号)区分:信号引用算子 + 判定条件。

  {
    key: "MA",
    name: "简单移动平均",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeMA",
    paramsSchema: {
      period: { type: "number", default: 20, min: 1 },
    },
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline.close"],
    reliability: "stable",
    description: "标准 SMA 算子,周期可配。",
  },
  {
    key: "EMA",
    name: "指数移动平均",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeEMA",
    paramsSchema: {
      period: { type: "number", default: 12, min: 1 },
    },
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline.close"],
    reliability: "stable",
    description: "标准 EMA 算子,周期可配。",
  },
  {
    key: "MACD",
    name: "MACD 指标(算子)",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeMACD",
    paramsSchema: {
      short: { type: "number", default: 12 },
      long: { type: "number", default: 26 },
      signal: { type: "number", default: 9 },
    },
    outputSchema: {
      dif: "number",
      dea: "number",
      bar: "number",
    },
    dataRequirements: ["daily_kline.close"],
    reliability: "stable",
    description:
      "MACD 算子,返回 DIF/DEA/BAR 三条线。注意:现有 `macd` key 是金叉/死叉信号(L2),本算子是原始指标(L1)。",
  },
  {
    key: "KDJ",
    name: "KDJ 随机指标",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeKDJ",
    paramsSchema: {
      n: { type: "number", default: 9 },
      m1: { type: "number", default: 3 },
      m2: { type: "number", default: 3 },
    },
    outputSchema: {
      k: "number",
      d: "number",
      j: "number",
    },
    dataRequirements: ["daily_kline.high", "daily_kline.low", "daily_kline.close"],
    reliability: "stable",
    description: "通达信标准 KDJ 公式。",
  },
  {
    key: "BOLL",
    name: "布林带",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeBOLL",
    paramsSchema: {
      period: { type: "number", default: 20 },
      multiplier: { type: "number", default: 2 },
    },
    outputSchema: {
      up: "number",
      mid: "number",
      down: "number",
    },
    dataRequirements: ["daily_kline.high", "daily_kline.low", "daily_kline.close"],
    reliability: "stable",
    description: "布林带,STD 为总体标准差。",
  },
  {
    key: "RSI",
    name: "相对强弱指标",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeRSI",
    paramsSchema: {
      period: { type: "number", default: 6 },
    },
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline.close"],
    reliability: "stable",
    description: "Wilder 平滑 RSI。",
  },
  {
    key: "WR",
    name: "威廉指标",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeWR",
    paramsSchema: {
      period: { type: "number", default: 14 },
    },
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline.high", "daily_kline.low", "daily_kline.close"],
    reliability: "stable",
    description: "WR 威廉指标,值域 0-100。",
  },
  {
    key: "OBV",
    name: "能量潮",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeOBV",
    paramsSchema: {},
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline.close", "daily_kline.volume"],
    reliability: "stable",
    description: "OBV 能量潮,无参数。",
  },
  {
    key: "CHIP_DISTRIBUTION",
    name: "筹码分布",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "computeChipDistribution",
    paramsSchema: {
      granularity: { type: "number", default: 0.05 },
    },
    outputSchema: {
      bins: "array<number>",
      weights: "array<number>",
      total: "number",
    },
    dataRequirements: ["daily_kline", "turnover"],
    reliability: "experimental",
    description:
      "基于换手率衰减模型估算的筹码分布。假设成交均匀分布,与真实筹码数据有差距,必须告知用户 experimental。",
  },
  {
    key: "WINNER",
    name: "获利盘比例",
    category: "operator",
    timeframe: "daily",
    formulaType: "builtin",
    formula: "winner",
    paramsSchema: {
      price: { type: "number", required: true },
    },
    outputSchema: {
      value: "number",
    },
    dataRequirements: ["daily_kline", "turnover"],
    reliability: "experimental",
    description: "依赖 CHIP_DISTRIBUTION,返回给定价格下的获利盘比例(0-1)。等价于通达信 WINNER 函数。",
  },
];

function encode(value: unknown) {
  return JSON.stringify(value ?? {});
}

export async function ensureBuiltInIndicatorDefinitions() {
  const existing = await db.select({ key: indicatorDefinitions.key }).from(indicatorDefinitions);
  const existingKeys = new Set(existing.map((row) => row.key));
  const now = new Date().toISOString();

  for (const item of BUILT_IN_INDICATORS) {
    if (existingKeys.has(item.key)) continue;
    await db.insert(indicatorDefinitions).values({
      key: item.key,
      name: item.name,
      category: item.category,
      scope: "stock",
      timeframe: item.timeframe,
      formulaType: item.formulaType,
      formula: item.formula,
      paramsSchema: encode(item.paramsSchema),
      outputSchema: encode(item.outputSchema),
      dataRequirements: JSON.stringify(item.dataRequirements ?? []),
      reliability: item.reliability ?? "stable",
      enabled: item.enabled ?? true,
      owner: item.owner ?? "system",
      description: item.description,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function listIndicatorDefinitions() {
  await ensureBuiltInIndicatorDefinitions();
  return db.select().from(indicatorDefinitions);
}

export async function getIndicatorDefinition(key: string) {
  await ensureBuiltInIndicatorDefinitions();
  const rows = await db
    .select()
    .from(indicatorDefinitions)
    .where(eq(indicatorDefinitions.key, key))
    .limit(1);
  return rows[0] ?? null;
}
