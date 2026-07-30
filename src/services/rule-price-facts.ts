/**
 * 窄价格事实接口 (WP5)
 *
 * 让价格阈值规则 (price_cross) 脱离完整 marketDataReadCapability 和 ACP。
 * 这个接口只返回规则判定所需的最小事实: 价格、时点、可用性、provider。
 * 不暴露完整 MarketQuote、tradingStatus 详情或 source 元数据,降低规则与
 * 行情能力面的耦合。
 *
 * 设计要点:
 *   - 复用 marketDataReadCapability.quote (已含腾讯主源 + 新浪 fallback + 交叉校验),
 *     不重复实现 provider 逻辑。
 *   - 批量去重: 重复 code 只请求一次。
 *   - usable 判定: price 是有限数 + 非 null + tradingStatus 正常。
 *   - 全失败时不抛异常,返回 usable=false + failureCode,由调用方决定保持未触发。
 */

import { marketDataReadCapability } from "./market-data.js";

export interface RulePriceFact {
  /** 规范证券代码 (6 位字符串)。 */
  code: string;
  /** 当前价格;不可用时为 null。 */
  price: number | null;
  /** 行情时点 (marketTime);不可用时为 null。 */
  asOf: string | null;
  /** 价格是否可用于规则触发判定。 */
  usable: boolean;
  /** 实际命中的 provider;全失败时为 null。 */
  provider: string | null;
  /** 不可用时的失败码,供最小诊断。 */
  failureCode?: string;
}

/** tradingStatus 中视为不可用的状态 —— 这些状态的价格不能触发规则。 */
const UNUSABLE_TRADING_STATUS = new Set(["stale", "invalid", "unknown"]);

/**
 * 批量获取规则价格事实。同一 tick 对所有价格规则只请求一次。
 *
 * 输入必须是已确认的规范证券代码 (由调用方保证);返回的 Map 按 code 索引。
 * 全失败时返回的每个 fact 都是 usable=false,不抛异常。
 */
export async function getRulePrices(codes: string[]): Promise<Map<string, RulePriceFact>> {
  const uniqueCodes = [...new Set(codes.filter((c) => c && c.trim()))];
  const result = new Map<string, RulePriceFact>();

  if (uniqueCodes.length === 0) return result;

  let items;
  let warnings: string[];
  try {
    const quoteResult = await marketDataReadCapability.quote(uniqueCodes);
    items = quoteResult.items;
    warnings = quoteResult.warnings;
  } catch (error) {
    // provider 全失败: 每个 code 标记为不可用,不抛异常
    for (const code of uniqueCodes) {
      result.set(code, {
        code,
        price: null,
        asOf: null,
        usable: false,
        provider: null,
        failureCode: "quote_failed",
      });
    }
    return result;
  }

  // 按 code 建立索引 (quote.code 可能含 sh/sz 前缀,用纯数字匹配)
  const quoteByCode = new Map<string, (typeof items)[number]>();
  for (const quote of items) {
    const normalized = normalizeCodeKey(quote.code);
    if (normalized) quoteByCode.set(normalized, quote);
  }

  for (const code of uniqueCodes) {
    const key = normalizeCodeKey(code) || code;
    const quote = quoteByCode.get(key);
    result.set(code, toRulePriceFact(code, quote ?? null));
  }

  // warnings 不进 fact,但全失败时已在 catch 处理;部分失败由 failureCode 表达
  void warnings;
  return result;
}

/** 把可能的 sh600519/sz000001/600519.SH 等形式归一为纯 6 位代码做匹配。 */
function normalizeCodeKey(code: string): string | null {
  const match = String(code).match(/(\d{6})/);
  return match ? match[1] : null;
}

/**
 * 纯函数: 把单个 MarketQuote 映射成 RulePriceFact (导出供单测覆盖映射逻辑)。
 * usable 判定: price 是有限数 + tradingStatus 非 stale/invalid/unknown。
 */
export function toRulePriceFact(code: string, quote: {
  price: number | null | undefined;
  time?: string | null;
  tradingStatus?: { status?: string } | null;
  source?: { provider?: string | null; marketTime?: string | null } | null;
} | null | undefined): RulePriceFact {
  if (!quote || quote.price == null || !Number.isFinite(quote.price)) {
    return {
      code,
      price: null,
      asOf: quote?.source?.marketTime ?? quote?.time ?? null,
      usable: false,
      provider: quote?.source?.provider ?? null,
      failureCode: quote ? "invalid_price" : "missing",
    };
  }
  const status = quote.tradingStatus?.status;
  if (status && UNUSABLE_TRADING_STATUS.has(status)) {
    return { code, price: quote.price, asOf: quote.source?.marketTime ?? quote.time ?? null, usable: false, provider: quote.source?.provider ?? null, failureCode: "stale" };
  }
  return { code, price: quote.price, asOf: quote.source?.marketTime ?? quote.time ?? null, usable: true, provider: quote.source?.provider ?? null };
}
