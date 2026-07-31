/**
 * 窄价格事实接口 (WP5/F4)
 *
 * 价格阈值规则 (price_cross) 的窄事实接口。
 *
 * 服务自有行情 provider 已退役；这里不再直连腾讯/新浪或完整 market facade。
 * 后续若规则引擎需要恢复实时价格，应接入外部数据 MCP 的受控规则取价能力。
 *
 * 设计要点:
 *   - 短 TTL 缓存（5 秒）：同一 tick 内或短时间内的重复请求只打一次 provider。
 *   - 批量去重：重复 code 只请求一次。
 *   - 当前全部返回 usable=false + failureCode，不触网、不抛异常。
 */

import type { StockQuote } from "./market-types.js";

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

/** 短 TTL 缓存（5 秒），避免同一 tick 内重复打 provider。 */
const CACHE_TTL_MS = 5_000;
let cache: { codesKey: string; facts: Map<string, RulePriceFact>; expiresAt: number } | null = null;

/**
 * 批量获取规则价格事实。同一 tick 对所有价格规则只请求一次（TTL 缓存）。
 *
 * 输入必须是已确认的规范证券代码 (由调用方保证);返回的 Map 按 code 索引。
 * 全失败时返回的每个 fact 都是 usable=false,不抛异常。
 */
export async function getRulePrices(codes: string[]): Promise<Map<string, RulePriceFact>> {
  const uniqueCodes = [...new Set(codes.filter((c) => c && c.trim()))];
  if (uniqueCodes.length === 0) return new Map();

  // TTL 缓存命中
  const codesKey = uniqueCodes.sort().join(",");
  const now = Date.now();
  if (cache && cache.codesKey === codesKey && cache.expiresAt > now) {
    return cache.facts;
  }

  const facts = await fetchRulePricesFromProviders(uniqueCodes);

  // 写缓存
  cache = { codesKey, facts, expiresAt: now + CACHE_TTL_MS };
  return facts;
}

async function fetchRulePricesFromProviders(codes: string[]): Promise<Map<string, RulePriceFact>> {
  const result = new Map<string, RulePriceFact>();
  for (const code of codes) {
    result.set(code, { code, price: null, asOf: null, usable: false, provider: null, failureCode: "market_data_provider_retired" });
  }
  return result;
}

/**
 * 纯函数: 把单个 StockQuote 映射成 RulePriceFact (导出供单测覆盖映射逻辑)。
 * F4: usable 判定改为 price 是有限正数（provider 原始行情无 tradingStatus 概念）。
 */
export function toRulePriceFact(code: string, quote: StockQuote | null | undefined, provider?: string | null): RulePriceFact {
  if (!quote || quote.price == null || !Number.isFinite(quote.price) || quote.price <= 0) {
    return {
      code,
      price: null,
      asOf: quote?.time ?? null,
      usable: false,
      provider: provider ?? null,
      failureCode: quote ? "invalid_price" : "missing",
    };
  }
  return { code, price: quote.price, asOf: quote.time ?? null, usable: true, provider: provider ?? null };
}

/** 仅用于测试重置缓存。 */
export function resetRulePriceCacheForTest(): void {
  cache = null;
}
