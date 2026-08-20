import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sqlite } from "../db/index.js";
import { alertRules } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { getRulePrices, type RulePriceFact } from "./rule-price-facts.js";
import { computeBOLL, computeKDJ, computeMA, computeMACD, computeRSI, computeWR } from "./indicators.js";

// WP8 曾把非价格规则退役；2026-08-15 ma_cross、2026-08-20 五类技术指标
// (macd_cross/kdj_cross/rsi_threshold/boll_break/wr_threshold) 经 market-data
// MCP 复活 (K线由 MCP 提供,服务不再有自有行情 provider)。volume_ratio 与
// near_plan_level 仍未复活,按摩擦驱动原则等真实需求再动。
export type WatchRuleType =
  | "price_cross"
  | "ma_cross"
  | "macd_cross"
  | "kdj_cross"
  | "rsi_threshold"
  | "boll_break"
  | "wr_threshold";
export type WatchRulePriority = "P0" | "P1" | "P2";
export type WatchRuleStatus = "active" | "beta" | "deprecated";
export type WatchRuleTargetScope = "holding" | "watchlist" | "plan" | "manual";

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
    description: "日收盘上穿或下破指定周期均线时触发（当日与前一日对比判定交叉）。",
    targetScopes: ["holding", "watchlist", "manual"],
    paramsSchema: {
      period: { type: "number", required: true, min: 2, max: 250, default: 25 },
      direction: { type: "enum", required: true, options: ["break_above", "break_below"], default: "break_above" },
    },
    defaults: { period: 25, direction: "break_above", cooldownMinutes: 240 },
    examples: [
      {
        stockCode: "600036",
        params: { period: 25, direction: "break_above" },
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
    description: "当日线 MACD 的 DIF 与 DEA 发生金叉或死叉时触发（当日与前一日对比判定交叉）。",
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
    description: "当日线 KDJ 的 K 与 D 发生金叉或死叉时触发，可配合超卖/超买阈值过滤（金叉看 D≤阈值，死叉看 D≥阈值）。",
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
    description: "当日线 RSI 高于或低于指定阈值时触发（如 RSI6 低于 30 视为超卖）。",
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
    description: "当日线收盘价突破布林带上轨或跌破下轨时触发。",
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
    description: "当日线 WR 高于或低于指定阈值时触发（WR 越高越接近区间低点，如 WR14 高于 80 视为超卖）。",
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

/** Insert a previously validated rule into the caller's SQLite transaction. */
export function insertValidatedWatchRule(input: CreateWatchRuleInput, normalized: NonNullable<WatchRuleValidationResult["normalized"]>, now = new Date().toISOString()): void {
  sqlite.prepare(
    "INSERT INTO alert_rules (user_id,instance_id,stock_code,stock_name,indicator_key,condition,params,schedule,dedupe_policy,severity,relation_to_plan,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    normalized.userId, normalized.instanceId, normalized.stockCode, normalized.stockName,
    RULE_TYPE_TO_INDICATOR_KEY[normalized.ruleType], ruleTypeCondition(normalized.ruleType),
    JSON.stringify({ ...normalized.params, ruleType: normalized.ruleType, targetScope: normalized.targetScope, notification: normalized.notification, source: input.source ?? { kind: "service_api" } }),
    scheduleForRule(normalized.ruleType), JSON.stringify(normalized.cooldown), severityFromPriority(normalized.notification.priority),
    WATCH_RULE_RELATION, normalized.enabled ? 1 : 0, now, now,
  );
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
  // F4: 规范代码验证 —— 必须是纯 6 位数字（不含 sh/sz 前缀）
  if (stockCode && !/^\d{6}$/.test(stockCode)) {
    errors.push("stockCode 必须是 6 位数字代码（如 600519），不带 sh/sz 前缀");
  }
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
    // WP6: 退役的规则禁止新建 (存量保留,生产零启用无影响;彻底删除留 WP8)
    if (catalog.status === "deprecated") {
      errors.push(`规则 ${catalog.key} 已退役，不再支持新建。后续将通过外部量化选股工具实现。`);
    }
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

/**
 * WP5: 用窄事实 RulePriceFact 判定 price_cross。
 * 产出与旧 quote 路径兼容的 facts 结构 (currentPrice/operator/threshold/sourceProvider/warnings)。
 * 不可用 (usable=false) 时不触发,留下最小诊断。
 */
function evaluatePriceCrossFromFact(rule: WatchRuleRecord, fact: RulePriceFact | null): DryRunWatchRuleResult {
  const operator = String(rule.params.operator);
  const value = Number(rule.params.value);

  if (!fact || !fact.usable || fact.price == null) {
    const reason = fact?.failureCode
      ? `当前无法获取行情：${fact.failureCode}`
      : "当前无法获取行情";
    return {
      ok: true,
      triggered: false,
      rule,
      facts: {
        warnings: fact?.failureCode ? [fact.failureCode] : [],
        ...(fact?.price != null ? { currentPrice: fact.price } : {}),
        ...(fact?.provider ? { sourceProvider: fact.provider } : {}),
      },
      reason,
    };
  }

  const price = fact.price;
  const triggered = operator === ">=" ? price >= value : price <= value;
  return {
    ok: true,
    triggered,
    rule,
    facts: {
      currentPrice: price,
      operator,
      threshold: value,
      marketTime: fact.asOf,
      sourceProvider: fact.provider,
      ...(fact.provider === "sina_quote" ? { warnings: ["fallback_provider:sina_quote"] } : {}),
    },
    reason: triggered
      ? `${rule.stockName} 当前价格 ${price} 已满足 ${operator} ${value}`
      : `${rule.stockName} 当前价格 ${price} 未满足 ${operator} ${value}`,
  };
}

export async function dryRunWatchRuleById(id: number, userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<DryRunWatchRuleResult> {
  const rule = await getWatchRuleById(id, userId, instanceId);
  if (!rule) throw new Error("规则不存在");
  return dryRunWatchRule(rule);
}

type DailyKlineFetcher = (code: string, count: number) => Promise<{ items: Array<{ date: string; open: number; close: number; high: number; low: number; volume: number }>; provider: string | null; fetchedAt: string | null }>;

const KLINE_CACHE_TTL_MS = 60_000;
let klineCache: { key: string; result: Awaited<ReturnType<DailyKlineFetcher>>; expiresAt: number } | null = null;

let fetchDailyKlines: DailyKlineFetcher = async (code, count) => {
  const cacheKey = `${code}:${count}`;
  if (klineCache && klineCache.key === cacheKey && klineCache.expiresAt > Date.now()) {
    return klineCache.result;
  }
  const { mcpDailyKlines } = await import("./market-data-mcp.js");
  const result = await mcpDailyKlines(code, count);
  klineCache = { key: cacheKey, result, expiresAt: Date.now() + KLINE_CACHE_TTL_MS };
  return result;
};

/** 测试注入点：替换K线来源。传 null 恢复 MCP 默认实现。 */
export function setDailyKlineFetcherForTests(fetcher: DailyKlineFetcher | null): void {
  klineCache = null;
  fetchDailyKlines = fetcher
    ? fetcher
    : async (code, count) => {
        const { mcpDailyKlines } = await import("./market-data-mcp.js");
        return mcpDailyKlines(code, count);
      };
}

type DailyKlines = Awaited<ReturnType<DailyKlineFetcher>>;

type KlineFetchOutcome = { ok: true; klines: DailyKlines } | { ok: false; result: DryRunWatchRuleResult };

/** K线类规则共用取数：失败以软结果返回，不向巡检循环抛错。 */
async function fetchKlinesForRule(rule: WatchRuleRecord, count: number): Promise<KlineFetchOutcome> {
  try {
    return { ok: true, klines: await fetchDailyKlines(rule.stockCode, count) };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: true,
        triggered: false,
        rule,
        facts: { failureCode: (error as { code?: string })?.code ?? "kline_fetch_failed" },
        reason: `K线获取失败：${(error as Error).message.slice(0, 120)}`,
      },
    };
  }
}

function klinesInsufficient(rule: WatchRuleRecord, klines: DailyKlines, required: number, label: string): DryRunWatchRuleResult {
  return {
    ok: true,
    triggered: false,
    rule,
    facts: { klineCount: klines.items.length, required },
    reason: label,
  };
}

function klineMetaFacts(klines: DailyKlines): Record<string, unknown> {
  return { marketTime: klines.fetchedAt, sourceProvider: klines.provider };
}

export async function dryRunWatchRule(rule: WatchRuleRecord, priceFact?: RulePriceFact | null): Promise<DryRunWatchRuleResult> {
  if (rule.ruleType === "price_cross") {
    const fact = priceFact === undefined
      ? (await getRulePrices([rule.stockCode])).get(rule.stockCode) ?? null
      : priceFact;
    return evaluatePriceCrossFromFact(rule, fact);
  }

  if (rule.ruleType === "ma_cross") {
    // 语义与生产一致（2026-08-15 经 MCP 复活）：当日收盘与 N 日均线的
    // 交叉事件——昨收不高于昨 MA 且 今收高于今 MA 记 break_above（反向为
    // break_below）。K线取 max(80, period+5) 根日线。
    const period = Math.trunc(Number(rule.params.period));
    const direction = rule.params.direction === "break_below" ? "break_below" : "break_above";
    if (!Number.isInteger(period) || period < 2 || period > 250) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "ma_cross.period 参数无效" };
    }
    const fetched = await fetchKlinesForRule(rule, Math.max(80, period + 5));
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < period + 2) {
      return klinesInsufficient(rule, klines, period + 2, "K线数量不足，无法判断均线突破");
    }
    const closes = klines.items.map((item) => item.close);
    const maValues = computeMA(closes, period).values;
    const lastIdx = closes.length - 1;
    const prevIdx = lastIdx - 1;
    const maToday = maValues[lastIdx];
    const maPrev = maValues[prevIdx];
    if (maToday == null || maPrev == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "均线结果为空" };
    }
    const closeToday = closes[lastIdx];
    const closePrev = closes[prevIdx];
    const triggered = direction === "break_above"
      ? closePrev <= maPrev && closeToday > maToday
      : closePrev >= maPrev && closeToday < maToday;
    const verb = direction === "break_above" ? "突破" : "跌破";
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
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发均线规则：${verb} ${period} 日均线，现价 ${closeToday.toFixed(2)}，MA${period} ${maToday.toFixed(2)}`
        : `${rule.stockName}(${rule.stockCode}) 未${verb} ${period} 日均线，现价 ${closeToday.toFixed(2)}，MA${period} ${maToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "macd_cross") {
    // DIF/DEA 交叉事件（当日 vs 前一日），参数沿用通达信默认 12/26/9。
    // K线取 120 根（EMA 收敛余量，最少 35 根 = 26+9）。
    const direction = rule.params.direction === "death_cross" ? "death_cross" : "golden_cross";
    const fetched = await fetchKlinesForRule(rule, 120);
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < 35) {
      return klinesInsufficient(rule, klines, 35, "K线数量不足，无法判断 MACD 金叉/死叉");
    }
    const closes = klines.items.map((item) => item.close);
    const { dif, dea } = computeMACD(closes);
    const lastIdx = closes.length - 1;
    const prevIdx = lastIdx - 1;
    const difToday = dif[lastIdx];
    const deaToday = dea[lastIdx];
    const difPrev = dif[prevIdx];
    const deaPrev = dea[prevIdx];
    if (difToday == null || deaToday == null || difPrev == null || deaPrev == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "MACD 结果为空" };
    }
    const triggered = direction === "golden_cross"
      ? difPrev <= deaPrev && difToday > deaToday
      : difPrev >= deaPrev && difToday < deaToday;
    const noun = direction === "golden_cross" ? "金叉" : "死叉";
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
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发MACD规则：${noun}，DIF ${difToday.toFixed(3)} ${direction === "golden_cross" ? "上穿" : "下穿"} DEA ${deaToday.toFixed(3)}`
        : `${rule.stockName}(${rule.stockCode}) 当前未发生 MACD ${noun}，DIF ${difToday.toFixed(3)}，DEA ${deaToday.toFixed(3)}`,
    };
  }

  if (rule.ruleType === "kdj_cross") {
    // K/D 交叉事件 + 阈值过滤：金叉要求当日 D ≤ 阈值（超卖区金叉），
    // 死叉要求当日 D ≥ 阈值（超买区死叉）。默认 9/3/3 参数。
    const direction = rule.params.direction === "death_cross" ? "death_cross" : "golden_cross";
    const threshold = Number(rule.params.threshold ?? (direction === "golden_cross" ? 20 : 80));
    const fetched = await fetchKlinesForRule(rule, 80);
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < 15) {
      return klinesInsufficient(rule, klines, 15, "K线数量不足，无法判断 KDJ 金叉/死叉");
    }
    const { k, d, j } = computeKDJ(klines.items);
    const lastIdx = klines.items.length - 1;
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
    const noun = direction === "golden_cross" ? "金叉" : "死叉";
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: klines.items[lastIdx].close,
        kToday,
        dToday,
        jToday,
        kPrev,
        dPrev,
        threshold,
        direction,
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发KDJ规则：${noun}，K ${kToday.toFixed(2)} / D ${dToday.toFixed(2)}（阈值 ${threshold}）`
        : `${rule.stockName}(${rule.stockCode}) 当前未发生符合阈值的 KDJ ${noun}，K ${kToday.toFixed(2)} / D ${dToday.toFixed(2)}（阈值 ${threshold}）`,
    };
  }

  if (rule.ruleType === "rsi_threshold") {
    // RSI 阈值状态（非交叉）：当日 RSI ≥ 或 ≤ 阈值即触发。
    const period = Math.trunc(Number(rule.params.period ?? 6));
    const direction = rule.params.direction === "above" ? "above" : "below";
    const threshold = Number(rule.params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 60 || !Number.isFinite(threshold)) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "rsi_threshold 参数无效" };
    }
    const fetched = await fetchKlinesForRule(rule, Math.max(80, period + 5));
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < period + 2) {
      return klinesInsufficient(rule, klines, period + 2, "K线数量不足，无法判断 RSI 阈值");
    }
    const closes = klines.items.map((item) => item.close);
    const rsiToday = computeRSI(closes, period).last;
    if (rsiToday == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "RSI 结果为空" };
    }
    const triggered = direction === "above" ? rsiToday >= threshold : rsiToday <= threshold;
    const verb = direction === "above" ? "高于" : "低于";
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
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发RSI规则：RSI${period} ${rsiToday.toFixed(2)} 已${verb} ${threshold}`
        : `${rule.stockName}(${rule.stockCode}) RSI${period} ${rsiToday.toFixed(2)} 未${verb} ${threshold}`,
    };
  }

  if (rule.ruleType === "boll_break") {
    // 布林带轨道突破状态：当日收盘 ≥ 上轨 或 ≤ 下轨即触发。
    const period = Math.trunc(Number(rule.params.period ?? 20));
    const multiplier = Number(rule.params.multiplier ?? 2);
    const direction = rule.params.direction === "break_lower" ? "break_lower" : "break_upper";
    if (!Number.isInteger(period) || period < 5 || period > 120 || !Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 5) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "boll_break 参数无效" };
    }
    const fetched = await fetchKlinesForRule(rule, Math.max(80, period + 5));
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < period + 2) {
      return klinesInsufficient(rule, klines, period + 2, "K线数量不足，无法判断布林带突破");
    }
    const boll = computeBOLL(klines.items, period, multiplier);
    const lastIdx = klines.items.length - 1;
    const closeToday = klines.items[lastIdx].close;
    const upper = boll.up[lastIdx];
    const mid = boll.mid[lastIdx];
    const lower = boll.down[lastIdx];
    if (upper == null || mid == null || lower == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "布林带结果为空" };
    }
    const triggered = direction === "break_upper" ? closeToday >= upper : closeToday <= lower;
    const verb = direction === "break_upper" ? "突破布林上轨" : "跌破布林下轨";
    const band = direction === "break_upper" ? upper : lower;
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
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发布林带规则：现价 ${closeToday.toFixed(2)} ${verb} ${band.toFixed(2)}`
        : `${rule.stockName}(${rule.stockCode}) 当前未${verb}（${band.toFixed(2)}），现价 ${closeToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "wr_threshold") {
    // WR 阈值状态：当日 WR ≥ 或 ≤ 阈值即触发（WR 越高越接近区间低点）。
    const period = Math.trunc(Number(rule.params.period ?? 14));
    const direction = rule.params.direction === "below" ? "below" : "above";
    const threshold = Number(rule.params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 120 || !Number.isFinite(threshold)) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "wr_threshold 参数无效" };
    }
    const fetched = await fetchKlinesForRule(rule, Math.max(80, period + 5));
    if (!fetched.ok) return fetched.result;
    const klines = fetched.klines;
    if (klines.items.length < period + 1) {
      return klinesInsufficient(rule, klines, period + 1, "K线数量不足，无法判断 WR 阈值");
    }
    const wrToday = computeWR(klines.items, period).last;
    if (wrToday == null) {
      return { ok: true, triggered: false, rule, facts: {}, reason: "WR 结果为空" };
    }
    const triggered = direction === "above" ? wrToday >= threshold : wrToday <= threshold;
    const verb = direction === "above" ? "高于" : "低于";
    return {
      ok: true,
      triggered,
      rule,
      facts: {
        closeToday: klines.items[klines.items.length - 1].close,
        wrToday,
        period,
        direction,
        threshold,
        ...klineMetaFacts(klines),
      },
      reason: triggered
        ? `${rule.stockName}(${rule.stockCode}) 触发威廉指标规则：WR${period} ${wrToday.toFixed(2)} 已${verb} ${threshold}`
        : `${rule.stockName}(${rule.stockCode}) WR${period} ${wrToday.toFixed(2)} 未${verb} ${threshold}`,
    };
  }

  return {
    ok: true,
    triggered: false,
    rule,
    facts: {},
    reason: `不支持的规则类型：${rule.ruleType}`,
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
  for (const [ruleType, indicatorKey] of Object.entries(RULE_TYPE_TO_INDICATOR_KEY)) {
    if (value === indicatorKey || value === ruleType) return ruleType as WatchRuleType;
  }
  // WP8: volume_ratio/near_plan_level 已退役,反序列化时归一为 price_cross 避免 DB 残留行报错
  return "price_cross";
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
    const period = Math.trunc(Number(params.period));
    const direction = params.direction === "break_below" ? "break_below" : params.direction === "break_above" ? "break_above" : null;
    if (!Number.isInteger(period) || period < 2 || period > 250) errors.push("ma_cross.period 必须是 2 到 250 之间的整数");
    if (!direction) errors.push("ma_cross.direction 必须是 break_above 或 break_below");
    return { period: Number.isInteger(period) ? period : 25, direction: direction ?? "break_above" };
  }
  if (ruleType === "macd_cross") {
    const direction = params.direction === "death_cross" ? "death_cross" : params.direction === "golden_cross" ? "golden_cross" : null;
    if (!direction) errors.push("macd_cross.direction 必须是 golden_cross 或 death_cross");
    return { direction: direction ?? "golden_cross" };
  }
  if (ruleType === "kdj_cross") {
    const direction = params.direction === "death_cross" ? "death_cross" : params.direction === "golden_cross" ? "golden_cross" : null;
    const threshold = params.threshold === undefined ? 20 : Number(params.threshold);
    if (!direction) errors.push("kdj_cross.direction 必须是 golden_cross 或 death_cross");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("kdj_cross.threshold 必须是 0 到 100 之间的数");
    return { direction: direction ?? "golden_cross", threshold: Number.isFinite(threshold) ? threshold : 20 };
  }
  if (ruleType === "rsi_threshold") {
    const period = Math.trunc(Number(params.period ?? 6));
    const direction = params.direction === "above" ? "above" : params.direction === "below" ? "below" : null;
    const threshold = Number(params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 60) errors.push("rsi_threshold.period 必须是 2 到 60 之间的整数");
    if (!direction) errors.push("rsi_threshold.direction 必须是 above 或 below");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("rsi_threshold.threshold 必须是 0 到 100 之间的数");
    return { period: Number.isInteger(period) ? period : 6, direction: direction ?? "below", threshold: Number.isFinite(threshold) ? threshold : 30 };
  }
  if (ruleType === "boll_break") {
    const period = Math.trunc(Number(params.period ?? 20));
    const multiplier = Number(params.multiplier ?? 2);
    const direction = params.direction === "break_lower" ? "break_lower" : params.direction === "break_upper" ? "break_upper" : null;
    if (!Number.isInteger(period) || period < 5 || period > 120) errors.push("boll_break.period 必须是 5 到 120 之间的整数");
    if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 5) errors.push("boll_break.multiplier 必须是 0.5 到 5 之间的数");
    if (!direction) errors.push("boll_break.direction 必须是 break_upper 或 break_lower");
    return {
      period: Number.isInteger(period) ? period : 20,
      multiplier: Number.isFinite(multiplier) ? multiplier : 2,
      direction: direction ?? "break_upper",
    };
  }
  if (ruleType === "wr_threshold") {
    const period = Math.trunc(Number(params.period ?? 14));
    const direction = params.direction === "above" ? "above" : params.direction === "below" ? "below" : null;
    const threshold = Number(params.threshold);
    if (!Number.isInteger(period) || period < 2 || period > 120) errors.push("wr_threshold.period 必须是 2 到 120 之间的整数");
    if (!direction) errors.push("wr_threshold.direction 必须是 above 或 below");
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) errors.push("wr_threshold.threshold 必须是 0 到 100 之间的数");
    return { period: Number.isInteger(period) ? period : 14, direction: direction ?? "above", threshold: Number.isFinite(threshold) ? threshold : 80 };
  }
  errors.push(`不支持的规则类型：${ruleType}`);
  return {};
}

function severityFromPriority(priority: WatchRulePriority): "high" | "medium" | "low" {
  if (priority === "P0") return "high";
  if (priority === "P1") return "medium";
  return "low";
}

function priorityFromSeverity(severity?: string, _ruleType?: WatchRuleType): WatchRulePriority {
  if (severity === "high") return "P0";
  if (severity === "medium") return "P1";
  if (severity === "low") return "P2";
  // 缺省级别为中等：显式传入的 severity/notification.priority 始终优先。
  return "P1";
}

function scheduleForRule(_ruleType: WatchRuleType) {
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
  return "watch_rule.unknown";
}
