import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { eq } from "drizzle-orm";

const SETTINGS_KEY = "signal_config";

export interface SignalItem {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  params: Record<string, number | string>;
}

const DEFAULT_SIGNALS: SignalItem[] = [
  {
    key: "price_change",
    name: "涨跌幅异动",
    description: "股价涨跌幅超过阈值时触发",
    enabled: true,
    params: { threshold: 3 },
  },
  {
    key: "near_support",
    name: "接近预案支撑位",
    description: "股价接近交易预案支撑位时触发",
    enabled: true,
    params: {},
  },
  {
    key: "near_resistance",
    name: "接近预案压力位",
    description: "股价接近交易预案压力位时触发",
    enabled: true,
    params: {},
  },
  {
    key: "near_target",
    name: "接近预案目标位",
    description: "股价接近交易预案目标位时触发",
    enabled: true,
    params: {},
  },
  {
    key: "stop_loss",
    name: "跌破预案止损位",
    description: "股价跌破交易预案止损位时触发",
    enabled: true,
    params: {},
  },
  {
    key: "breakout_with_volume",
    name: "放量突破预案压力位",
    description: "放量突破交易预案压力位，量比配合判断",
    enabled: true,
    params: { volumeThreshold: 1.5 },
  },
  {
    key: "break_support",
    name: "跌破预案支撑位",
    description: "跌破交易预案支撑位，配合量能状态判断",
    enabled: true,
    params: {},
  },
  {
    key: "turnover",
    name: "换手率异常",
    description: "换手率超过阈值时触发",
    enabled: false,
    params: { threshold: 5 },
  },
  {
    key: "volume_ratio",
    name: "量比触发",
    description: "当前成交量相对5日均量超过倍数时触发",
    enabled: false,
    params: { threshold: 2 },
  },
  {
    key: "macd",
    name: "MACD 金叉/死叉",
    description: "MACD出现金叉或死叉信号时触发",
    enabled: false,
    params: {},
  },
  {
    key: "bid_ask_imbalance",
    name: "盘口买卖量差",
    description: "五档盘口买卖量差偏斜超过阈值时触发（仅盘口观察，不代表主力控盘）",
    enabled: false,
    params: { threshold: 0.6 },
  },
  {
    key: "capital_flow_main",
    name: "主力资金净流入异动",
    description: "东方财富数据：主力资金净流入超过阈值时触发（单位：万元）",
    enabled: false,
    params: { threshold: 5000 },
  },
  {
    key: "capital_flow_super_large",
    name: "超大单资金净流入异动",
    description: "东方财富数据：超大单净流入超过阈值时触发（单位：万元）",
    enabled: false,
    params: { threshold: 3000 },
  },
  {
    key: "volume_price_divergence",
    name: "盘中放量滞涨/滞跌",
    description: "分时1分钟K线：成交量超过均量倍数且振幅极小，可能为主力吸筹或派发",
    enabled: true,
    params: { volumeMultiplier: 3, priceRangePercent: 0.5 },
  },
  {
    key: "ma_breakout_above",
    name: "突破X日均线",
    description: "收盘价由下而上穿越X日均线（含 MA5/10/20/60，可在参数中指定周期）",
    enabled: true,
    params: { period: 20 },
  },
  {
    key: "ma_breakout_below",
    name: "跌破X日均线",
    description: "收盘价由上而下穿越X日均线",
    enabled: true,
    params: { period: 20 },
  },
  {
    key: "macd_golden_cross",
    name: "MACD 金叉",
    description: "DIF 由下上穿 DEA，短期转多信号",
    enabled: true,
    params: {},
  },
  {
    key: "macd_death_cross",
    name: "MACD 死叉",
    description: "DIF 由上下穿 DEA，短期转空信号",
    enabled: true,
    params: {},
  },
  {
    key: "kdj_oversold",
    name: "KDJ 超卖反弹",
    description: "KDJ 在超卖区(D 值低于阈值)出现 K 上穿 D",
    enabled: true,
    params: { threshold: 20 },
  },
  {
    key: "kdj_overbought",
    name: "KDJ 超买回落",
    description: "KDJ 在超买区(D 值高于阈值)出现 K 下穿 D",
    enabled: true,
    params: { threshold: 80 },
  },
];

export async function getSignalConfig(): Promise<SignalItem[]> {
  const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  if (rows.length === 0) {
    await saveSignalConfig(DEFAULT_SIGNALS);
    return [...DEFAULT_SIGNALS];
  }
  try {
    const parsed = JSON.parse(rows[0].value) as SignalItem[];
    // 合并新增的默认信号
    const keys = new Set(parsed.map((s) => s.key));
    const merged = [...parsed];
    for (const def of DEFAULT_SIGNALS) {
      if (!keys.has(def.key)) {
        merged.push({ ...def });
      }
    }
    return merged;
  } catch {
    return [...DEFAULT_SIGNALS];
  }
}

async function saveSignalConfig(config: SignalItem[]): Promise<void> {
  const value = JSON.stringify(config);
  await db.insert(settings).values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export interface SignalConfigInput {
  operation: "query" | "update";
  signalKey?: string;
  enabled?: boolean;
  params?: Record<string, number | string>;
}

export async function handleSignalConfigTool(input: SignalConfigInput): Promise<string> {
  if (input.operation === "update" && input.signalKey) {
    return updateSignal(input);
  }
  return querySignals();
}

async function querySignals(): Promise<string> {
  const config = await getSignalConfig();
  const enabled = config.filter((s) => s.enabled);
  const disabled = config.filter((s) => !s.enabled);

  const lines: string[] = [];
  if (enabled.length > 0) {
    lines.push(`【已开启的信号(${enabled.length}项)】`);
    for (const s of enabled) {
      const paramStr = Object.entries(s.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- ${s.name}(${s.key})${paramStr ? ` | ${paramStr}` : ""} | ${s.description}`);
    }
  }

  if (disabled.length > 0) {
    lines.push("");
    lines.push(`【已关闭的信号(${disabled.length}项)】`);
    for (const s of disabled) {
      const paramStr = Object.entries(s.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      lines.push(`- ${s.name}(${s.key})${paramStr ? ` | ${paramStr}` : ""} | ${s.description}`);
    }
  }

  return lines.join("\n");
}

async function updateSignal(input: SignalConfigInput): Promise<string> {
  const config = await getSignalConfig();
  const idx = config.findIndex((s) => s.key === input.signalKey);
  if (idx === -1) {
    return `未找到信号 ${input.signalKey}。可用信号：${config.map((s) => s.key).join(", ")}`;
  }

  const signal = config[idx];
  if (input.enabled !== undefined) {
    signal.enabled = input.enabled;
  }
  if (input.params) {
    signal.params = { ...signal.params, ...input.params };
  }

  await saveSignalConfig(config);

  const action = input.enabled === true ? "已开启" : input.enabled === false ? "已关闭" : "已更新";
  const paramStr = Object.entries(signal.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `${action}信号：${signal.name}(${signal.key})${paramStr ? `，参数：${paramStr}` : ""}`;
}

/** 获取单个信号配置（供巡检引擎使用） */
export async function getSignalSetting(
  key: string
): Promise<{ enabled: boolean; params: Record<string, number | string> } | null> {
  const config = await getSignalConfig();
  const found = config.find((s) => s.key === key);
  if (!found) return null;
  return { enabled: found.enabled, params: found.params };
}
