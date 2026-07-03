import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules, alerts } from "../db/schema.js";
import { marketQuote } from "../services/market-data.js";
import { ensureBuiltInIndicatorDefinitions } from "./indicator-definitions.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";

const LEGACY_TO_INDICATOR_KEY: Record<string, string> = {
  price: "price_change",
  turnover: "turnover",
  volume_ratio: "volume_ratio",
  macd: "macd",
  breakout: "breakout_with_volume",
  break_support: "break_support",
  target_price: "custom_target_price",
  support_price: "custom_support_price",
};

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function conditionFor(indicator: string) {
  switch (indicator) {
    case "price":
      return "abs(value.changePercent) >= params.value";
    case "target_price":
      return "value.price >= params.value";
    case "support_price":
      return "value.price <= params.value";
    case "macd":
      return "value.signal == params.value";
    case "break_support":
      return "value.triggered == true";
    default:
      return "value.triggered == true";
  }
}

function scheduleFor(indicator: string) {
  if (indicator === "macd" || indicator === "breakout" || indicator === "break_support") {
    return "daily_or_intraday";
  }
  return "intraday";
}

function dedupeFor(indicator: string) {
  const stateful = new Set(["target_price", "support_price", "break_support", "breakout"]);
  if (stateful.has(indicator)) return { type: "state", cooldownMinutes: 1440 };
  return { type: "cooldown", cooldownMinutes: 60, priceChangeThreshold: 0.01 };
}

function severityFor(indicator: string) {
  if (indicator === "break_support" || indicator === "support_price") return "high";
  if (indicator === "target_price") return "high";
  return "medium";
}

async function resolveStockName(userId: string, stockCode: string, fallback?: string) {
  if (fallback) return fallback;
  const quote = await marketQuote([stockCode], userId).catch(() => ({ items: [] }));
  return quote.items[0]?.name || stockCode;
}

export async function syncLegacyAlertToAlertRule(input: {
  userId?: string;
  instanceId?: string;
  stockCode: string;
  stockName?: string;
  indicator: string;
  threshold: string;
  enabled: boolean;
}) {
  await ensureBuiltInIndicatorDefinitions();
  const indicatorKey = LEGACY_TO_INDICATOR_KEY[input.indicator] ?? input.indicator;
  const userId = input.userId ?? DEFAULT_USER_ID;
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const stockName = await resolveStockName(userId, input.stockCode, input.stockName);
  const now = new Date().toISOString();
  const params = safeParse(input.threshold);

  const existing = await db
    .select()
    .from(alertRules)
    .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.stockCode, input.stockCode), eq(alertRules.indicatorKey, indicatorKey)))
    .limit(1);

  const values = {
    userId,
    instanceId,
    stockCode: input.stockCode,
    stockName,
    indicatorKey,
    condition: conditionFor(input.indicator),
    params: JSON.stringify(params),
    schedule: scheduleFor(input.indicator),
    dedupePolicy: JSON.stringify(dedupeFor(input.indicator)),
    severity: severityFor(input.indicator),
    relationToPlan: "legacy_alerts_mirror",
    enabled: input.enabled,
    updatedAt: now,
  };

  if (existing.length > 0) {
    await db.update(alertRules).set(values).where(eq(alertRules.id, existing[0].id));
  } else {
    await db.insert(alertRules).values({ ...values, createdAt: now });
  }
}

export async function disableMirroredAlertRule(userId: string, stockCode: string, indicator?: string, instanceId = DEFAULT_INSTANCE_ID) {
  if (indicator) {
    const indicatorKey = LEGACY_TO_INDICATOR_KEY[indicator] ?? indicator;
    await db
      .update(alertRules)
      .set({ enabled: false, updatedAt: new Date().toISOString() })
      .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.stockCode, stockCode), eq(alertRules.indicatorKey, indicatorKey)));
    return;
  }
  await db
    .update(alertRules)
    .set({ enabled: false, updatedAt: new Date().toISOString() })
    .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.stockCode, stockCode)));
}

export async function deleteMirroredAlertRule(userId: string, stockCode: string, indicator: string, instanceId = DEFAULT_INSTANCE_ID) {
  const indicatorKey = LEGACY_TO_INDICATOR_KEY[indicator] ?? indicator;
  await db
    .delete(alertRules)
    .where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId), eq(alertRules.stockCode, stockCode), eq(alertRules.indicatorKey, indicatorKey)));
}

export async function syncAllLegacyAlertsToAlertRules() {
  const legacy = await db.select().from(alerts);
  for (const item of legacy) {
    await syncLegacyAlertToAlertRule({
      userId: item.userId,
      instanceId: item.instanceId,
      stockCode: item.stockCode,
      indicator: item.indicator,
      threshold: item.threshold,
      enabled: item.enabled,
    });
  }
}
