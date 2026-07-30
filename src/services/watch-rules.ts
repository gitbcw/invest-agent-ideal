import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { indicatorCapability } from "./indicators.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { planBackend } from "../lib/data-backend.js";
import { marketDataReadCapability } from "./market-data.js";

export type WatchRuleType =
  | "price_cross"
  | "ma_cross"
  | "macd_cross"
  | "kdj_cross"
  | "rsi_threshold"
  | "boll_break"
  | "wr_threshold"
  | "volume_ratio"
  | "near_plan_level";
export type WatchRulePriority = "P0" | "P1" | "P2";
export type WatchRuleStatus = "active" | "beta";
export type WatchRuleTargetScope = "holding" | "watchlist" | "plan" | "manual";
export type WatchRuleDirection = "break_above" | "break_below";
export type WatchRuleMacdDirection = "golden_cross" | "death_cross";
export type WatchRuleKdjDirection = "golden_cross" | "death_cross";
export type WatchRuleBollDirection = "break_upper" | "break_lower";
export type WatchRuleThresholdDirection = "above" | "below";
export type NearPlanLevelType = "support" | "resistance" | "target" | "stop_loss";

type ParamsSchemaField =
  | { type: "enum"; required: boolean; options: string[]; default?: string }
  | { type: "number"; required: boolean; default?: number; min?: number; max?: number };

export interface WatchRuleCatalogItem {
  key: WatchRuleType;
  label: string;
  status: WatchRuleStatus;
  description: string;
  targetScopes: WatchRuleTargetScope[];
  paramsSchema: Record<string, ParamsSchemaField>;
  defaults: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  cooldownCapabilities: {
    supportedModes: Array<"cooldown" | "state">;
    defaultMinutes: number;
  };
  supportsDryRun: boolean;
}

export interface WatchRuleRecord {
  id: number;
  userId: string;
  instanceId: string;
  stockCode: string;
  stockName: string;
  ruleType: WatchRuleType;
  targetScope: WatchRuleTargetScope;
  params: Record<string, unknown>;
  cooldown: Record<string, unknown>;
  notification: {
    priority: WatchRulePriority;
    push: boolean;
  };
  enabled: boolean;
  schedule: string;
  severity: "high" | "medium" | "low";
  relationToPlan: string | null;
  source: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWatchRuleInput {
  userId?: string;
  instanceId?: string;
  stockCode: string;
  stockName?: string;
  ruleType: WatchRuleType;
  targetScope?: WatchRuleTargetScope;
  params: Record<string, unknown>;
  cooldown?: Record<string, unknown>;
  notification?: {
    priority?: WatchRulePriority;
    push?: boolean;
  };
  enabled?: boolean;
  source?: Record<string, unknown>;
}

export interface UpdateWatchRuleInput {
  stockName?: string;
  targetScope?: WatchRuleTargetScope;
  params?: Record<string, unknown>;
  cooldown?: Record<string, unknown>;
  notification?: {
    priority?: WatchRulePriority;
    push?: boolean;
  };
  enabled?: boolean;
  source?: Record<string, unknown>;
}

export interface ValidateWatchRuleInput {
  stockCode?: string;
  stockName?: string;
  ruleType?: string;
  targetScope?: string;
  params?: Record<string, unknown>;
  cooldown?: Record<string, unknown>;
  notification?: {
    priority?: string;
    push?: boolean;
  };
  enabled?: boolean;
  userId?: string;
  instanceId?: string;
}

export interface WatchRuleValidationResult {
  ok: boolean;
  errors: string[];
  normalized?: {
    userId: string;
    instanceId: string;
    stockCode: string;
    stockName: string;
    ruleType: WatchRuleType;
    targetScope: WatchRuleTargetScope;
    params: Record<string, unknown>;
    cooldown: Record<string, unknown>;
    notification: {
      priority: WatchRulePriority;
      push: boolean;
    };
    enabled: boolean;
  };
}

export interface DryRunWatchRuleResult {
  ok: boolean;
  triggered: boolean;
  rule: WatchRuleRecord;
  facts: Record<string, unknown>;
  reason: string;
}

interface PlanItem {
  code: string;
  name: string;
  pool: "holding" | "watchlist" | "manual";
  support: number | null;
  resistance: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
  observe: string[];
  notes?: string | null;
  source?: "daily_review" | "manual";
}

const WATCH_RULE_CATALOG: WatchRuleCatalogItem[] = [
  {
    key: "price_cross",
    label: "价格阈值触发",
    status: "active",
    description: "当最新价格上穿或下破指定阈值时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      operator: { type: "enum", required: true, options: [">=", "<="], default: ">=" },
      value: { type: "number", required: true, min: 0 },
    },
    defaults: { operator: ">=", cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { operator: ">=", value: 46.5 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "ma_cross",
    label: "均线突破/跌破",
    status: "active",
    description: "当最新收盘价对指定均线发生上破或下破时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: true, default: 20, min: 2, max: 250 },
      direction: { type: "enum", required: true, options: ["break_above", "break_below"], default: "break_above" },
    },
    defaults: { period: 20, direction: "break_above", cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 20, direction: "break_above" },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "macd_cross",
    label: "MACD 金叉/死叉",
    status: "active",
    description: "当日线 MACD 的 DIF 与 DEA 发生金叉或死叉时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      direction: { type: "enum", required: true, options: ["golden_cross", "death_cross"], default: "golden_cross" },
    },
    defaults: { direction: "golden_cross", cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { direction: "golden_cross" },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "kdj_cross",
    label: "KDJ 金叉/死叉",
    status: "active",
    description: "当日线 KDJ 的 K 与 D 发生金叉或死叉时触发，可配合超卖/超买阈值过滤。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      direction: { type: "enum", required: true, options: ["golden_cross", "death_cross"], default: "golden_cross" },
      threshold: { type: "number", required: false, default: 20, min: 0, max: 100 },
    },
    defaults: { direction: "golden_cross", threshold: 20, cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { direction: "golden_cross", threshold: 20 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "rsi_threshold",
    label: "RSI 阈值",
    status: "active",
    description: "当日线 RSI 高于或低于指定阈值时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: false, default: 6, min: 2, max: 60 },
      direction: { type: "enum", required: true, options: ["above", "below"], default: "below" },
      threshold: { type: "number", required: true, default: 30, min: 0, max: 100 },
    },
    defaults: { period: 6, direction: "below", threshold: 30, cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 6, direction: "below", threshold: 30 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "boll_break",
    label: "布林带突破",
    status: "active",
    description: "当日线收盘价突破布林带上轨或下轨时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: false, default: 20, min: 5, max: 120 },
      multiplier: { type: "number", required: false, default: 2, min: 0.5, max: 5 },
      direction: { type: "enum", required: true, options: ["break_upper", "break_lower"], default: "break_upper" },
    },
    defaults: { period: 20, multiplier: 2, direction: "break_upper", cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 20, multiplier: 2, direction: "break_upper" },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "wr_threshold",
    label: "WR 威廉指标阈值",
    status: "active",
    description: "当日线 WR 高于或低于指定阈值时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: false, default: 14, min: 2, max: 120 },
      direction: { type: "enum", required: true, options: ["above", "below"], default: "above" },
      threshold: { type: "number", required: true, default: 80, min: 0, max: 100 },
    },
    defaults: { period: 14, direction: "above", threshold: 80, cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 14, direction: "above", threshold: 80 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "volume_ratio",
    label: "成交量放大/缩小",
    status: "active",
    description: "当日成交量相对过去 N 日均量达到指定倍数时触发。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: false, default: 5, min: 2, max: 120 },
      direction: { type: "enum", required: true, options: ["above", "below"], default: "above" },
      threshold: { type: "number", required: true, default: 1.5, min: 0.01, max: 20 },
    },
    defaults: { period: 5, direction: "above", threshold: 1.5, cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 5, direction: "above", threshold: 1.5 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
  {
    key: "near_plan_level",
    label: "接近预案关键价位",
    status: "beta",
    description: "当价格接近支撑、压力、目标或止损位时触发。",
    targetScopes: ["plan", "manual"],
    paramsSchema: {
      levelType: { type: "enum", required: true, options: ["support", "resistance", "target", "stop_loss"], default: "support" },
      tolerancePercent: { type: "number", required: false, default: 1, min: 0.1, max: 10 },
    },
    defaults: { levelType: "support", tolerancePercent: 1, cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { levelType: "support", tolerancePercent: 1 },
      },
    ],
    cooldownCapabilities: {
      supportedModes: ["cooldown", "state"],
      defaultMinutes: 240,
    },
    supportsDryRun: true,
  },
];

const WATCH_RULE_RELATION = "stage2_watch_rule";
const RULE_TYPE_TO_INDICATOR_KEY: Record<WatchRuleType, string> = {
  price_cross: "watch_rule_price_cross",
  ma_cross: "watch_rule_ma_cross",
  macd_cross: "watch_rule_macd_cross",
  kdj_cross: "watch_rule_kdj_cross",
  rsi_threshold: "watch_rule_rsi_threshold",
  boll_break: "watch_rule_boll_break",
  wr_threshold: "watch_rule_wr_threshold",
  volume_ratio: "watch_rule_volume_ratio",
  near_plan_level: "watch_rule_near_plan_level",
};

export function listWatchRuleCatalog(): WatchRuleCatalogItem[] {
  return WATCH_RULE_CATALOG.map((item) => ({
    ...item,
    paramsSchema: { ...item.paramsSchema },
    defaults: { ...item.defaults },
    examples: item.examples.map((example) => ({ ...example })),
    cooldownCapabilities: {
      supportedModes: [...item.cooldownCapabilities.supportedModes],
      defaultMinutes: item.cooldownCapabilities.defaultMinutes,
    },
  }));
}

export function getWatchRuleCatalogItem(ruleType: string): WatchRuleCatalogItem | null {
  return WATCH_RULE_CATALOG.find((item) => item.key === ruleType) ?? null;
}

export async function listWatchRules(userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<WatchRuleRecord[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.relationToPlan, WATCH_RULE_RELATION)))
    .orderBy(desc(alertRules.updatedAt));
  return rows.map(deserializeWatchRule);
}

export async function getWatchRuleById(id: number, userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<WatchRuleRecord | null> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.id, id), eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.relationToPlan, WATCH_RULE_RELATION)))
    .limit(1);
  return rows[0] ? deserializeWatchRule(rows[0]) : null;
}

export async function createWatchRule(input: CreateWatchRuleInput): Promise<WatchRuleRecord> {
  const validation = await validateWatchRule(input);
  if (!validation.ok || !validation.normalized) {
    throw new Error(validation.errors.join("; "));
  }

  const now = new Date().toISOString();
  const normalized = validation.normalized;
  const schedule = scheduleForRule(normalized.ruleType);
  const severity = severityFromPriority(normalized.notification.priority);

  const inserted = await db.insert(alertRules).values({
    userId: normalized.userId,
    instanceId: normalized.instanceId,
    stockCode: normalized.stockCode,
    stockName: normalized.stockName,
    indicatorKey: RULE_TYPE_TO_INDICATOR_KEY[normalized.ruleType],
    condition: ruleTypeCondition(normalized.ruleType),
    params: JSON.stringify({
      ...normalized.params,
      ruleType: normalized.ruleType,
      targetScope: normalized.targetScope,
      notification: normalized.notification,
      source: input.source ?? { kind: "service_api" },
    }),
    schedule,
    dedupePolicy: JSON.stringify(normalized.cooldown),
    severity,
    relationToPlan: WATCH_RULE_RELATION,
    enabled: normalized.enabled,
    createdAt: now,
    updatedAt: now,
  }).returning();

  return deserializeWatchRule(inserted[0]);
}

export async function updateWatchRule(id: number, input: UpdateWatchRuleInput, userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<WatchRuleRecord> {
  const existing = await getWatchRuleById(id, userId, instanceId);
  if (!existing) throw new Error("规则不存在");

  const validation = await validateWatchRule({
    userId,
    instanceId,
    stockCode: existing.stockCode,
    stockName: input.stockName ?? existing.stockName,
    ruleType: existing.ruleType,
    targetScope: input.targetScope ?? existing.targetScope,
    params: input.params ?? existing.params,
    cooldown: input.cooldown ?? existing.cooldown,
    notification: input.notification ?? existing.notification,
    enabled: input.enabled ?? existing.enabled,
  });
  if (!validation.ok || !validation.normalized) {
    throw new Error(validation.errors.join("; "));
  }

  const normalized = validation.normalized;
  const now = new Date().toISOString();

  await db.update(alertRules).set({
    stockName: normalized.stockName,
    condition: ruleTypeCondition(normalized.ruleType),
    params: JSON.stringify({
      ...normalized.params,
      ruleType: normalized.ruleType,
      targetScope: normalized.targetScope,
      notification: normalized.notification,
      source: input.source ?? existing.source,
    }),
    dedupePolicy: JSON.stringify(normalized.cooldown),
    severity: severityFromPriority(normalized.notification.priority),
    enabled: normalized.enabled,
    updatedAt: now,
  }).where(eq(alertRules.id, id));

  const updated = await getWatchRuleById(id, userId, instanceId);
  if (!updated) throw new Error("规则更新后未找到");
  return updated;
}

export async function deleteWatchRule(id: number, userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<boolean> {
  const existing = await getWatchRuleById(id, userId, instanceId);
  if (!existing) return false;
  await db.delete(alertRules).where(eq(alertRules.id, id));
  return true;
}

export async function validateWatchRule(input: ValidateWatchRuleInput): Promise<WatchRuleValidationResult> {
  const errors: string[] = [];
  const userId = (input.userId ?? DEFAULT_USER_ID).trim();
  const instanceId = (input.instanceId ?? DEFAULT_INSTANCE_ID).trim();
  const stockCode = String(input.stockCode ?? "").trim();
  const stockName = String(input.stockName ?? input.stockCode ?? "").trim();
  const ruleType = input.ruleType as WatchRuleType | undefined;
  const catalog = ruleType ? getWatchRuleCatalogItem(ruleType) : null;
  const targetScope = normalizeTargetScope(input.targetScope);
  const enabled = input.enabled ?? true;
  const notification = normalizeNotification(input.notification, undefined, ruleType);
  const cooldown = normalizeCooldown(input.cooldown);

  if (!stockCode) errors.push("缺少股票代码");
  if (!ruleType || !catalog) errors.push("不支持的 ruleType");
  if (!targetScope) errors.push("不支持的 targetScope");
  if (!stockName) errors.push("缺少股票名称");

  const params = input.params ?? {};
  if (catalog) {
    if (!catalog.targetScopes.includes(targetScope as WatchRuleTargetScope)) {
      errors.push(`规则 ${catalog.key} 不支持 targetScope=${targetScope}`);
    }
  }

  let normalizedParams: Record<string, unknown> = {};
  if (catalog && errors.length === 0) {
    normalizedParams = normalizeRuleParams(catalog.key, params, errors);
  }

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        errors: [],
        normalized: {
          userId,
          instanceId,
          stockCode,
          stockName,
          ruleType: ruleType!,
          targetScope: targetScope!,
          params: normalizedParams,
          cooldown,
          notification,
          enabled,
        },
      };
}

export async function dryRunWatchRuleById(id: number, userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<DryRunWatchRuleResult> {
  const rule = await getWatchRuleById(id, userId, instanceId);
  if (!rule) throw new Error("规则不存在");
  return dryRunWatchRule(rule);
}

export async function dryRunWatchRule(rule: WatchRuleRecord): Promise<DryRunWatchRuleResult> {
  const quoteResult = await marketDataReadCapability.quote([rule.stockCode]);
  const quote = quoteResult.items[0];
  if (!quote) {
    return {
      ok: true,
      triggered: false,
      rule,
      facts: {
        warnings: quoteResult.warnings,
      },
      reason: quoteResult.warnings.length > 0
        ? `当前无法获取行情：${quoteResult.warnings.join("；")}`
        : "当前无法获取行情",
    };
  }
  const quoteFacts = {
    marketTime: quote.source.marketTime,
    fetchedAt: quote.source.fetchedAt,
    sourceProvider: quote.source.provider,
    sourceConfidence: quote.source.confidence,
    stale: quote.source.stale,
    warnings: [...quoteResult.warnings, ...quote.source.warnings],
  };

  if (rule.ruleType === "price_cross") {
    const operator = String(rule.params.operator);
    const value = Number(rule.params.value);
    const triggered = operator === ">=" ? quote.price >= value : quote.price <= value;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        currentPrice: quote.price,
        operator,
        threshold: value,
        ...quoteFacts,
      },
      reason: triggered
        ? `${rule.stockName} 当前价格 ${quote.price} 已满足 ${operator} ${value}`
        : `${rule.stockName} 当前价格 ${quote.price} 未满足 ${operator} ${value}`,
    };
  }

  if (rule.ruleType === "ma_cross") {
    const period = Number(rule.params.period);
    const direction = String(rule.params.direction) as WatchRuleDirection;
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: Math.max(80, period + 5) });
    const klines = klineResult.items as Array<{ close: number }>;
    if (klines.length < period + 2) {
      return {
        ok: true,
        triggered: false,
        rule,
        facts: {
          klineCount: klines.length,
          required: period + 2,
          marketTime: klineResult.source.marketTime,
          fetchedAt: klineResult.source.fetchedAt,
          sourceProvider: klineResult.source.provider,
          sourceConfidence: klineResult.source.confidence,
          stale: klineResult.source.stale,
          warnings: klineResult.source.warnings,
        },
        reason: "K线数量不足，无法判断均线突破",
      };
    }
    const closes = klines.map((item) => item.close);
    const maValues = indicatorCapability.computeMA(closes, period).values;
    const lastIdx = closes.length - 1;
    const prevIdx = lastIdx - 1;
    const maToday = maValues[lastIdx];
    const maPrev = maValues[prevIdx];
    if (maToday == null || maPrev == null) {
      return {
        ok: true,
        triggered: false,
        rule,
        facts: {},
        reason: "均线结果为空",
      };
    }
    const closeToday = closes[lastIdx];
    const closePrev = closes[prevIdx];
    const triggered = direction === "break_above"
      ? closePrev <= maPrev && closeToday > maToday
      : closePrev >= maPrev && closeToday < maToday;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday,
        closePrev,
        maToday,
        maPrev,
        period,
        direction,
        marketTime: klineResult.source.marketTime,
        fetchedAt: klineResult.source.fetchedAt,
        sourceProvider: klineResult.source.provider,
        sourceConfidence: klineResult.source.confidence,
        stale: klineResult.source.stale,
        warnings: klineResult.source.warnings,
      },
      reason: triggered
        ? `${rule.stockName} 已${direction === "break_above" ? "突破" : "跌破"} ${period} 日均线`
        : `${rule.stockName} 当前未发生 ${period} 日均线${direction === "break_above" ? "突破" : "跌破"}`,
    };
  }

  if (rule.ruleType === "macd_cross") {
    const direction = String(rule.params.direction) as WatchRuleMacdDirection;
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: 120 });
    const klines = klineResult.items as Array<{ close: number }>;
    if (klines.length < 35) {
      return {
        ok: true,
        triggered: false,
        rule,
        facts: {
          klineCount: klines.length,
          required: 35,
          marketTime: klineResult.source.marketTime,
          fetchedAt: klineResult.source.fetchedAt,
          sourceProvider: klineResult.source.provider,
          sourceConfidence: klineResult.source.confidence,
          stale: klineResult.source.stale,
          warnings: klineResult.source.warnings,
        },
        reason: "K线数量不足，无法判断 MACD 金叉/死叉",
      };
    }
    const closes = klines.map((item) => item.close);
    const { dif, dea } = indicatorCapability.computeMACD(closes);
    const lastIdx = closes.length - 1;
    const prevIdx = lastIdx - 1;
    const difToday = dif[lastIdx];
    const deaToday = dea[lastIdx];
    const difPrev = dif[prevIdx];
    const deaPrev = dea[prevIdx];
    if (
      difToday == null ||
      deaToday == null ||
      difPrev == null ||
      deaPrev == null
    ) {
      return {
        ok: true,
        triggered: false,
        rule,
        facts: {},
        reason: "MACD 结果为空",
      };
    }
    const triggered = direction === "golden_cross"
      ? difPrev <= deaPrev && difToday > deaToday
      : difPrev >= deaPrev && difToday < deaToday;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: closes[lastIdx],
        difToday,
        deaToday,
        difPrev,
        deaPrev,
        direction,
        marketTime: klineResult.source.marketTime,
        fetchedAt: klineResult.source.fetchedAt,
        sourceProvider: klineResult.source.provider,
        sourceConfidence: klineResult.source.confidence,
        stale: klineResult.source.stale,
        warnings: klineResult.source.warnings,
      },
      reason: triggered
        ? `${rule.stockName} MACD ${direction === "golden_cross" ? "金叉" : "死叉"}已触发`
        : `${rule.stockName} 当前未发生 MACD ${direction === "golden_cross" ? "金叉" : "死叉"}`,
    };
  }

  if (rule.ruleType === "kdj_cross") {
    const direction = String(rule.params.direction) as WatchRuleKdjDirection;
    const threshold = Number(rule.params.threshold ?? (direction === "golden_cross" ? 20 : 80));
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: 80 });
    const klines = klineResult.items as Array<{ close: number; high: number; low: number; volume: number }>;
    if (klines.length < 15) {
      return dailyKlineInsufficient(rule, klineResult.source, klines.length, 15, "K线数量不足，无法判断 KDJ 金叉/死叉");
    }
    const { k, d, j } = indicatorCapability.computeKDJ(klines as any);
    const lastIdx = klines.length - 1;
    const prevIdx = lastIdx - 1;
    const kToday = k[lastIdx];
    const dToday = d[lastIdx];
    const jToday = j[lastIdx];
    const kPrev = k[prevIdx];
    const dPrev = d[prevIdx];
    const crossed = direction === "golden_cross"
      ? kPrev <= dPrev && kToday > dToday
      : kPrev >= dPrev && kToday < dToday;
    const thresholdOk = direction === "golden_cross" ? dToday <= threshold : dToday >= threshold;
    const triggered = crossed && thresholdOk;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: klines[lastIdx].close,
        kToday,
        dToday,
        jToday,
        kPrev,
        dPrev,
        threshold,
        direction,
        ...klineFacts(klineResult.source),
      },
      reason: triggered
        ? `${rule.stockName} KDJ ${direction === "golden_cross" ? "金叉" : "死叉"}已触发`
        : `${rule.stockName} 当前未发生符合阈值的 KDJ ${direction === "golden_cross" ? "金叉" : "死叉"}`,
    };
  }

  if (rule.ruleType === "rsi_threshold") {
    const period = Number(rule.params.period ?? 6);
    const direction = String(rule.params.direction) as WatchRuleThresholdDirection;
    const threshold = Number(rule.params.threshold);
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: Math.max(80, period + 5) });
    const klines = klineResult.items as Array<{ close: number }>;
    if (klines.length < period + 2) {
      return dailyKlineInsufficient(rule, klineResult.source, klines.length, period + 2, "K线数量不足，无法判断 RSI 阈值");
    }
    const closes = klines.map((item) => item.close);
    const rsi = indicatorCapability.computeRSI(closes, period);
    const rsiToday = rsi.last;
    if (rsiToday == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "RSI 结果为空" };
    }
    const triggered = direction === "above" ? rsiToday >= threshold : rsiToday <= threshold;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: closes[closes.length - 1],
        rsiToday,
        period,
        direction,
        threshold,
        ...klineFacts(klineResult.source),
      },
      reason: triggered
        ? `${rule.stockName} RSI${period} ${rsiToday.toFixed(2)} 已${direction === "above" ? "高于" : "低于"} ${threshold}`
        : `${rule.stockName} RSI${period} ${rsiToday.toFixed(2)} 未${direction === "above" ? "高于" : "低于"} ${threshold}`,
    };
  }

  if (rule.ruleType === "boll_break") {
    const period = Number(rule.params.period ?? 20);
    const multiplier = Number(rule.params.multiplier ?? 2);
    const direction = String(rule.params.direction) as WatchRuleBollDirection;
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: Math.max(80, period + 5) });
    const klines = klineResult.items as Array<{ close: number; high: number; low: number; volume: number }>;
    if (klines.length < period + 2) {
      return dailyKlineInsufficient(rule, klineResult.source, klines.length, period + 2, "K线数量不足，无法判断布林带突破");
    }
    const boll = indicatorCapability.computeBOLL(klines as any, period, multiplier);
    const lastIdx = klines.length - 1;
    const closeToday = klines[lastIdx].close;
    const upper = boll.up[lastIdx];
    const mid = boll.mid[lastIdx];
    const lower = boll.down[lastIdx];
    if (upper == null || lower == null || mid == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "布林带结果为空" };
    }
    const triggered = direction === "break_upper" ? closeToday >= upper : closeToday <= lower;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday,
        upper,
        mid,
        lower,
        period,
        multiplier,
        direction,
        ...klineFacts(klineResult.source),
      },
      reason: triggered
        ? `${rule.stockName} 收盘价已${direction === "break_upper" ? "突破布林上轨" : "跌破布林下轨"}`
        : `${rule.stockName} 当前未${direction === "break_upper" ? "突破布林上轨" : "跌破布林下轨"}`,
    };
  }

  if (rule.ruleType === "wr_threshold") {
    const period = Number(rule.params.period ?? 14);
    const direction = String(rule.params.direction) as WatchRuleThresholdDirection;
    const threshold = Number(rule.params.threshold);
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: Math.max(80, period + 5) });
    const klines = klineResult.items as Array<{ close: number; high: number; low: number; volume: number }>;
    if (klines.length < period + 1) {
      return dailyKlineInsufficient(rule, klineResult.source, klines.length, period + 1, "K线数量不足，无法判断 WR 阈值");
    }
    const wr = indicatorCapability.computeWR(klines as any, period);
    const wrToday = wr.last;
    if (wrToday == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "WR 结果为空" };
    }
    const triggered = direction === "above" ? wrToday >= threshold : wrToday <= threshold;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: klines[klines.length - 1].close,
        wrToday,
        period,
        direction,
        threshold,
        ...klineFacts(klineResult.source),
      },
      reason: triggered
        ? `${rule.stockName} WR${period} ${wrToday.toFixed(2)} 已${direction === "above" ? "高于" : "低于"} ${threshold}`
        : `${rule.stockName} WR${period} ${wrToday.toFixed(2)} 未${direction === "above" ? "高于" : "低于"} ${threshold}`,
    };
  }

  if (rule.ruleType === "volume_ratio") {
    const period = Number(rule.params.period ?? 5);
    const direction = String(rule.params.direction) as WatchRuleThresholdDirection;
    const threshold = Number(rule.params.threshold);
    const klineResult = await marketDataReadCapability.kline({ code: rule.stockCode, period: "day", count: Math.max(80, period + 2) });
    const klines = klineResult.items as Array<{ close: number; volume: number }>;
    if (klines.length < period + 1) {
      return dailyKlineInsufficient(rule, klineResult.source, klines.length, period + 1, "K线数量不足，无法判断成交量倍数");
    }
    const lastIdx = klines.length - 1;
    const avgVolume = klines.slice(lastIdx - period, lastIdx).reduce((sum, item) => sum + item.volume, 0) / period;
    const volumeToday = klines[lastIdx].volume;
    const ratio = avgVolume > 0 ? volumeToday / avgVolume : 0;
    const triggered = direction === "above" ? ratio >= threshold : ratio <= threshold;
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: klines[lastIdx].close,
        volumeToday,
        avgVolume,
        ratio,
        period,
        direction,
        threshold,
        ...klineFacts(klineResult.source),
      },
      reason: triggered
        ? `${rule.stockName} 成交量为 ${period} 日均量的 ${ratio.toFixed(2)} 倍，已${direction === "above" ? "高于" : "低于"} ${threshold}`
        : `${rule.stockName} 成交量为 ${period} 日均量的 ${ratio.toFixed(2)} 倍，未${direction === "above" ? "高于" : "低于"} ${threshold}`,
    };
  }

  const levelType = String(rule.params.levelType) as NearPlanLevelType;
  const tolerancePercent = Number(rule.params.tolerancePercent);
  const plan = await loadLatestPlan(rule.userId, rule.instanceId, rule.stockCode);
  if (!plan) {
    return {
      ok: true,
      triggered: false,
      rule,
      facts: {},
      reason: "当前未找到对应预案，无法判断关键价位接近",
    };
  }
  const levelValue = resolvePlanLevel(plan, levelType);
  if (!levelValue) {
    return {
      ok: true,
      triggered: false,
      rule,
      facts: { plan },
      reason: `预案中未配置 ${levelType} 价位`,
    };
  }
  const diffPercent = levelValue > 0 ? Math.abs(quote.price - levelValue) / levelValue * 100 : Infinity;
  const triggered = diffPercent <= tolerancePercent;
  return {
    ok: true,
    triggered,
    rule,
    facts: {
      currentPrice: quote.price,
      levelType,
      levelValue,
      tolerancePercent,
      diffPercent,
      ...quoteFacts,
    },
    reason: triggered
      ? `${rule.stockName} 当前价格 ${quote.price} 已接近 ${levelType} ${levelValue}`
      : `${rule.stockName} 当前价格 ${quote.price} 与 ${levelType} ${levelValue} 相差 ${diffPercent.toFixed(2)}%`,
  };
}

function klineFacts(source: {
  marketTime?: string;
  fetchedAt: string;
  provider: string;
  confidence: string;
  stale: boolean;
  warnings: string[];
}) {
  return {
    marketTime: source.marketTime,
    fetchedAt: source.fetchedAt,
    sourceProvider: source.provider,
    sourceConfidence: source.confidence,
    stale: source.stale,
    warnings: source.warnings,
  };
}

function dailyKlineInsufficient(
  rule: WatchRuleRecord,
  source: Parameters<typeof klineFacts>[0],
  klineCount: number,
  required: number,
  reason: string,
): DryRunWatchRuleResult {
  return {
    ok: true,
    triggered: false,
    rule,
    facts: {
      klineCount,
      required,
      ...klineFacts(source),
    },
    reason,
  };
}

function deserializeWatchRule(row: typeof alertRules.$inferSelect): WatchRuleRecord {
  const params = parseJson(row.params);
  const cooldown = parseJson(row.dedupePolicy);
  const notification = normalizeNotification(params.notification as Record<string, unknown> | undefined, row.severity);
  const ruleType = normalizeRuleType(String(params.ruleType ?? row.indicatorKey));
  const targetScope = normalizeTargetScope(String(params.targetScope ?? "manual")) ?? "manual";
  const source = parseJsonObject(params.source);
  const cleanParams = { ...params };
  delete cleanParams.ruleType;
  delete cleanParams.targetScope;
  delete cleanParams.notification;
  delete cleanParams.source;

  return {
    id: row.id,
    userId: row.userId,
    instanceId: row.instanceId,
    stockCode: row.stockCode,
    stockName: row.stockName,
    ruleType,
    targetScope,
    params: cleanParams,
    cooldown,
    notification,
    enabled: row.enabled,
    schedule: row.schedule,
    severity: row.severity as "high" | "medium" | "low",
    relationToPlan: row.relationToPlan ?? null,
    source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJson(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
}

function normalizeRuleType(value: string): WatchRuleType {
  if (value === RULE_TYPE_TO_INDICATOR_KEY.price_cross || value === "price_cross") return "price_cross";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.ma_cross || value === "ma_cross") return "ma_cross";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.macd_cross || value === "macd_cross") return "macd_cross";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.kdj_cross || value === "kdj_cross") return "kdj_cross";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.rsi_threshold || value === "rsi_threshold") return "rsi_threshold";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.boll_break || value === "boll_break") return "boll_break";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.wr_threshold || value === "wr_threshold") return "wr_threshold";
  if (value === RULE_TYPE_TO_INDICATOR_KEY.volume_ratio || value === "volume_ratio") return "volume_ratio";
  return "near_plan_level";
}

function normalizeTargetScope(value?: string | null): WatchRuleTargetScope | null {
  if (value === "holding" || value === "watchlist" || value === "plan" || value === "manual") return value;
  return value == null ? "manual" : null;
}

function normalizeNotification(
  value?: { priority?: string; push?: boolean } | Record<string, unknown>,
  fallbackSeverity?: string,
  fallbackRuleType?: WatchRuleType
): { priority: WatchRulePriority; push: boolean } {
  const priority = value?.priority === "P0" || value?.priority === "P1" || value?.priority === "P2"
    ? value.priority
    : priorityFromSeverity(fallbackSeverity, fallbackRuleType);
  return {
    priority,
    push: typeof value?.push === "boolean" ? value.push : true,
  };
}

function normalizeCooldown(value?: Record<string, unknown>) {
  const mode = value?.mode === "state" ? "state" : "cooldown";
  const minutes = Number(value?.minutes ?? value?.cooldownMinutes ?? 240);
  return {
    mode,
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 240,
  };
}

function normalizeRuleParams(ruleType: WatchRuleType, params: Record<string, unknown>, errors: string[]) {
  if (ruleType === "price_cross") {
    const operator = params.operator === "<=" ? "<=" : params.operator === ">=" ? ">=" : null;
    const value = Number(params.value);
    if (!operator) errors.push("price_cross.operator 必须是 >= 或 <=");
    if (!Number.isFinite(value) || value <= 0) errors.push("price_cross.value 必须是正数");
    return { operator: operator ?? ">=", value };
  }
  if (ruleType === "ma_cross") {
    const period = Number(params.period);
    const direction = params.direction === "break_below" ? "break_below" : params.direction === "break_above" ? "break_above" : null;
    if (!Number.isInteger(period) || period < 2 || period > 250) errors.push("ma_cross.period 必须在 2 到 250 之间");
    if (!direction) errors.push("ma_cross.direction 必须是 break_above 或 break_below");
    return { period, direction: direction ?? "break_above" };
  }
  if (ruleType === "macd_cross") {
    const direction = params.direction === "death_cross" ? "death_cross" : params.direction === "golden_cross" ? "golden_cross" : null;
    if (!direction) errors.push("macd_cross.direction 必须是 golden_cross 或 death_cross");
    return { direction: direction ?? "golden_cross" };
  }
  if (ruleType === "kdj_cross") {
    const direction = params.direction === "death_cross" ? "death_cross" : params.direction === "golden_cross" ? "golden_cross" : null;
    const threshold = Number(params.threshold ?? (direction === "death_cross" ? 80 : 20));
    if (!direction) errors.push("kdj_cross.direction 必须是 golden_cross 或 death_cross");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("kdj_cross.threshold 必须在 0 到 100 之间");
    return { direction: direction ?? "golden_cross", threshold };
  }
  if (ruleType === "rsi_threshold") {
    const period = Number(params.period ?? 6);
    const direction = normalizeThresholdDirection(params.direction);
    const threshold = Number(params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 60) errors.push("rsi_threshold.period 必须在 2 到 60 之间");
    if (!direction) errors.push("rsi_threshold.direction 必须是 above 或 below");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("rsi_threshold.threshold 必须在 0 到 100 之间");
    return { period, direction: direction ?? "below", threshold };
  }
  if (ruleType === "boll_break") {
    const period = Number(params.period ?? 20);
    const multiplier = Number(params.multiplier ?? 2);
    const direction = params.direction === "break_lower" ? "break_lower" : params.direction === "break_upper" ? "break_upper" : null;
    if (!Number.isInteger(period) || period < 5 || period > 120) errors.push("boll_break.period 必须在 5 到 120 之间");
    if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 5) errors.push("boll_break.multiplier 必须在 0.5 到 5 之间");
    if (!direction) errors.push("boll_break.direction 必须是 break_upper 或 break_lower");
    return { period, multiplier, direction: direction ?? "break_upper" };
  }
  if (ruleType === "wr_threshold") {
    const period = Number(params.period ?? 14);
    const direction = normalizeThresholdDirection(params.direction);
    const threshold = Number(params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 120) errors.push("wr_threshold.period 必须在 2 到 120 之间");
    if (!direction) errors.push("wr_threshold.direction 必须是 above 或 below");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("wr_threshold.threshold 必须在 0 到 100 之间");
    return { period, direction: direction ?? "above", threshold };
  }
  if (ruleType === "volume_ratio") {
    const period = Number(params.period ?? 5);
    const direction = normalizeThresholdDirection(params.direction);
    const threshold = Number(params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 120) errors.push("volume_ratio.period 必须在 2 到 120 之间");
    if (!direction) errors.push("volume_ratio.direction 必须是 above 或 below");
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 20) errors.push("volume_ratio.threshold 必须在 0 到 20 之间");
    return { period, direction: direction ?? "above", threshold };
  }
  const levelType = params.levelType === "resistance" || params.levelType === "target" || params.levelType === "stop_loss" || params.levelType === "support"
    ? params.levelType
    : null;
  const tolerancePercent = Number(params.tolerancePercent ?? 1);
  if (!levelType) errors.push("near_plan_level.levelType 必须是 support/resistance/target/stop_loss");
  if (!Number.isFinite(tolerancePercent) || tolerancePercent <= 0 || tolerancePercent > 10) {
    errors.push("near_plan_level.tolerancePercent 必须在 0 到 10 之间");
  }
  return {
    levelType: levelType ?? "support",
    tolerancePercent,
  };
}

function normalizeThresholdDirection(value: unknown): WatchRuleThresholdDirection | null {
  if (value === "above" || value === "below") return value;
  return null;
}

function severityFromPriority(priority: WatchRulePriority): "high" | "medium" | "low" {
  if (priority === "P0") return "high";
  if (priority === "P1") return "medium";
  return "low";
}

function priorityFromSeverity(severity?: string, ruleType?: WatchRuleType): WatchRulePriority {
  if (
    ruleType === "price_cross" ||
    ruleType === "ma_cross" ||
    ruleType === "macd_cross" ||
    ruleType === "kdj_cross" ||
    ruleType === "rsi_threshold" ||
    ruleType === "boll_break" ||
    ruleType === "wr_threshold" ||
    ruleType === "volume_ratio" ||
    ruleType === "near_plan_level"
  ) return "P0";
  if (severity === "high") return "P0";
  if (severity === "medium") return "P1";
  return "P2";
}

function scheduleForRule(ruleType: WatchRuleType) {
  if (
    ruleType === "ma_cross" ||
    ruleType === "macd_cross" ||
    ruleType === "kdj_cross" ||
    ruleType === "rsi_threshold" ||
    ruleType === "boll_break" ||
    ruleType === "wr_threshold" ||
    ruleType === "volume_ratio"
  ) return "daily_or_intraday";
  return "intraday";
}

function ruleTypeCondition(ruleType: WatchRuleType) {
  if (ruleType === "price_cross") return "watch_rule.price_cross";
  if (ruleType === "ma_cross") return "watch_rule.ma_cross";
  if (ruleType === "macd_cross") return "watch_rule.macd_cross";
  if (ruleType === "kdj_cross") return "watch_rule.kdj_cross";
  if (ruleType === "rsi_threshold") return "watch_rule.rsi_threshold";
  if (ruleType === "boll_break") return "watch_rule.boll_break";
  if (ruleType === "wr_threshold") return "watch_rule.wr_threshold";
  if (ruleType === "volume_ratio") return "watch_rule.volume_ratio";
  return "watch_rule.near_plan_level";
}

async function loadLatestPlan(userId: string, instanceId: string, stockCode: string): Promise<PlanItem | null> {
  const manualPlans = await planBackend.list(userId, instanceId);
  const manual = manualPlans.find((item) => item.code === stockCode);
  if (manual) {
    return {
      code: manual.code,
      name: manual.name,
      pool: "manual",
      support: manual.support ?? null,
      resistance: manual.resistance ?? null,
      targetPrice: manual.targetPrice ?? null,
      stopLoss: manual.stopLoss ?? null,
      observe: manual.notes ? [manual.notes] : [],
      notes: manual.notes ?? null,
      source: "manual",
    };
  }

  const latest = await dailyPlanBackend.getLatest(userId, instanceId);
  const items = ((latest?.data ?? {}) as { items?: PlanItem[] }).items ?? [];
  return items.find((item) => item.code === stockCode) ?? null;
}

function resolvePlanLevel(plan: PlanItem, levelType: NearPlanLevelType): number | null {
  if (levelType === "support") return plan.support ?? null;
  if (levelType === "resistance") return plan.resistance ?? null;
  if (levelType === "target") return plan.targetPrice ?? null;
  return plan.stopLoss ?? null;
}
