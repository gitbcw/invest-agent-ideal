import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { marketDataReadCapability } from "./market-data.js";
import { getRulePrices, type RulePriceFact } from "./rule-price-facts.js";

// WP8: 8 类非价格规则已退役删除。只剩 price_cross。
export type WatchRuleType = "price_cross";
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
];

const WATCH_RULE_RELATION = "stage2_watch_rule";
const RULE_TYPE_TO_INDICATOR_KEY: Record<WatchRuleType, string> = {
  price_cross: "watch_rule_price_cross",
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

export async function dryRunWatchRule(rule: WatchRuleRecord, priceFact?: RulePriceFact | null): Promise<DryRunWatchRuleResult> {
  // WP5: price_cross 优先走窄事实接口 (脱离完整 marketDataReadCapability)。
  // flag=true 回切旧 quote 路径;priceFact===undefined (未传参) 时内部自取 (单条 dry-run)。
  // priceFact===null 表示调用方明确表示无可用 fact (如批量预取缺失),不触网。
  if (rule.ruleType === "price_cross" && process.env.WATCH_RULES_LEGACY_PRICE_QUOTE !== "true") {
    const fact = priceFact === undefined
      ? (await getRulePrices([rule.stockCode])).get(rule.stockCode) ?? null
      : priceFact;
    return evaluatePriceCrossFromFact(rule, fact);
  }

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

  // WP8: 8 类非价格规则已退役删除。price_cross 是唯一规则类型,不会到达此处。
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
  if (value === RULE_TYPE_TO_INDICATOR_KEY.price_cross || value === "price_cross") return "price_cross";
  // WP8: 8 类非价格规则已退役,反序列化时归一为 price_cross 避免 DB 残留行报错
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
  // WP8: 8 类非价格规则已退役。仅保留 price_cross 参数规范化。
  errors.push(`不支持的规则类型：${ruleType}`);
  return {};
}

function severityFromPriority(priority: WatchRulePriority): "high" | "medium" | "low" {
  if (priority === "P0") return "high";
  if (priority === "P1") return "medium";
  return "low";
}

function priorityFromSeverity(severity?: string, ruleType?: WatchRuleType): WatchRulePriority {
  // WP8: price_cross 是唯一规则类型,统一 P0
  if (ruleType === "price_cross") return "P0";
  if (severity === "high") return "P0";
  if (severity === "medium") return "P1";
  return "P2";
}

function scheduleForRule(_ruleType: WatchRuleType) {
  return "intraday";
}

function ruleTypeCondition(ruleType: WatchRuleType) {
  if (ruleType === "price_cross") return "watch_rule.price_cross";
  return "watch_rule.unknown";
}


