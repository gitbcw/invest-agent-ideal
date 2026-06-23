import { db } from "../db/index.js";
import { alertEvents, alerts } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import type { StockRef } from "../types/stocks.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { getQuote } from "../services/stock.js";
import { disableMirroredAlertRule, syncLegacyAlertToAlertRule } from "./alert-rules.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { portfolioBackend, watchlistBackend, planBackend } from "../lib/data-backend.js";

const indicatorMap: Record<string, string> = {
  涨跌幅: "price",
  换手率: "turnover",
  量比: "volume_ratio",
  MACD: "macd",
  放量突破: "breakout",
  跌破支撑: "break_support",
  目标价: "target_price",
  支撑价: "support_price",
};

const indicatorNames: Record<string, string> = {
  price: "涨跌幅",
  turnover: "换手率",
  volume_ratio: "量比",
  macd: "MACD",
  breakout: "放量突破",
  break_support: "跌破支撑",
  target_price: "目标价",
  support_price: "支撑价",
  ma_breakout_above: "突破均线",
  ma_breakout_below: "跌破均线",
  macd_golden_cross: "MACD 金叉",
  macd_death_cross: "MACD 死叉",
  kdj_oversold: "KDJ 超卖反弹",
  kdj_overbought: "KDJ 超买回落",
};

/** Deterministic service tool interface */
export interface AlertToolInput {
  operation: "query" | "set" | "remove";
  stocks?: StockRef[];
  indicator?: string;
  threshold?: number | string;
}

export async function handleAlertTool(input: AlertToolInput, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  switch (input.operation) {
    case "set":
      return setAlertTool(ctx.userId, instanceId, input);
    case "remove":
      return removeAlertTool(ctx.userId, instanceId, input);
    case "query":
    default:
      return queryAlerts(ctx.userId, instanceId);
  }
}

async function setAlertTool(userId: string, instanceId: string, input: AlertToolInput): Promise<string> {
  const refs = input.stocks ?? [];
  if (refs.length === 0) return "请指定要设置提醒的股票。";

  const { codes, unresolved } = await resolveStockRefs(refs);
  if (codes.length === 0) {
    return `未能识别到有效股票${unresolved.length ? `：${unresolved.join("、")}` : ""}`;
  }

  const indicator = input.indicator || "price";
  const threshold = input.threshold;

  if ((indicator === "target_price" || indicator === "support_price") && (!threshold || Number(threshold) <= 0)) {
    return `${indicator === "target_price" ? "目标价" : "支撑价"}提醒需要指定具体价格。\n例如：帮宁德时代设置目标价提醒，涨到420提醒我`;
  }

  const results: string[] = [];
  for (const code of codes) {
    const existing = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code), eq(alerts.indicator, indicator)))
      .limit(1);

    const values = {
      userId,
      instanceId,
      stockCode: code,
      indicator,
      threshold: JSON.stringify({ value: threshold ?? defaultThreshold(indicator) }),
      enabled: true,
    };

    if (existing.length > 0) {
      await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
    } else {
      await db.insert(alerts).values(values);
    }
    await syncLegacyAlertToAlertRule(values);

    const displayThreshold = threshold ?? defaultThreshold(indicator);
    const displayName = indicatorNames[indicator] || indicator;
    results.push(`${code} ${displayName} ${displayThreshold}`);
    logger.info(`设置提醒(tool): ${code} ${displayName} ${displayThreshold}`);
  }

  const prefix = codes.length > 0 ? "已设置提醒" : "已更新提醒";
  const extra = unresolved.length > 0 ? `\n未识别: ${unresolved.join("、")}` : "";
  return `${prefix}：\n${results.map((r) => `- ${r}`).join("\n")}${extra}`;
}

async function removeAlertTool(userId: string, instanceId: string, input: AlertToolInput): Promise<string> {
  const refs = input.stocks ?? [];
  if (refs.length === 0) return "请指定要移除提醒的股票。";

  const { codes, unresolved } = await resolveStockRefs(refs);
  if (codes.length === 0) {
    return `未能识别到有效股票${unresolved.length ? `：${unresolved.join("、")}` : ""}`;
  }

  const indicator = input.indicator;
  const results: string[] = [];

  for (const code of codes) {
    if (indicator) {
      await db
        .update(alerts)
        .set({ enabled: false })
        .where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code), eq(alerts.indicator, indicator)));
      await disableMirroredAlertRule(userId, code, indicator, instanceId);
      results.push(`${code} ${indicatorNames[indicator] || indicator}`);
    } else {
      await db.update(alerts).set({ enabled: false }).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code)));
      await disableMirroredAlertRule(userId, code, undefined, instanceId);
      results.push(`${code} 全部提醒`);
    }
  }

  const extra = unresolved.length > 0 ? `\n未识别: ${unresolved.join("、")}` : "";
  return `已关闭提醒：\n${results.map((r) => `- ${r}`).join("\n")}${extra}`;
}

async function queryAlerts(userId: string, instanceId: string): Promise<string> {
  const items = await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId)));

  if (items.length === 0) {
    return "当前没有提醒规则。\n你可以直接说“赛轮轮胎涨到 13.4 提醒我”这类条件，我会先给草案，确认后再写入。";
  }

  const enabled = items.filter((i) => i.enabled);
  const disabled = items.filter((i) => !i.enabled);
  const nameMap = await buildStockNameMap(userId, instanceId, items.map((item) => item.stockCode));

  const lines: string[] = [];
  if (enabled.length > 0) {
    lines.push(`已开启的提醒共 ${enabled.length} 条：`);
    for (const item of enabled) {
      lines.push(`- ${formatStockLabel(item.stockCode, nameMap)}，${formatAlertCondition(item.indicator, item.threshold)}`);
    }
  }

  if (disabled.length > 0) {
    if (lines.length) lines.push("");
    lines.push(`已关闭的提醒 ${disabled.length} 条：`);
    for (const item of disabled) {
      lines.push(`- ${formatStockLabel(item.stockCode, nameMap)}，${formatAlertCondition(item.indicator, item.threshold)}`);
    }
  }

  return lines.join("\n");
}

async function buildStockNameMap(userId: string, instanceId: string, codes: string[]) {
  const [positions, watchItems, plans] = await Promise.all([
    portfolioBackend.listAll(userId, instanceId),
    watchlistBackend.list(userId, instanceId),
    planBackend.list(userId, instanceId),
  ]);
  const map = new Map<string, string>();
  for (const item of [...positions, ...watchItems, ...plans]) {
    if (item.code && item.name) map.set(item.code, item.name);
  }
  const missingCodes = Array.from(new Set(codes.filter((code) => !map.has(code))));
  if (missingCodes.length > 0) {
    const quotes = await getQuote(missingCodes);
    for (const quote of quotes) {
      if (quote.code && quote.name) map.set(quote.code, quote.name);
    }
  }
  return map;
}

function formatStockLabel(code: string, names: Map<string, string>) {
  const name = names.get(code);
  return name ? `${name}(${code})` : code;
}

function formatAlertCondition(indicator: string, threshold: string) {
  // 先尝试解 threshold JSON,价位类取 value,技术类按字段取
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(threshold) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const numOr = (key: string, fallback: number): number => {
    const v = parsed[key];
    return typeof v === "number" && v > 0 ? v : fallback;
  };
  const valueNum = typeof parsed.value === "number" ? (parsed.value as number) : Number(parsed.value);

  if (indicator === "price") return `涨跌幅达到 ${Number.isFinite(valueNum) ? valueNum : threshold}%`;
  if (indicator === "target_price") return `股价达到或高于 ${Number.isFinite(valueNum) ? valueNum : threshold}`;
  if (indicator === "support_price") return `股价低于或到达 ${Number.isFinite(valueNum) ? valueNum : threshold}`;

  if (indicator === "ma_breakout_above") return `突破 ${numOr("period", 20)} 日均线`;
  if (indicator === "ma_breakout_below") return `跌破 ${numOr("period", 20)} 日均线`;
  if (indicator === "macd_golden_cross") return "MACD 金叉";
  if (indicator === "macd_death_cross") return "MACD 死叉";
  if (indicator === "kdj_oversold") return `KDJ 超卖反弹(D < ${numOr("threshold", 20)})`;
  if (indicator === "kdj_overbought") return `KDJ 超买回落(D > ${numOr("threshold", 80)})`;

  return `${indicatorNames[indicator] || indicator} 触发值 ${threshold}`;
}

function defaultThreshold(indicator: string): string | number {
  const defaults: Record<string, string | number> = {
    price: 3,
    turnover: 5,
    volume_ratio: 2,
    macd: "cross",
    breakout: 1.5,
    break_support: "on",
    target_price: 0,
    support_price: 0,
  };
  return defaults[indicator] ?? 3;
}

// ---- 旧接口（保留兼容） ----

/** 解析提醒操作 */
function parseAction(
  message: string
): { action: string; code?: string; indicator?: string; threshold?: string; feedback?: string } {
  const feedback = parseFeedback(message);
  if (feedback) {
    return { action: "feedback", code: message.match(/(\d{6})/)?.[1], feedback };
  }

  const setMatch = message.match(
    /(?:设置提醒|添加提醒|提醒设置)\s*(\d{6})\s*(涨跌幅|换手率|量比|MACD|放量突破|跌破支撑)\s*([\d.]+)?/
  );
  if (setMatch) {
    return {
      action: "set",
      code: setMatch[1],
      indicator: setMatch[2],
      threshold: setMatch[3],
    };
  }

  const offMatch = message.match(/(?:关闭提醒|取消提醒)\s*(\d{6})(?:\s*(涨跌幅|换手率|量比|MACD|放量突破|跌破支撑))?/);
  if (offMatch) return { action: "off", code: offMatch[1], indicator: offMatch[2] };

  if (message.includes("提醒") && (message.includes("列表") || message.includes("查看"))) {
    return { action: "list" };
  }

  return { action: "list" };
}

export async function handleAlert(message: string, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const { action, code, indicator, threshold, feedback } = parseAction(message);
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;

  switch (action) {
    case "set":
      return setAlert(ctx.userId, instanceId, code!, indicator!, threshold);
    case "off":
      return offAlert(ctx.userId, instanceId, code!, indicator);
    case "feedback":
      return markAlertFeedback(ctx.userId, instanceId, code, feedback!);
    case "list":
    default:
      return listAlerts(ctx.userId, instanceId);
  }
}

function parseFeedback(message: string): string | null {
  if (/提醒.*(有用|有效|准确|命中)|有用|有效|准确/.test(message)) return "有用";
  if (/提醒.*(无用|没用|不用)|无用|没用/.test(message)) return "无用";
  if (/误报|错报|不准|错误/.test(message)) return "误报";
  if (/待验证|观察/.test(message)) return "待验证";
  return null;
}

async function setAlert(userId: string, instanceId: string, code: string, indicator: string, threshold?: string): Promise<string> {
  const type = indicatorMap[indicator] || "price";
  const defaultThresholds: Record<string, string> = {
    price: "3",
    turnover: "5",
    volume_ratio: "2",
    macd: "cross",
    breakout: "1.5",
    break_support: "on",
  };

  const thresholdValue = threshold || defaultThresholds[type];
  const existing = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code), eq(alerts.indicator, type)))
    .limit(1);

  const values = {
    userId,
    instanceId,
    stockCode: code,
    indicator: type,
    threshold: JSON.stringify({ value: thresholdValue }),
    enabled: true,
  };

  if (existing.length > 0) {
    await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
  } else {
    await db.insert(alerts).values(values);
  }
  await syncLegacyAlertToAlertRule(values);

  logger.info(`设置提醒: ${code} ${indicator} ${thresholdValue}`);
  return `${existing.length > 0 ? "已更新" : "已设置"}提醒：${code} ${indicator} ${thresholdValue}`;
}

async function offAlert(userId: string, instanceId: string, code: string, indicator?: string): Promise<string> {
  const type = indicator ? indicatorMap[indicator] : undefined;
  if (type) {
    await db
      .update(alerts)
      .set({ enabled: false })
      .where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code), eq(alerts.indicator, type)));
    await disableMirroredAlertRule(userId, code, type, instanceId);
    return `已关闭 ${code} 的${indicator}提醒`;
  }

  await db.update(alerts).set({ enabled: false }).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, code)));
  await disableMirroredAlertRule(userId, code, undefined, instanceId);
  return `已关闭 ${code} 的提醒`;
}

async function listAlerts(userId: string, instanceId: string): Promise<string> {
  const items = await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId)));

  if (items.length === 0) {
    return "暂无提醒设置。\n使用「设置提醒 000001 涨跌幅 3」添加";
  }

  const lines = ["提醒设置"];
  for (const item of items) {
    const threshold = JSON.parse(item.threshold);
    const status = item.enabled ? "开" : "关";
    lines.push(
      `${item.stockCode} ${indicatorNames[item.indicator] || item.indicator}${threshold.value ? ` ${threshold.value}` : ""} ${status}`
    );
  }

  return lines.join("\n");
}

async function markAlertFeedback(userId: string, instanceId: string, code: string | undefined, feedback: string): Promise<string> {
  const rows = await db
    .select()
    .from(alertEvents)
    .where(code ? and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), eq(alertEvents.stockCode, code)) : and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId)))
    .orderBy(desc(alertEvents.createdAt))
    .limit(1);

  if (rows.length === 0) {
    return code
      ? `未找到 ${code} 的提醒事件，无法记录反馈`
      : "未找到最近提醒事件，无法记录反馈";
  }

  const event = rows[0];
  await db
    .update(alertEvents)
    .set({ feedback })
    .where(eq(alertEvents.id, event.id));

  return [
    `已记录提醒反馈：${event.stockName}(${event.stockCode}) ${feedback}`,
    `提醒: ${event.message}`,
  ].join("\n");
}
