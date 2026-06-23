import { db } from "../db/index.js";
import { alerts } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { resolveStockRefDetails, type StockRef } from "../services/stock-resolver.js";
import { syncLegacyAlertToAlertRule } from "../handlers/alert-rules.js";
import { DEFAULT_INSTANCE_ID } from "./user-context.js";

type Direction = "above" | "below";

type AlertIndicator =
  | "price"
  | "target_price"
  | "support_price"
  | "ma_breakout_above"
  | "ma_breakout_below"
  | "macd_golden_cross"
  | "macd_death_cross"
  | "kdj_oversold"
  | "kdj_overbought";

interface AlertSpec {
  stockName?: string;
  stockCode?: string;
  direction?: Direction;
  /** 固定价位提醒的价格。技术指标提醒不需要此字段。 */
  price?: number;
  /** 涨跌幅百分比提醒的标记。 */
  percent?: boolean;
  /** DeepSeek 直接传具体 indicator 类型,优先于 detectIndicator 推断。 */
  indicator?: AlertIndicator;
  /** MA 周期参数,默认 20。 */
  period?: number;
  /** KDJ 阈值参数(超卖默认 20,超买默认 80)。 */
  kdjThreshold?: number;
}

type OkResult = {
  status: "ok";
  code: string;
  name: string;
  indicator: AlertIndicator;
  /** 落库的 threshold JSON 字段值,key 因 indicator 不同。 */
  thresholdJson: Record<string, number>;
  /** 给用户看的中文描述。 */
  label: string;
};

type AlertItemResult = OkResult | { status: "unresolved"; spec: AlertSpec; reason: string };

export interface FastAlertSetInput {
  userId: string;
  instanceId?: string;
  rawText: string;
  single?: AlertSpec;
  batch?: AlertSpec[];
}

export interface FastAlertSetResult {
  text: string;
  mode: "fast-admin-alert-set" | "fast-admin-alert-set-batch" | "fast-admin-alert-clarify";
  ok: boolean;
  written: number;
}

/** 判断 spec 是否属于技术指标类型(不需要 price)。 */
function isTechnicalIndicator(indicator: AlertIndicator): boolean {
  return (
    indicator === "ma_breakout_above" ||
    indicator === "ma_breakout_below" ||
    indicator === "macd_golden_cross" ||
    indicator === "macd_death_cross" ||
    indicator === "kdj_oversold" ||
    indicator === "kdj_overbought"
  );
}

/** 旧逻辑:从 rawText 推断价位类 indicator(技术指标由 DeepSeek 显式传,不走这里)。 */
function detectPriceIndicator(spec: AlertSpec, rawText: string): AlertIndicator {
  if (spec.percent) return "price";
  if (/%|上涨|涨幅|下跌|跌幅|涨跌幅|波动|异动/i.test(rawText)) return "price";
  if (spec.direction === "below") return "support_price";
  if (/(below|down|support|跌|低于|回调|支撑)/i.test(`${spec.direction || ""} ${rawText}`)) return "support_price";
  return "target_price";
}

function buildStockRef(spec: AlertSpec): StockRef | null {
  if (spec.stockCode && /^\d{6}$/.test(spec.stockCode)) {
    return { code: spec.stockCode, name: spec.stockName };
  }
  if (spec.stockName) return { name: spec.stockName };
  return null;
}

/** 解析单个 spec 成 OkResult(含 indicator、threshold、label)。 */
async function resolveOneAlert(spec: AlertSpec, rawText: string): Promise<AlertItemResult> {
  const ref = buildStockRef(spec);
  if (!ref) {
    return { status: "unresolved", spec, reason: "缺少股票名称或代码" };
  }
  const { resolved, unresolved } = await resolveStockRefDetails([ref]);
  if (unresolved.length > 0) {
    return { status: "unresolved", spec, reason: "未找到匹配股票" };
  }
  const stock = resolved[0];
  if (!stock || stock.confidence !== "high") {
    return { status: "unresolved", spec, reason: "股票匹配度低" };
  }

  const indicator = spec.indicator ?? detectPriceIndicator(spec, rawText);

  // 价位类:必须有有效 price
  if (!isTechnicalIndicator(indicator)) {
    if (!Number.isFinite(spec.price) || (spec.price ?? 0) <= 0) {
      return { status: "unresolved", spec, reason: "价格无效" };
    }
    const price = Number(spec.price);
    const thresholdJson = { value: price };
    const label =
      indicator === "price"
        ? `涨跌幅达到 ${price}%`
        : indicator === "support_price"
          ? `价格低于或到达 ${price} 元`
          : `价格达到或高于 ${price} 元`;
    return { status: "ok", code: stock.code, name: stock.name, indicator, thresholdJson, label };
  }

  // 技术指标类:不需要 price,根据 indicator 构造 threshold JSON
  if (indicator === "ma_breakout_above" || indicator === "ma_breakout_below") {
    const period = Number.isFinite(spec.period) && (spec.period ?? 0) > 0 ? Number(spec.period) : 20;
    return {
      status: "ok",
      code: stock.code,
      name: stock.name,
      indicator,
      thresholdJson: { period },
      label: `${indicator === "ma_breakout_above" ? "突破" : "跌破"} ${period} 日均线`,
    };
  }
  if (indicator === "macd_golden_cross") {
    return {
      status: "ok",
      code: stock.code,
      name: stock.name,
      indicator,
      thresholdJson: {},
      label: "MACD 金叉",
    };
  }
  if (indicator === "macd_death_cross") {
    return {
      status: "ok",
      code: stock.code,
      name: stock.name,
      indicator,
      thresholdJson: {},
      label: "MACD 死叉",
    };
  }
  if (indicator === "kdj_oversold") {
    const threshold = Number.isFinite(spec.kdjThreshold) ? Number(spec.kdjThreshold) : 20;
    return {
      status: "ok",
      code: stock.code,
      name: stock.name,
      indicator,
      thresholdJson: { threshold },
      label: `KDJ 超卖反弹(D < ${threshold})`,
    };
  }
  // kdj_overbought
  const threshold = Number.isFinite(spec.kdjThreshold) ? Number(spec.kdjThreshold) : 80;
  return {
    status: "ok",
    code: stock.code,
    name: stock.name,
    indicator,
    thresholdJson: { threshold },
    label: `KDJ 超买回落(D > ${threshold})`,
  };
}

async function writeAlert(userId: string, instanceId: string, item: OkResult) {
  const values = {
    userId,
    instanceId,
    stockCode: item.code,
    indicator: item.indicator,
    threshold: JSON.stringify(item.thresholdJson),
    enabled: true,
  };
  const existing = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, item.code), eq(alerts.indicator, item.indicator)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
  } else {
    await db.insert(alerts).values(values);
  }
  await syncLegacyAlertToAlertRule({ ...values, stockName: item.name });
  logger.info(`fast-alert-set 写入: ${item.code} ${item.indicator} ${JSON.stringify(item.thresholdJson)}`);
}

export async function applyFastAlertSet(input: FastAlertSetInput): Promise<FastAlertSetResult> {
  const instanceId = input.instanceId || DEFAULT_INSTANCE_ID;
  const specs: AlertSpec[] = input.batch && input.batch.length > 0 ? input.batch : input.single ? [input.single] : [];

  if (specs.length === 0) {
    return {
      text: "可以。请告诉我股票名称和触发条件,例如:赛轮轮胎涨到 13.4 提醒我;或:赛轮轮胎突破20日线提醒我。",
      mode: "fast-admin-alert-clarify",
      ok: false,
      written: 0,
    };
  }

  // 价位类必须有 price;技术指标类不需要
  const invalid = specs.find((s) => {
    const indicator = s.indicator ?? detectPriceIndicator(s, input.rawText);
    return !isTechnicalIndicator(indicator) && (!Number.isFinite(s.price) || (s.price ?? 0) <= 0);
  });
  if (invalid) {
    return {
      text: "可以。请告诉我股票名称和触发价格,例如:赛轮轮胎涨到 13.4 提醒我。",
      mode: "fast-admin-alert-clarify",
      ok: false,
      written: 0,
    };
  }

  const results = await Promise.all(specs.map((spec) => resolveOneAlert(spec, input.rawText)));
  const unresolved = results.filter((r): r is Extract<AlertItemResult, { status: "unresolved" }> => r.status === "unresolved");
  if (unresolved.length > 0) {
    const first = unresolved[0];
    const hint = first.spec.stockName || first.spec.stockCode || input.rawText.slice(0, 30);
    return {
      text: `我没法准确识别到「${hint}」。可以直接发完整代码或更精确名称,例如:600519 涨到 1800 提醒我。`,
      mode: "fast-admin-alert-clarify",
      ok: false,
      written: 0,
    };
  }

  const ok = results.filter((r): r is OkResult => r.status === "ok");
  for (const item of ok) {
    await writeAlert(input.userId, instanceId, item);
  }

  const lines = ok.map((item) => `- ${item.name}(${item.code}),${item.label}`);
  const head = ok.length === 1
    ? `已设置提醒:${ok[0].name}(${ok[0].code}),${ok[0].label}。`
    : `已设置 ${ok.length} 条提醒:\n${lines.join("\n")}`;
  const tail = ok.length === 1
    ? "盘中触发时会立刻推送给你。"
    : "\n盘中触发时会按条推送给你。";

  return {
    text: `${head}${tail}`,
    mode: ok.length === 1 ? "fast-admin-alert-set" : "fast-admin-alert-set-batch",
    ok: true,
    written: ok.length,
  };
}
