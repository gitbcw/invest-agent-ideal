import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules } from "../db/schema.js";
import { marketDataReadCapability } from "../services/market-data.js";
import { getIndicatorDefinition } from "./indicator-definitions.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { planBackend } from "../lib/data-backend.js";

export interface PlanWatchConditionInput {
  label: string;
  indicatorKey: string;
  condition?: string;
  params?: Record<string, unknown>;
  actionHint?: string;
  severity?: "low" | "medium" | "high";
  schedule?: "intraday" | "after_close" | "daily_or_intraday";
  dedupePolicy?: Record<string, unknown>;
  createAlertRule?: boolean;
}

export interface SetPlanWatchConditionsInput {
  userId?: string;
  instanceId?: string;
  stockCode: string;
  stockName?: string;
  conditions: PlanWatchConditionInput[];
}

type NormalizedPlanWatchCondition = {
  label: string;
  indicatorKey: string;
  condition: string;
  params: Record<string, unknown>;
  actionHint: string;
  severity: "low" | "medium" | "high";
  schedule: "intraday" | "after_close" | "daily_or_intraday";
  dedupePolicy: Record<string, unknown>;
  createAlertRule: boolean;
};

function defaultCondition(indicatorKey: string) {
  if (indicatorKey === "price_change") return "abs(value.changePercent) >= params.threshold";
  if (indicatorKey === "custom_target_price") return "value.price >= params.value";
  if (indicatorKey === "custom_support_price") return "value.price <= params.value";
  if (indicatorKey === "macd") return "value.signal == params.value";
  return "value.triggered == true";
}

function defaultSchedule(indicatorKey: string): "intraday" | "after_close" | "daily_or_intraday" {
  if (indicatorKey === "macd" || indicatorKey === "main_force_control_proxy") return "after_close";
  if (indicatorKey === "breakout_with_volume" || indicatorKey === "break_support") return "daily_or_intraday";
  return "intraday";
}

function defaultDedupe(indicatorKey: string) {
  const stateful = new Set([
    "near_support",
    "near_resistance",
    "near_target",
    "stop_loss",
    "break_support",
    "breakout_with_volume",
    "custom_target_price",
    "custom_support_price",
  ]);
  if (stateful.has(indicatorKey)) return { type: "state", cooldownMinutes: 1440 };
  return { type: "cooldown", cooldownMinutes: 60, priceChangeThreshold: 0.01 };
}

async function resolveStockName(userId: string, instanceId: string, stockCode: string, stockName?: string) {
  if (stockName) return stockName;
  const existing = await planBackend.find(userId, instanceId, stockCode);
  if (existing?.name) return existing.name;
  const quote = await marketDataReadCapability.quote([stockCode], userId).catch(() => ({ items: [] }));
  return quote.items[0]?.name || stockCode;
}

async function normalizeConditions(conditions: PlanWatchConditionInput[]) {
  const normalized: NormalizedPlanWatchCondition[] = [];
  for (const condition of conditions) {
    const indicator = await getIndicatorDefinition(condition.indicatorKey);
    if (!indicator) {
      throw new Error(`指标不存在: ${condition.indicatorKey}`);
    }
    normalized.push({
      label: condition.label || indicator.name,
      indicatorKey: condition.indicatorKey,
      condition: condition.condition || defaultCondition(condition.indicatorKey),
      params: condition.params ?? {},
      actionHint: condition.actionHint || "",
      severity: condition.severity || "medium",
      schedule: condition.schedule || defaultSchedule(condition.indicatorKey),
      dedupePolicy: condition.dedupePolicy || defaultDedupe(condition.indicatorKey),
      createAlertRule: condition.createAlertRule ?? false,
    });
  }
  return normalized;
}

export async function setPlanWatchConditions(input: SetPlanWatchConditionsInput) {
  const userId = input.userId || DEFAULT_USER_ID;
  const instanceId = input.instanceId || DEFAULT_INSTANCE_ID;
  const stockCode = input.stockCode;
  if (!stockCode) throw new Error("缺少股票代码");
  const stockName = await resolveStockName(userId, instanceId, stockCode, input.stockName);
  const conditions = await normalizeConditions(input.conditions ?? []);
  const now = new Date().toISOString();

  const existing = await planBackend.find(userId, instanceId, stockCode);
  const linkedRuleIds: string[] = [];

  for (const condition of conditions) {
    if (!condition.createAlertRule) continue;
    const existingRule = await db
      .select()
      .from(alertRules)
      .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.stockCode, stockCode)))
      .then((rows) => rows.find((row) => row.indicatorKey === condition.indicatorKey && row.relationToPlan === "stock_plan_watch_condition"));

    const values = {
      userId,
      instanceId,
      stockCode,
      stockName,
      indicatorKey: condition.indicatorKey,
      condition: condition.condition,
      params: JSON.stringify(condition.params),
      schedule: condition.schedule,
      dedupePolicy: JSON.stringify(condition.dedupePolicy),
      severity: condition.severity,
      relationToPlan: "stock_plan_watch_condition",
      enabled: true,
      updatedAt: now,
    };

    if (existingRule) {
      await db.update(alertRules).set(values).where(eq(alertRules.id, existingRule.id));
      linkedRuleIds.push(String(existingRule.id));
    } else {
      const inserted = await db.insert(alertRules).values({ ...values, createdAt: now }).returning({ id: alertRules.id });
      if (inserted[0]?.id) linkedRuleIds.push(String(inserted[0].id));
    }
  }

  await planBackend.upsert(userId, instanceId, {
    code: stockCode,
    name: stockName,
    support: existing?.support ?? null,
    resistance: existing?.resistance ?? null,
    targetPrice: existing?.targetPrice ?? null,
    stopLoss: existing?.stopLoss ?? null,
    notes: existing?.notes ?? null,
    watchConditions: conditions,
    linkedAlertRuleIds: linkedRuleIds,
    planType: "structured",
  });

  return {
    stockCode,
    stockName,
    conditionCount: conditions.length,
    linkedAlertRuleIds: linkedRuleIds,
    conditions,
  };
}
