import { db } from "../db/index.js";
import { alertEvents, alertSignalStates, indicatorResults } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { planBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { ensureWorkspace } from "../lib/workspace.js";
import { WorkspaceStore, type RiskLevel } from "../lib/workspace-store.js";
import { beijingNow, isBeijingTradingDay } from "../lib/schedules-loader.js";
import { listWatchRules, dryRunWatchRule, type WatchRuleRecord } from "../services/watch-rules.js";
import { getRulePrices } from "../services/rule-price-facts.js";

/** 巡检结果 */
export interface AlertItem {
  stockCode: string;
  stockName: string;
  type: "price" | "volume" | "indicator";
  message: string;
  severity: "high" | "medium" | "low";
  /** WP3a 引入:更细粒度的风险分级,由 risk_taxonomy.yaml 决定。 */
  priority: RiskLevel;
  signalKey: string;
  relationToPlan: string;
  price?: number;
  dedupe: {
    mode: "cooldown" | "state";
    minutes: number;
  };
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

interface MarketWatchWindow {
  time?: string;
  name?: string;
  purpose?: string;
  enabled?: boolean;
}

interface MarketWatchPolicy {
  enabled: boolean;
  onlyPushOnException: boolean;
  defaultCheckWindows: MarketWatchWindow[];
  exceptionRules: string[];
  nonExceptionRules: string[];
}

const MARKET_WATCH_WINDOW_TOLERANCE_MINUTES = 3;

/**
 * 规则巡检执行器。
 *
 * 只执行当前 watch_rules(stage2) 明确规则；legacy alerts 兼容规则不再参与运行时巡检。
 * market-watch 盘中定时简报不是这里的语义。
 */
export async function runAlertCheck(options: { force?: boolean; userId?: string; instanceId?: string } = {}): Promise<AlertItem[]> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const watchPolicy = await loadMarketWatchPolicy(userId);
  const planMap = await loadLatestPlanMap(userId, instanceId);
  const alertItems: AlertItem[] = [];

  const stage2Rules = (await listWatchRules(userId, instanceId)).filter((rule) => rule.enabled);

  // WP5: 同一 tick 对所有 price_cross 规则批量预取价格事实一次,避免逐规则单独请求。
  const priceCrossCodes = [...new Set(
    stage2Rules.filter((rule) => rule.ruleType === "price_cross").map((rule) => rule.stockCode),
  )];
  const priceFacts = priceCrossCodes.length > 0
    ? await getRulePrices(priceCrossCodes)
    : new Map();

  for (const rule of stage2Rules) {
    try {
      const evaluated = rule.ruleType === "price_cross"
        ? await dryRunWatchRule(rule, priceFacts.get(rule.stockCode) ?? null)
        : await dryRunWatchRule(rule);
      if (!evaluated.triggered) continue;
      const item = buildStage2AlertItem(rule, evaluated, planMap);
      if (item) alertItems.push(item);
    } catch (error) {
      logger.warn(`阶段二规则执行失败 rule=${rule.id} stock=${rule.stockCode}: ${(error as Error).message}`);
    }
  }

  const deduped = await filterAndRecordAlerts(userId, instanceId, alertItems, watchPolicy);

  if (deduped.length > 0) {
    logger.info(`巡检发现 ${deduped.length} 条提醒`);
  }

  return deduped;
}

/** 格式化提醒列表为推送文本 */
export function formatAlerts(alerts: AlertItem[]): string {
  if (alerts.length === 0) return "";

  const high = alerts.filter((a) => a.severity === "high");
  const medium = alerts.filter((a) => a.severity === "medium");
  const low = alerts.filter((a) => a.severity === "low");

  const lines: string[] = ["⏰ 行情提醒\n"];

  if (high.length > 0) {
    lines.push("【重要】");
    for (const a of high) lines.push(formatAlertLine(a));
    lines.push("");
  }

  if (medium.length > 0) {
    lines.push("【关注】");
    for (const a of medium) lines.push(formatAlertLine(a));
  }

  if (low.length > 0) {
    lines.push("");
    lines.push("【观察】");
    for (const a of low) lines.push(formatAlertLine(a));
  }

  lines.push("", "—", "仅供参考，不构成投资建议");
  return lines.join("\n");
}

function formatAlertLine(alert: AlertItem): string {
  const planNote = shouldShowPlan(alert.relationToPlan)
    ? `（${alert.relationToPlan}）`
    : "";
  return `  ${alert.message}${planNote}`;
}

function shouldShowPlan(relation: string): boolean {
  if (!relation || relation === "未找到预案") return false;
  if (relation.startsWith("已找到预案，当前未触及")) return false;
  if (relation.startsWith("找到预案，但")) return false;
  return true;
}

async function loadLatestPlanMap(userId = DEFAULT_USER_ID, instanceId = DEFAULT_INSTANCE_ID): Promise<Map<string, PlanItem>> {
  const manualPlans = await planBackend.list(userId, instanceId);
  const latest = await dailyPlanBackend.getLatest(userId, instanceId);

  const map = new Map<string, PlanItem>();

  if (latest) {
    try {
      // workspace 路径 data 是对象,sqlite 路径 data 是反序列化后的对象(JSON.parse 已在 backend 内做)
      const parsed = (latest.data ?? {}) as { items?: PlanItem[] };
      for (const item of parsed.items ?? []) {
        map.set(item.code, { ...item, source: "daily_review" });
      }
    } catch (error) {
      logger.warn(`解析每日预案失败: ${(error as Error).message}`);
    }
  }

  for (const plan of manualPlans) {
    map.set(plan.code, {
      code: plan.code,
      name: plan.name,
      pool: "manual",
      support: plan.support ?? null,
      resistance: plan.resistance ?? null,
      targetPrice: plan.targetPrice ?? null,
      stopLoss: plan.stopLoss ?? null,
      observe: plan.notes ? [plan.notes] : [],
      notes: plan.notes ?? null,
      source: "manual",
    });
  }

  return map;
}

function describePlanRelation(price: number | undefined, plan: PlanItem | undefined): string {
  if (!plan) return "未找到预案";
  if (price == null) return "找到预案，但当前行情缺失";
  if (plan.stopLoss && price <= plan.stopLoss) return withPlanNote("触发预案：跌破止损位", plan);
  if (plan.targetPrice && price >= plan.targetPrice * 0.99) return withPlanNote("符合预案：接近目标位", plan);
  if (plan.support && price <= plan.support * 1.01) return "符合预案：接近支撑位";
  if (plan.resistance && price >= plan.resistance * 0.99) return "符合预案：接近压力位";
  return withPlanNote("已找到预案，当前未触及关键价位", plan);
}

function withPlanNote(text: string, plan: PlanItem): string {
  return plan.notes ? `${text}；备注：${plan.notes}` : text;
}

function buildStage2AlertItem(
  rule: WatchRuleRecord,
  evaluated: Awaited<ReturnType<typeof dryRunWatchRule>>,
  planMap: Map<string, PlanItem>
): AlertItem | null {
  const relationToPlan = describePlanRelation(
    typeof evaluated.facts.currentPrice === "number" ? evaluated.facts.currentPrice : undefined,
    planMap.get(rule.stockCode)
  );
  const priority = rule.notification.priority;
  const severity = severityFromPriority(priority);
  const dedupe = normalizeAlertDedupe(rule.cooldown);

  if (rule.ruleType === "price_cross") {
    const operator = String(rule.params.operator);
    const threshold = Number(rule.params.value);
    const currentPrice = Number(evaluated.facts.currentPrice);
    const signalKey = `${rule.stockCode}:watch-rule:price-cross:${operator}:${threshold}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "price",
      signalKey,
      relationToPlan,
      price: currentPrice,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发价格规则：现价 ${currentPrice} ${operator} ${threshold}`,
    };
  }

  if (rule.ruleType === "ma_cross") {
    const period = Number(rule.params.period);
    const direction = String(rule.params.direction);
    const closeToday = Number(evaluated.facts.closeToday);
    const maToday = Number(evaluated.facts.maToday);
    const signalKey = `${rule.stockCode}:watch-rule:ma-cross:${direction}:${period}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发均线规则：${direction === "break_above" ? "突破" : "跌破"} ${period} 日均线，现价 ${closeToday.toFixed(2)}，MA${period} ${maToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "macd_cross") {
    const direction = String(rule.params.direction);
    const closeToday = Number(evaluated.facts.closeToday);
    const difToday = Number(evaluated.facts.difToday);
    const deaToday = Number(evaluated.facts.deaToday);
    const signalKey = `${rule.stockCode}:watch-rule:macd-cross:${direction}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发 MACD 规则：${direction === "golden_cross" ? "金叉" : "死叉"}，DIF ${difToday.toFixed(3)}，DEA ${deaToday.toFixed(3)}，现价 ${closeToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "kdj_cross") {
    const direction = String(rule.params.direction);
    const closeToday = Number(evaluated.facts.closeToday);
    const kToday = Number(evaluated.facts.kToday);
    const dToday = Number(evaluated.facts.dToday);
    const jToday = Number(evaluated.facts.jToday);
    const threshold = Number(rule.params.threshold);
    const signalKey = `${rule.stockCode}:watch-rule:kdj-cross:${direction}:${threshold}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发 KDJ 规则：${direction === "golden_cross" ? "金叉" : "死叉"}，K ${kToday.toFixed(2)}，D ${dToday.toFixed(2)}，J ${jToday.toFixed(2)}，现价 ${closeToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "rsi_threshold") {
    const period = Number(rule.params.period);
    const direction = String(rule.params.direction);
    const threshold = Number(rule.params.threshold);
    const closeToday = Number(evaluated.facts.closeToday);
    const rsiToday = Number(evaluated.facts.rsiToday);
    const signalKey = `${rule.stockCode}:watch-rule:rsi-threshold:${direction}:${period}:${threshold}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发 RSI 规则：RSI${period} ${rsiToday.toFixed(2)} ${direction === "above" ? ">=" : "<="} ${threshold}，现价 ${closeToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "boll_break") {
    const direction = String(rule.params.direction);
    const period = Number(rule.params.period);
    const closeToday = Number(evaluated.facts.closeToday);
    const upper = Number(evaluated.facts.upper);
    const lower = Number(evaluated.facts.lower);
    const signalKey = `${rule.stockCode}:watch-rule:boll-break:${direction}:${period}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发布林带规则：${direction === "break_upper" ? "突破上轨" : "跌破下轨"}，现价 ${closeToday.toFixed(2)}，上轨 ${upper.toFixed(2)}，下轨 ${lower.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "wr_threshold") {
    const period = Number(rule.params.period);
    const direction = String(rule.params.direction);
    const threshold = Number(rule.params.threshold);
    const closeToday = Number(evaluated.facts.closeToday);
    const wrToday = Number(evaluated.facts.wrToday);
    const signalKey = `${rule.stockCode}:watch-rule:wr-threshold:${direction}:${period}:${threshold}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "indicator",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发 WR 规则：WR${period} ${wrToday.toFixed(2)} ${direction === "above" ? ">=" : "<="} ${threshold}，现价 ${closeToday.toFixed(2)}`,
    };
  }

  if (rule.ruleType === "volume_ratio") {
    const period = Number(rule.params.period);
    const direction = String(rule.params.direction);
    const threshold = Number(rule.params.threshold);
    const closeToday = Number(evaluated.facts.closeToday);
    const ratio = Number(evaluated.facts.ratio);
    const signalKey = `${rule.stockCode}:watch-rule:volume-ratio:${direction}:${period}:${threshold}`;
    return {
      stockCode: rule.stockCode,
      stockName: rule.stockName,
      type: "volume",
      signalKey,
      relationToPlan,
      price: closeToday,
      priority,
      severity,
      dedupe,
      message: `${rule.stockName}(${rule.stockCode}) 触发成交量规则：成交量为 ${period} 日均量的 ${ratio.toFixed(2)} 倍，阈值 ${direction === "above" ? ">=" : "<="} ${threshold}，现价 ${closeToday.toFixed(2)}`,
    };
  }

  const levelType = String(rule.params.levelType);
  const levelValue = Number(evaluated.facts.levelValue);
  const currentPrice = Number(evaluated.facts.currentPrice);
  const tolerancePercent = Number(rule.params.tolerancePercent ?? 1);
  const signalKey = `${rule.stockCode}:watch-rule:near-plan-level:${levelType}`;
  const levelLabel = levelType === "support"
    ? "支撑位"
    : levelType === "resistance"
      ? "压力位"
      : levelType === "target"
        ? "目标位"
        : "止损位";
  return {
    stockCode: rule.stockCode,
    stockName: rule.stockName,
    type: "indicator",
    signalKey,
    relationToPlan,
    price: currentPrice,
    priority,
    severity,
    dedupe,
    message: `${rule.stockName}(${rule.stockCode}) 接近预案${levelLabel} ${levelValue}，现价 ${currentPrice}，容差 ${tolerancePercent}%`,
  };
}

const MAX_DAILY_PER_STOCK = 8;
export async function filterAndRecordAlerts(
  userId: string,
  instanceId: string,
  items: AlertItem[],
  watchPolicy: MarketWatchPolicy
): Promise<AlertItem[]> {
  const now = new Date();
  const createdAt = now.toISOString();
  const eventDate = createdAt.slice(0, 10);
  const stockCodes = [...new Set(items.map((item) => item.stockCode))];
  const triggeredKeys = new Set(items.map((item) => item.signalKey));
  await releaseInactiveSignalStates(userId, instanceId, stockCodes, triggeredKeys, now);
  if (items.length === 0) return [];

  const dailyCounts = new Map<string, number>();
  if (stockCodes.length > 0) {
    const dailyRows = await db
      .select({ stockCode: alertEvents.stockCode })
      .from(alertEvents)
      .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), inArray(alertEvents.stockCode, stockCodes), eq(alertEvents.eventDate, eventDate)));
    for (const row of dailyRows) {
      dailyCounts.set(row.stockCode, (dailyCounts.get(row.stockCode) ?? 0) + 1);
    }
  }

  const result: AlertItem[] = [];

  for (const item of items) {
    if ((dailyCounts.get(item.stockCode) ?? 0) >= MAX_DAILY_PER_STOCK) continue;

    if (usesStateDedupe(item)) {
      const active = await db
        .select()
        .from(alertSignalStates)
        .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, item.signalKey), eq(alertSignalStates.active, true)))
        .limit(1);

      if (active.length > 0) {
        await db
          .update(alertSignalStates)
          .set({
            stockName: item.stockName,
            lastPrice: item.price,
            updatedAt: createdAt,
          })
          .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, item.signalKey)));
        continue;
      }

    }

    if (item.dedupe.mode === "cooldown") {
      const cooldownSince = new Date(now.getTime() - item.dedupe.minutes * 60 * 1000).toISOString();
      const recent = await db
        .select({ id: alertEvents.id })
        .from(alertEvents)
        .where(and(
          eq(alertEvents.userId, userId),
          eq(alertEvents.instanceId, instanceId),
          eq(alertEvents.signalKey, item.signalKey),
          gte(alertEvents.createdAt, cooldownSince),
        ))
        .orderBy(desc(alertEvents.createdAt))
        .limit(1);

      if (recent.length > 0) continue;
    }

    await db.insert(alertEvents).values({
      userId,
      instanceId,
      stockCode: item.stockCode,
      stockName: item.stockName,
      eventDate,
      eventType: item.type,
      signalKey: item.signalKey,
      message: item.message,
      relationToPlan: item.relationToPlan,
      severity: item.severity,
      price: item.price,
      status: "pending",
      createdAt,
    });
    await recordIndicatorResultSnapshot(userId, instanceId, item, createdAt);
    if (usesStateDedupe(item)) {
      await upsertActiveSignalState(userId, instanceId, item, createdAt);
    }
    dailyCounts.set(item.stockCode, (dailyCounts.get(item.stockCode) ?? 0) + 1);
    if (shouldPushAlert(item, watchPolicy)) {
      result.push(item);
    }
  }

  return result;
}

async function recordIndicatorResultSnapshot(userId: string, instanceId: string, item: AlertItem, nowIso: string) {
  const indicatorKey = indicatorKeyFromSignal(item.signalKey);
  await db.insert(indicatorResults).values({
    userId,
    instanceId,
    indicatorKey,
    stockCode: item.stockCode,
    stockName: item.stockName,
    timeframe: timeframeFromIndicator(indicatorKey),
    calculatedAt: nowIso,
    dataTime: nowIso,
    value: JSON.stringify({
      triggered: true,
      signalKey: item.signalKey,
      type: item.type,
      price: item.price ?? null,
      severity: item.severity,
    }),
    level: item.severity,
    confidence: confidenceFromIndicator(indicatorKey),
    explanation: item.message,
    sourceSnapshot: JSON.stringify({
      relationToPlan: item.relationToPlan,
      price: item.price ?? null,
      source: "watch_rule_check",
    }),
    missingData: JSON.stringify(missingDataForIndicator(indicatorKey)),
  });
}

function indicatorKeyFromSignal(signalKey: string) {
  const suffix = signalKey.split(":").slice(1).join(":");
  if (suffix.startsWith("price:")) return "price_change";
  if (suffix === "near-support") return "near_support";
  if (suffix === "near-resistance") return "near_resistance";
  if (suffix === "near-target") return "near_target";
  if (suffix === "stop-loss") return "stop_loss";
  if (suffix.startsWith("target-price")) return "custom_target_price";
  if (suffix.startsWith("support-price")) return "custom_support_price";
  if (suffix === "breakout-with-volume") return "breakout_with_volume";
  if (suffix === "break-support") return "break_support";
  if (suffix === "capital-flow-main") return "capital_flow_main";
  if (suffix === "capital-flow-super-large") return "capital_flow_super_large";
  if (suffix.startsWith("vol-price-div")) return "volume_price_divergence";
  if (suffix.startsWith("ma-breakout-above")) return "ma_breakout_above";
  if (suffix.startsWith("ma-breakout-below")) return "ma_breakout_below";
  if (suffix === "macd-golden-cross") return "macd_golden_cross";
  if (suffix === "macd-death-cross") return "macd_death_cross";
  if (suffix.startsWith("kdj-oversold")) return "kdj_oversold";
  if (suffix.startsWith("kdj-overbought")) return "kdj_overbought";
  if (suffix.startsWith("watch-rule:price-cross")) return "watch_rule_price_cross";
  if (suffix.startsWith("watch-rule:ma-cross")) return "watch_rule_ma_cross";
  if (suffix.startsWith("watch-rule:macd-cross")) return "watch_rule_macd_cross";
  if (suffix.startsWith("watch-rule:kdj-cross")) return "watch_rule_kdj_cross";
  if (suffix.startsWith("watch-rule:rsi-threshold")) return "watch_rule_rsi_threshold";
  if (suffix.startsWith("watch-rule:boll-break")) return "watch_rule_boll_break";
  if (suffix.startsWith("watch-rule:wr-threshold")) return "watch_rule_wr_threshold";
  if (suffix.startsWith("watch-rule:volume-ratio")) return "watch_rule_volume_ratio";
  if (suffix.startsWith("watch-rule:near-plan-level")) return "watch_rule_near_plan_level";
  if (suffix.startsWith("composite:")) return `composite_${suffix.split(":")[1] ?? "unknown"}`;
  if (suffix.startsWith("script:")) return `script_${suffix.split(":")[1] ?? "unknown"}`;
  return suffix || "unknown";
}

function timeframeFromIndicator(indicatorKey: string) {
  if (indicatorKey === "volume_price_divergence") return "1m";
  if (
    indicatorKey === "macd" ||
    indicatorKey === "breakout_with_volume" ||
    indicatorKey.startsWith("watch_rule_ma") ||
    indicatorKey.startsWith("watch_rule_macd") ||
    indicatorKey.startsWith("watch_rule_kdj") ||
    indicatorKey.startsWith("watch_rule_rsi") ||
    indicatorKey.startsWith("watch_rule_boll") ||
    indicatorKey.startsWith("watch_rule_wr") ||
    indicatorKey.startsWith("watch_rule_volume")
  ) return "daily";
  return "realtime";
}

function confidenceFromIndicator(indicatorKey: string) {
  if (indicatorKey.startsWith("capital_flow")) return "low";
  if (indicatorKey === "volume_price_divergence") return "medium";
  return "medium";
}

function missingDataForIndicator(indicatorKey: string) {
  if (indicatorKey.startsWith("capital_flow")) {
    return ["资金流不是主力控盘或建仓结论"];
  }
  if (indicatorKey === "volume_price_divergence") {
    return ["未接入逐笔成交和盘口队列"];
  }
  return [];
}

async function upsertActiveSignalState(userId: string, instanceId: string, item: AlertItem, nowIso: string) {
  await db.insert(alertSignalStates).values({
    userId,
    instanceId,
    signalKey: item.signalKey,
    stockCode: item.stockCode,
    stockName: item.stockName,
    active: true,
    lastPrice: item.price,
    activatedAt: nowIso,
    updatedAt: nowIso,
  }).onConflictDoUpdate({
    target: [alertSignalStates.userId, alertSignalStates.instanceId, alertSignalStates.signalKey],
    set: {
      stockCode: item.stockCode,
      stockName: item.stockName,
      active: true,
      lastPrice: item.price,
      updatedAt: nowIso,
    },
  });
}

async function releaseInactiveSignalStates(
  userId: string,
  instanceId: string,
  stockCodes: string[],
  triggeredKeys: Set<string>,
  now: Date
) {
  if (stockCodes.length === 0) return;
  const activeRows = await db
    .select()
    .from(alertSignalStates)
    .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), inArray(alertSignalStates.stockCode, stockCodes), eq(alertSignalStates.active, true)));

  const updatedAt = now.toISOString();
  for (const row of activeRows) {
    if (triggeredKeys.has(row.signalKey)) continue;
    await db
      .update(alertSignalStates)
      .set({ active: false, updatedAt })
      .where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceId), eq(alertSignalStates.signalKey, row.signalKey)));
  }
}

function usesStateDedupe(item: AlertItem) {
  return item.dedupe.mode === "state";
}

export function normalizeAlertDedupe(value: Record<string, unknown>): AlertItem["dedupe"] {
  const minutes = Number(value.minutes ?? value.cooldownMinutes ?? 240);
  return {
    mode: value.mode === "state" ? "state" : "cooldown",
    minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 240,
  };
}

async function loadMarketWatchPolicy(userId: string): Promise<MarketWatchPolicy> {
  const fallback: MarketWatchPolicy = {
    enabled: true,
    onlyPushOnException: true,
    defaultCheckWindows: [],
    exceptionRules: [],
    nonExceptionRules: [],
  };
  try {
    const store = new WorkspaceStore(userId);
    const watch = await store.readWatch();
    if (!watch) return fallback;
    return {
      enabled: watch.mode !== "disabled" && watch.mode !== "off",
      onlyPushOnException: watch.only_push_on_exception !== false,
      defaultCheckWindows: normalizeWatchWindows(watch.default_check_windows),
      exceptionRules: normalizeWatchRules(watch.exception_rules),
      nonExceptionRules: normalizeWatchRules(watch.non_exception_rules),
    };
  } catch (error) {
    logger.warn(`读取 watch.yaml 失败 user=${userId}: ${(error as Error).message}`);
    return fallback;
  }
}

function normalizeWatchWindows(value: unknown): MarketWatchWindow[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return { time: item.trim() } as MarketWatchWindow;
      if (!item || typeof item !== "object") return null;
      const raw = item as Record<string, unknown>;
      const time = typeof raw.time === "string" ? raw.time.trim() : "";
      if (!time) return null;
      return {
        time,
        name: typeof raw.name === "string" ? raw.name.trim() : undefined,
        purpose: typeof raw.purpose === "string" ? raw.purpose.trim() : undefined,
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
      } satisfies MarketWatchWindow;
    })
    .filter((item): item is MarketWatchWindow => Boolean(item));
}

function normalizeWatchRules(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function shouldRunMarketWatchNow(policy: MarketWatchPolicy, now = new Date()): boolean {
  if (!policy.enabled) return false;
  const bj = beijingNow(now);
  if (!isBeijingTradingDay(now)) return false;

  const windows = policy.defaultCheckWindows.filter((window) => window.enabled !== false);
  if (windows.length === 0) {
    const timeNum = bj.getHours() * 100 + bj.getMinutes();
    return (timeNum >= 920 && timeNum <= 1130) || (timeNum >= 1300 && timeNum <= 1500);
  }

  return windows.some((window) => isWithinWindow(window.time, bj, MARKET_WATCH_WINDOW_TOLERANCE_MINUTES));
}

function isWithinWindow(timeText: string | undefined, bj: Date, toleranceMinutes: number): boolean {
  if (!timeText) return false;
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeText.trim());
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const target = new Date(bj);
  target.setHours(hour, minute, 0, 0);
  const diffMinutes = Math.abs((bj.getTime() - target.getTime()) / 60000);
  return diffMinutes <= toleranceMinutes;
}

function shouldPushAlert(alert: AlertItem, policy: MarketWatchPolicy): boolean {
  if (!policy.onlyPushOnException) return true;
  // Low-disturbance and evening-summary preferences do not generate intraday
  // pushes. Risk levels and legacy exception lists cannot override them.
  return false;
}

// ============ 信号优先级解析(WP3a 2026-06-21) ============
//
// 设计要点:
//   - signalKey 形如 "<code>:<suffix>" 或 "<code>:<suffix>:<param>",优先级由 suffix 决定
//   - suffix 可能是单段(stop-loss)、双段(price:up)、或带参数前缀(target-price:12.5)
//   - 查表顺序:精确 suffix → 前缀(去掉末段冒号后) → 默认值
//   - 价格异动达到 escalation 阈值时,suffix 自动加 ":extreme"
//   - yaml 不可用时走 HARDWIRED_PRIORITY_MAP 硬编码默认值,保持现有行为

const HARDWIRED_PRIORITY_MAP: Record<string, RiskLevel> = {
  "stop-loss": "P0",
  "break-support": "P0",
  "breakout-with-volume": "P0",
  "target-price": "P0",
  "support-price": "P0",
  "price:up:extreme": "P0",
  "price:down:extreme": "P0",
  "near-support": "P1",
  "near-resistance": "P1",
  "near-target": "P1",
  "capital-flow-main": "P1",
  "capital-flow-super-large": "P1",
  "vol-price-div": "P1",
  "price:up": "P1",
  "price:down": "P1",
  "ma-breakout-above": "P1",
  "ma-breakout-below": "P1",
  "macd-golden-cross": "P1",
  "macd-death-cross": "P1",
  "kdj-oversold": "P2",
  "kdj-overbought": "P2",
  "watch-rule:macd-cross": "P1",
  "watch-rule:kdj-cross": "P2",
  "watch-rule:rsi-threshold": "P2",
  "watch-rule:boll-break": "P1",
  "watch-rule:wr-threshold": "P2",
  "watch-rule:volume-ratio": "P1",
  "composite": "P1",
  "script": "P2",
};

const HARDWIRED_ESCALATION_THRESHOLD = 5;
const PRIORITY_TO_SEVERITY: Record<RiskLevel, "high" | "medium" | "low"> = {
  P0: "high",
  P1: "medium",
  P2: "low",
};

interface PriorityConfig {
  overrides: Record<string, RiskLevel>;
  defaultPriority: RiskLevel;
  escalationThreshold: number;
}

let cachedPriorityConfig: PriorityConfig | null = null;
let priorityWorkspaceInitialized = false;

async function loadPriorityConfig(): Promise<PriorityConfig> {
  if (cachedPriorityConfig) return cachedPriorityConfig;

  if (process.env.USE_YAML_CONFIG !== "true") {
    cachedPriorityConfig = {
      overrides: HARDWIRED_PRIORITY_MAP,
      defaultPriority: "P2",
      escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
    };
    return cachedPriorityConfig;
  }

  try {
    if (!priorityWorkspaceInitialized) {
      await ensureWorkspace({ userId: DEFAULT_USER_ID });
      priorityWorkspaceInitialized = true;
    }
    const store = new WorkspaceStore(DEFAULT_USER_ID);
    const yaml = await store.readRiskTaxonomy();
    const sp = yaml?.signal_priority;
    if (!sp) {
      logger.warn("USE_YAML_CONFIG=true 但 risk_taxonomy.yaml 缺 signal_priority,使用硬编码默认值");
      cachedPriorityConfig = {
        overrides: HARDWIRED_PRIORITY_MAP,
        defaultPriority: "P2",
        escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
      };
      return cachedPriorityConfig;
    }
    cachedPriorityConfig = {
      overrides: sp.overrides ?? {},
      defaultPriority: sp.default ?? "P2",
      escalationThreshold:
        typeof sp.price_escalation_threshold_percent === "number"
          ? sp.price_escalation_threshold_percent
          : HARDWIRED_ESCALATION_THRESHOLD,
    };
    logger.info(
      `signal_priority 配置从 yaml 加载: overrides<${Object.keys(cachedPriorityConfig.overrides).length}> default<${cachedPriorityConfig.defaultPriority}> escalation<${cachedPriorityConfig.escalationThreshold}%>`
    );
    return cachedPriorityConfig;
  } catch (error) {
    logger.warn(`signal_priority 配置读取失败,使用默认值: ${(error as Error).message}`);
    cachedPriorityConfig = {
      overrides: HARDWIRED_PRIORITY_MAP,
      defaultPriority: "P2",
      escalationThreshold: HARDWIRED_ESCALATION_THRESHOLD,
    };
    return cachedPriorityConfig;
  }
}

/**
 * 从 signalKey 解析出用于查表的 suffix。
 * 例如 "600519:price:up" → "price:up","600519:target-price:12.5" → "target-price:12.5"。
 */
function suffixFromSignalKey(signalKey: string): string {
  const idx = signalKey.indexOf(":");
  return idx >= 0 ? signalKey.slice(idx + 1) : signalKey;
}

/**
 * 查 overrides 表,支持精确匹配 + 前缀匹配(去掉末段冒号后)。
 */
function lookupPriority(
  suffix: string,
  cfg: PriorityConfig
): RiskLevel {
  if (cfg.overrides[suffix]) return cfg.overrides[suffix];
  const lastColon = suffix.lastIndexOf(":");
  if (lastColon > 0) {
    const prefix = suffix.slice(0, lastColon);
    if (cfg.overrides[prefix]) return cfg.overrides[prefix];
  }
  return cfg.defaultPriority;
}

/**
 * 同步计算一条信号的 priority。调用方需先 await loadPriorityConfig() 拿到 cfg。
 * absChangePercent 仅对 price:up / price:down 有效,达到阈值时升级到 :extreme。
 */
function resolvePrioritySync(
  signalKey: string,
  cfg: PriorityConfig,
  absChangePercent?: number
): RiskLevel {
  let suffix = suffixFromSignalKey(signalKey);
  if (
    absChangePercent !== undefined &&
    (suffix === "price:up" || suffix === "price:down") &&
    absChangePercent >= cfg.escalationThreshold
  ) {
    suffix = `${suffix}:extreme`;
  }
  return lookupPriority(suffix, cfg);
}

/** priority 反推 severity,兼容数据库列。 */
function severityFromPriority(p: RiskLevel): "high" | "medium" | "low" {
  return PRIORITY_TO_SEVERITY[p];
}
