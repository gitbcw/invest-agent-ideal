import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import {
  ashareCalendarReport,
  beijingDateKey,
  type AshareCalendarReport,
} from "../lib/market-calendar.js";
import {
  getCapitalFlowBatch,
  type CapitalFlow,
} from "./eastmoney.js";
import { getStockSectorTheme, type StockSectorTheme } from "./sector-theme.js";
import {
  getStockAnnouncements,
  getStockNews,
  getStockReports,
  type StockAnnouncementItem,
  type StockNewsItem,
  type StockReportItem,
} from "./stock-news.js";
import {
  getKline,
  getMarketIndex,
  getMinuteKline,
  getQuote,
  getSinaKline,
  getSinaMarketIndex,
  getSinaQuote,
  searchStock,
  type StockKline,
  type StockQuote,
} from "./stock.js";
import {
  getProvider,
  percentile,
  recordSourceDegraded,
  snapshotEndpointStats,
  withSourceEvent,
  type EndpointStat,
  type EvidenceLevel,
  type MarketDataConfidence,
  type MarketDataProvider,
  type ProviderName,
} from "./market-data-providers.js";

export type { MarketDataProvider, MarketDataConfidence } from "./market-data-providers.js";
export type { EndpointStat } from "./market-data-providers.js";
export type MarketKlinePeriod = "day" | "m5";
const QUOTE_CROSS_CHECK_THRESHOLD = 0.005;
const INDEX_CROSS_CHECK_THRESHOLD = 0.003;
const STALE_QUOTE_MAX_AGE_DAYS = 3;

export interface MarketSourceMeta {
  provider: MarketDataProvider;
  endpoint: string;
  /** Sanitized external provider URL/reference. Never contains sandbox tokens or local service paths. */
  referenceUrl?: string;
  fetchedAt: string;
  marketTime?: string;
  confidence: MarketDataConfidence;
  evidenceLevel: EvidenceLevel;
  usageBoundary: string;
  stale: boolean;
  warnings: string[];
}

export type MarketQuote = StockQuote & {
  source: MarketSourceMeta;
  tradingStatus: MarketTradingStatus;
};

export interface MarketTradingStatus {
  status: "normal" | "halted" | "limit_up" | "limit_down" | "stale" | "invalid" | "unknown";
  reasons: string[];
}

export type MarketIndexQuote = Awaited<ReturnType<typeof getMarketIndex>>[number] & {
  source: MarketSourceMeta;
};

export type MarketMinuteKline = Awaited<ReturnType<typeof getMinuteKline>>[number];

export interface MarketKlineResult {
  code: string;
  period: MarketKlinePeriod;
  count: number;
  items: StockKline[] | MarketMinuteKline[];
  source: MarketSourceMeta;
}

export type MarketCapitalFlow = CapitalFlow & {
  source: MarketSourceMeta;
};

export type MarketSectorTheme = StockSectorTheme & {
  source: MarketSourceMeta;
};

export interface MarketStockInfo {
  code: string;
  name: string;
  news: StockNewsItem[];
  reports: StockReportItem[];
  announcements: StockAnnouncementItem[];
  source: MarketSourceMeta;
}

export interface MarketSnapshotItem {
  stockCode: string;
  stockName: string;
  quote?: MarketQuote;
  support?: number | null;
  resistance?: number | null;
  targetPrice?: number | null;
  stopLoss?: number | null;
}

export interface MarketSnapshot {
  ok: true;
  userId: string;
  instanceId: string;
  updatedAt: string;
  holdings: MarketSnapshotItem[];
  watchlist: MarketSnapshotItem[];
  plans: MarketSnapshotItem[];
  indices: MarketIndexQuote[];
  capitalFlows?: MarketCapitalFlow[];
  warnings: string[];
}

export interface MarketHealthReport {
  ok: true;
  checkedAt: string;
  capabilities: MarketDataCapability[];
  endpoints: Array<{
    provider: ProviderName;
    runtimeProvider: MarketDataProvider;
    endpoint: string;
    confidence: MarketDataConfidence;
    evidenceLevel: EvidenceLevel;
    usageBoundary: string;
    consecutiveFailures: number;
    totalCalls: number;
    totalFailures: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastStatus: EndpointStat["lastStatus"];
    lastError: string | null;
    recentLatencyP95: number | null;
  }>;
}

export type MarketCalendarReport = AshareCalendarReport;

export interface MarketDataCapability {
  key: string;
  name: string;
  status: "ready" | "partial" | "missing";
  businessUse: string;
  primaryProviders: ProviderName[];
  fallbackProviders: ProviderName[];
  requiredFor: string[];
  evidenceLevel: EvidenceLevel;
  usageBoundary: string;
  gaps: string[];
  nextStep: string;
}

const MARKET_DATA_CAPABILITIES: MarketDataCapability[] = [
  {
    key: "stock_quote",
    name: "A 股个股行情",
    status: "partial",
    businessUse: "持仓/自选当前价、涨跌幅、预案触发判断、巡检提醒",
    primaryProviders: ["tencent_quote"],
    fallbackProviders: ["sina_quote"],
    requiredFor: ["market_watch", "portfolio_review", "plan_condition"],
    evidenceLevel: "primary_fact",
    usageBoundary: "价格事实可用于触发判断;若 source warnings 含 degraded/stale/invalid,只能降级提示。",
    gaps: ["已有 fallback,但缺少常态跨源价格校验", "缺少停牌/涨跌停等交易状态字段"],
    nextStep: "已加入主备价格差异校验;下一步补交易状态字段",
  },
  {
    key: "daily_kline",
    name: "日 K / 历史走势",
    status: "partial",
    businessUse: "均线、KDJ、量价背离、复盘走势判断",
    primaryProviders: ["tencent_kline_d"],
    fallbackProviders: ["sina_kline_d"],
    requiredFor: ["technical_signal", "portfolio_review", "market_watch"],
    evidenceLevel: "primary_fact",
    usageBoundary: "可作为技术指标输入;需保留复权口径和数据完整性提示。",
    gaps: ["已有 fallback,但新浪 fallback 不保证复权口径", "缺少长期历史完整性校验"],
    nextStep: "记录复权口径和数据条数完整性,再做跨源末端价格校验",
  },
  {
    key: "minute_kline",
    name: "5 分钟 K",
    status: "partial",
    businessUse: "盘中巡检、短周期量价变化观察",
    primaryProviders: ["tencent_kline_m5"],
    fallbackProviders: [],
    requiredFor: ["intraday_watch"],
    evidenceLevel: "signal",
    usageBoundary: "盘中辅助信号,不能单独支撑买卖确认。",
    gaps: ["只有 5 分钟粒度", "缺少 fallback", "不覆盖 tick/逐笔/盘口深度"],
    nextStep: "先保留为辅助观察,不要把它当作高频交易级数据",
  },
  {
    key: "indices",
    name: "市场指数",
    status: "partial",
    businessUse: "日复盘市场背景、持仓涨跌归因的环境判断",
    primaryProviders: ["tencent_indices"],
    fallbackProviders: ["sina_indices"],
    requiredFor: ["portfolio_review", "market_context"],
    evidenceLevel: "primary_fact",
    usageBoundary: "市场背景事实,行业/主题归因需另用板块数据。",
    gaps: ["已有 fallback,但指数覆盖范围仍有限", "缺少行业/主题指数"],
    nextStep: "已加入主备指数价格差异校验;下一步扩展行业/主题指数能力",
  },
  {
    key: "capital_flow",
    name: "资金流向",
    status: "partial",
    businessUse: "主力/大单方向的辅助观察",
    primaryProviders: ["eastmoney_flow"],
    fallbackProviders: [],
    requiredFor: ["watch_rule_signal"],
    evidenceLevel: "signal",
    usageBoundary: "资金流只能作为观察信号,不能证明主力行为或单独触发交易。",
    gaps: ["只能辅助,不能证明主力控盘", "缺少 fallback", "口径依赖东方财富"],
    nextStep: "保留低置信度标签,只作为观察条件,不作为单独买卖证据",
  },
  {
    key: "stock_resolve",
    name: "股票搜索/代码解析",
    status: "ready",
    businessUse: "用户自然语言提到股票名时解析代码",
    primaryProviders: ["tencent_search"],
    fallbackProviders: [],
    requiredFor: ["chat_qa", "watchlist_add"],
    evidenceLevel: "operational",
    usageBoundary: "用于代码解析,不作为投资证据。",
    gaps: ["缺少别名/简称本地字典", "缺少 fallback"],
    nextStep: "补本地代码名称缓存,降低外部搜索依赖",
  },
  {
    key: "trading_calendar",
    name: "交易日历",
    status: "partial",
    businessUse: "判断今天是否交易、定时任务是否应执行、节假日处理",
    primaryProviders: ["service_calendar_cn_ashare"],
    fallbackProviders: [],
    requiredFor: ["scheduler", "market_watch", "review_push"],
    evidenceLevel: "operational",
    usageBoundary: "用于调度和 freshness 判断,不作为投资结论。",
    gaps: ["已覆盖 2026 A 股周末/法定休市,暂未接入外部权威自动更新源", "临时休市不覆盖"],
    nextStep: "接入交易所/第三方权威日历自动更新,并扩展到 2027+",
  },
  {
    key: "market_status",
    name: "停牌/涨跌停/交易状态",
    status: "partial",
    businessUse: "避免把停牌、涨跌停、异常价格当作普通波动",
    primaryProviders: ["tencent_quote", "sina_quote"],
    fallbackProviders: [],
    requiredFor: ["alert_check", "plan_condition", "review"],
    evidenceLevel: "operational",
    usageBoundary: "用于判断行情是否适合触发规则;异常状态应降级处理。",
    gaps: ["已提供启发式交易状态,但未接入权威停复牌/涨跌停规则源"],
    nextStep: "接入交易日历和停复牌/涨跌停权威字段,减少启发式判断",
  },
  {
    key: "announcement",
    name: "公告/财报/新闻",
    status: "partial",
    businessUse: "复盘基本面事件、风险提示、选股问答证据",
    primaryProviders: ["cninfo_announcements", "eastmoney_stock_news", "eastmoney_stock_reports"],
    fallbackProviders: [],
    requiredFor: ["screening", "portfolio_review", "risk_check"],
    evidenceLevel: "secondary_evidence",
    usageBoundary: "公告是事实来源;新闻/研报只能辅助,不能单独支撑买卖确认。",
    gaps: ["已支持个股新闻/研报/公告摘要,暂未解析正式财报正文与公告 PDF", "新闻/研报只能作为辅助证据"],
    nextStep: "补官方财报结构化解析和重大公告分类,把公告事实与媒体观点分层",
  },
  {
    key: "sector_theme",
    name: "行业/主题/板块",
    status: "partial",
    businessUse: "主题选股、持仓集中度、行业联动归因",
    primaryProviders: ["eastmoney_sector_theme"],
    fallbackProviders: [],
    requiredFor: ["screening", "portfolio_review", "market_context"],
    evidenceLevel: "secondary_evidence",
    usageBoundary: "用于行业/主题归因和筛选线索,不是投资结论。",
    gaps: ["已支持个股行业/主题标签,暂未支持全市场板块行情和板块成分股完整检索"],
    nextStep: "补板块行情与板块成分股列表,用于主题筛选和持仓集中度统计",
  },
];

function sourceMeta(provider: ProviderName, overrides: {
  referenceUrl?: string;
  marketTime?: string;
  stale?: boolean;
  warnings?: string[];
} = {}): MarketSourceMeta {
  const meta = getProvider(provider);
  return {
    provider: meta.runtimeProvider,
    endpoint: meta.endpoint,
    referenceUrl: overrides.referenceUrl,
    fetchedAt: new Date().toISOString(),
    marketTime: overrides.marketTime,
    confidence: meta.confidence,
    evidenceLevel: meta.evidenceLevel,
    usageBoundary: meta.usageBoundary,
    stale: overrides.stale ?? false,
    warnings: overrides.warnings ?? [],
  };
}

function marketCode(code: string): string {
  const pure = normalizeCode(code);
  if (!pure) return "";
  if (pure.startsWith("6") || pure.startsWith("5")) return `sh${pure}`;
  return `sz${pure}`;
}

function eastmoneySecid(code: string): string {
  const pure = normalizeCode(code);
  return pure.startsWith("6") ? `1.${pure}` : `0.${pure}`;
}

function providerReferenceUrl(
  provider: ProviderName,
  input: { code?: string; codes?: string[]; count?: number; startDate?: string; endDate?: string } = {},
): string | undefined {
  const codes = (input.codes && input.codes.length > 0 ? input.codes : input.code ? [input.code] : [])
    .map(marketCode)
    .filter(Boolean);
  const firstCode = input.code ? marketCode(input.code) : codes[0];
  const pureCode = input.code ? normalizeCode(input.code) : firstCode ? normalizeCode(firstCode) : "";
  const count = Math.max(1, Math.floor(input.count || 120));
  const start = input.startDate || "";
  const end = input.endDate || "";

  switch (provider) {
    case "tencent_quote":
    case "tencent_indices":
      return `https://qt.gtimg.cn/q=${(codes.length ? codes : ["sh000001", "sz399001", "sz399006", "sh000300"]).join(",")}`;
    case "tencent_kline_d":
      return firstCode ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${firstCode},day,${start},${end},${count},qfq` : undefined;
    case "tencent_kline_m5":
      return firstCode ? `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${firstCode},m5,,${count}` : undefined;
    case "tencent_search":
      return "https://smartbox.gtimg.cn/s3/?v=2&q={keyword}&t=all";
    case "sina_quote":
    case "sina_indices":
      return `https://hq.sinajs.cn/list=${(codes.length ? codes : ["sh000001", "sz399001", "sz399006", "sh000300"]).join(",")}`;
    case "sina_kline_d":
      return firstCode ? `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${firstCode}&scale=240&ma=no&datalen=${count}` : undefined;
    case "eastmoney_flow":
      return pureCode ? `https://emdatah5.eastmoney.com/dc/ZJLX/getZJLXData?secid=${eastmoneySecid(pureCode)}&fields=f57,f58,f135,f136,f140,f143,f146,f149,f86` : undefined;
    case "eastmoney_sector_theme":
      return pureCode ? `https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=${pureCode.startsWith("6") || pureCode.startsWith("5") ? "SH" : "SZ"}${pureCode}` : undefined;
    case "eastmoney_stock_news":
      return pureCode ? `https://np-listapi.eastmoney.com/comm/wap/getListInfo?client=wap&type=1&mession=1&pageNo=1&pageSize=10&fields1=f1,f2,f3,f4&fields2=f51,f52,f53&mTypeAndCode=${pureCode.startsWith("6") ? "1" : "0"}.${pureCode}` : undefined;
    case "eastmoney_stock_reports":
      return pureCode ? `https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=*&ratingChange=*&pageNo=1&fields=&qType=0&orgCode=&code=${pureCode}` : undefined;
    case "cninfo_announcements":
      return pureCode ? `https://www.cninfo.com.cn/new/hisAnnouncement/query?stock=${pureCode}` : "https://www.cninfo.com.cn/new/hisAnnouncement/query";
    case "service_calendar_cn_ashare":
      return "service://calendar/cn-ashare";
    default:
      return undefined;
  }
}

function quoteWarnings(quote: StockQuote) {
  const warnings: string[] = [];
  if (!quote.time) warnings.push("missing_market_time");
  if (!quote.price) warnings.push("missing_or_zero_price");
  return warnings;
}

function quoteTradingStatus(quote: StockQuote): MarketTradingStatus {
  const reasons: string[] = [];
  if (!quote.price || quote.price <= 0) reasons.push("missing_or_zero_price");
  if (!quote.time) reasons.push("missing_market_time");

  const quoteDate = parseQuoteDate(quote.time);
  if (quoteDate && isStaleQuoteDate(quoteDate)) {
    reasons.push("stale_market_time");
  }
  const noTradeVolume = quote.volume === 0 && quote.amount === 0;
  if (noTradeVolume) reasons.push("zero_volume_amount");
  if (noTradeVolume && quote.open === 0 && quote.high === 0 && quote.low === 0) {
    reasons.push("possible_halted");
  }

  const absChange = Math.abs(quote.changePercent || 0);
  const isLimitLike = absChange >= 9.8;
  if (isLimitLike && quote.changePercent > 0) reasons.push("limit_up_like");
  if (isLimitLike && quote.changePercent < 0) reasons.push("limit_down_like");

  if (reasons.includes("missing_or_zero_price")) return { status: "invalid", reasons };
  if (reasons.includes("stale_market_time")) return { status: "stale", reasons };
  if (reasons.includes("possible_halted")) return { status: "halted", reasons };
  if (reasons.includes("limit_up_like")) return { status: "limit_up", reasons };
  if (reasons.includes("limit_down_like")) return { status: "limit_down", reasons };
  if (reasons.includes("missing_market_time")) return { status: "unknown", reasons };
  return { status: "normal", reasons };
}

function parseQuoteDate(value: string): Date | null {
  const match = String(value || "").match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isStaleDate(date: Date, maxAgeDays: number): boolean {
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const quoteUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return todayUtc - quoteUtc > maxAgeDays * 24 * 60 * 60 * 1000;
}

function isStaleQuoteDate(date: Date, now = new Date()): boolean {
  if (isStaleDate(date, STALE_QUOTE_MAX_AGE_DAYS)) return true;
  const quoteDateKey = beijingDateKey(date);
  const calendar = ashareCalendarReport(now);
  if (!calendar.isTradingDay) {
    return Boolean(calendar.previousTradingDay && quoteDateKey < calendar.previousTradingDay);
  }
  if (calendar.session === "pre_market") {
    return Boolean(calendar.previousTradingDay && quoteDateKey < calendar.previousTradingDay);
  }
  return quoteDateKey < calendar.dateKey;
}

export async function marketQuote(
  codes: string[],
  userId: string | null = null,
): Promise<{ items: MarketQuote[]; warnings: string[] }> {
  const uniqueCodes = normalizeCodes(codes);
  if (uniqueCodes.length === 0) return { items: [], warnings: ["empty_codes"] };

  let quotes: StockQuote[] = [];
  const warnings: string[] = [];
  const fallbackCodes = new Set<string>();
  let primaryOk = false;
  try {
    quotes = await withSourceEvent("tencent_quote", userId, () => getQuote(uniqueCodes));
    primaryOk = true;
  } catch (error) {
    warnings.push(`primary_failed:tencent_quote:${(error as Error).message}`);
  }
  let foundCodes = new Set(quotes.map((quote) => normalizeCode(quote.code)));
  let missing = uniqueCodes.filter((code) => !foundCodes.has(code));
  if (primaryOk && missing.length === 0 && quotes.length > 0) {
    const degraded = await crossCheckQuotes(quotes, userId);
    warnings.push(...degraded);
  }
  if (missing.length) {
    try {
      const fallbackQuotes = await withSourceEvent("sina_quote", userId, () => getSinaQuote(missing));
      if (fallbackQuotes.length > 0) warnings.push(`fallback_used:sina_quote:${fallbackQuotes.length}`);
      const fallbackByCode = new Map(fallbackQuotes.map((quote) => [normalizeCode(quote.code), quote]));
      for (const quote of fallbackQuotes) fallbackCodes.add(normalizeCode(quote.code));
      quotes = [
        ...quotes,
        ...missing.map((code) => fallbackByCode.get(code)).filter((quote): quote is StockQuote => Boolean(quote)),
      ];
    } catch (error) {
      warnings.push(`fallback_failed:sina_quote:${(error as Error).message}`);
    }
  }
  foundCodes = new Set(quotes.map((quote) => normalizeCode(quote.code)));
  missing = uniqueCodes.filter((code) => !foundCodes.has(code));
  if (missing.length) warnings.push(`missing_quotes:${missing.join(",")}`);
  return {
    items: quotes.map((quote) => {
      const itemWarnings = quoteWarnings(quote);
      const tradingStatus = quoteTradingStatus(quote);
      for (const reason of tradingStatus.reasons) {
        if (!itemWarnings.includes(reason)) itemWarnings.push(reason);
      }
      if (tradingStatus.status !== "normal") itemWarnings.push(`trading_status:${tradingStatus.status}`);
      const sourceProvider: ProviderName = fallbackCodes.has(normalizeCode(quote.code)) ? "sina_quote" : "tencent_quote";
      if (sourceProvider === "sina_quote") itemWarnings.push("fallback_provider:sina_quote");
      return {
        ...quote,
        tradingStatus,
        source: sourceMeta(sourceProvider, {
          referenceUrl: providerReferenceUrl(sourceProvider, { code: quote.code }),
          marketTime: quote.time,
          stale: itemWarnings.includes("missing_market_time"),
          warnings: itemWarnings,
        }),
      };
    }),
    warnings,
  };
}

async function crossCheckQuotes(primaryQuotes: StockQuote[], userId: string | null): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const codes = primaryQuotes.map((quote) => normalizeCode(quote.code));
    const fallbackQuotes = await withSourceEvent("sina_quote", userId, () => getSinaQuote(codes));
    const fallbackByCode = new Map(fallbackQuotes.map((quote) => [normalizeCode(quote.code), quote]));
    for (const primary of primaryQuotes) {
      const code = normalizeCode(primary.code);
      const fallback = fallbackByCode.get(code);
      if (!fallback || !primary.price || !fallback.price) continue;
      const diffRatio = Math.abs(primary.price - fallback.price) / Math.max(primary.price, fallback.price);
      if (diffRatio > QUOTE_CROSS_CHECK_THRESHOLD) {
        const message = `cross_check_degraded:quote:${code}:${(diffRatio * 100).toFixed(2)}%`;
        warnings.push(message);
        await recordSourceDegraded("tencent_quote", userId, message, {
          code,
          primaryPrice: primary.price,
          fallbackPrice: fallback.price,
          fallbackProvider: "sina_quote",
          threshold: QUOTE_CROSS_CHECK_THRESHOLD,
        });
      }
    }
  } catch (error) {
    warnings.push(`cross_check_failed:sina_quote:${(error as Error).message}`);
  }
  return warnings;
}

export async function marketKline(
  input: {
    code: string;
    period?: MarketKlinePeriod;
    count?: number;
    startDate?: string;
    endDate?: string;
  },
  userId: string | null = null,
): Promise<MarketKlineResult> {
  const code = input.code.trim();
  const period = input.period ?? "day";
  const count = boundedCount(input.count, period === "m5" ? 240 : 500);
  if (!code) throw new Error("缺少股票代码");
  if (period === "m5") {
    const provider: ProviderName = "tencent_kline_m5";
    const items = await withSourceEvent(provider, userId, () => getMinuteKline(code, count));
    return {
      code,
      period,
      count,
      items,
      source: sourceMeta(provider, {
        referenceUrl: providerReferenceUrl(provider, { code, count }),
        marketTime: items[items.length - 1]?.time,
        stale: items.length === 0,
        warnings: items.length === 0 ? ["empty_minute_kline"] : [],
      }),
    };
  }

  const provider: ProviderName = "tencent_kline_d";
  let items: StockKline[] = [];
  const warnings: string[] = [];
  let sourceProvider: ProviderName = provider;
  try {
    items = await withSourceEvent(provider, userId, () =>
      getKline(code, count, input.startDate, input.endDate),
    );
  } catch (error) {
    warnings.push(`primary_failed:tencent_kline_d:${(error as Error).message}`);
  }
  if (items.length === 0) {
    try {
      const fallbackItems = await withSourceEvent("sina_kline_d", userId, () => getSinaKline(code, count));
      if (fallbackItems.length > 0) {
        items = fallbackItems;
        sourceProvider = "sina_kline_d";
        warnings.push(`fallback_used:sina_kline_d:${fallbackItems.length}`);
      }
    } catch (error) {
      warnings.push(`fallback_failed:sina_kline_d:${(error as Error).message}`);
    }
  }
  if (items.length === 0) warnings.push("empty_daily_kline");
  return {
    code,
    period,
    count,
    items,
    source: sourceMeta(sourceProvider, {
      referenceUrl: providerReferenceUrl(sourceProvider, {
        code,
        count,
        startDate: input.startDate,
        endDate: input.endDate,
      }),
      marketTime: items[items.length - 1]?.date,
      stale: items.length === 0,
      warnings,
    }),
  };
}

export async function marketIndices(
  userId: string | null = null,
): Promise<{ items: MarketIndexQuote[]; warnings: string[] }> {
  const provider: ProviderName = "tencent_indices";
  let indices: Awaited<ReturnType<typeof getMarketIndex>> = [];
  const warnings: string[] = [];
  let sourceProvider: ProviderName = provider;
  let primaryOk = false;
  try {
    indices = await withSourceEvent(provider, userId, () => getMarketIndex());
    primaryOk = true;
  } catch (error) {
    warnings.push(`primary_failed:tencent_indices:${(error as Error).message}`);
  }
  if (primaryOk && indices.length > 0) {
    const degraded = await crossCheckIndices(indices, userId);
    warnings.push(...degraded);
  }
  if (indices.length === 0) {
    try {
      const fallbackIndices = await withSourceEvent("sina_indices", userId, () => getSinaMarketIndex());
      if (fallbackIndices.length > 0) {
        indices = fallbackIndices;
        sourceProvider = "sina_indices";
        warnings.push(`fallback_used:sina_indices:${fallbackIndices.length}`);
      }
    } catch (error) {
      warnings.push(`fallback_failed:sina_indices:${(error as Error).message}`);
    }
  }
  if (indices.length === 0) warnings.push("empty_indices");
  return {
    items: indices.map((index) => ({
      ...index,
      source: sourceMeta(sourceProvider, {
        referenceUrl: providerReferenceUrl(sourceProvider),
        stale: false,
        warnings,
      }),
    })),
    warnings,
  };
}

async function crossCheckIndices(
  primaryIndices: Awaited<ReturnType<typeof getMarketIndex>>,
  userId: string | null,
): Promise<string[]> {
  const warnings: string[] = [];
  try {
    const fallbackIndices = await withSourceEvent("sina_indices", userId, () => getSinaMarketIndex());
    const fallbackByCode = new Map(fallbackIndices.map((item) => [normalizeCode(item.code), item]));
    for (const primary of primaryIndices) {
      const code = normalizeCode(primary.code);
      const fallback = fallbackByCode.get(code);
      if (!fallback || !primary.price || !fallback.price) continue;
      const diffRatio = Math.abs(primary.price - fallback.price) / Math.max(primary.price, fallback.price);
      if (diffRatio > INDEX_CROSS_CHECK_THRESHOLD) {
        const message = `cross_check_degraded:index:${code}:${(diffRatio * 100).toFixed(2)}%`;
        warnings.push(message);
        await recordSourceDegraded("tencent_indices", userId, message, {
          code,
          primaryPrice: primary.price,
          fallbackPrice: fallback.price,
          fallbackProvider: "sina_indices",
          threshold: INDEX_CROSS_CHECK_THRESHOLD,
        });
      }
    }
  } catch (error) {
    warnings.push(`cross_check_failed:sina_indices:${(error as Error).message}`);
  }
  return warnings;
}

export async function marketCapitalFlow(
  codes: string[],
  userId: string | null = null,
): Promise<{ items: MarketCapitalFlow[]; warnings: string[] }> {
  const uniqueCodes = normalizeCodes(codes);
  if (uniqueCodes.length === 0) return { items: [], warnings: ["empty_codes"] };
  const provider: ProviderName = "eastmoney_flow";
  const map = await withSourceEvent(provider, userId, () => getCapitalFlowBatch(uniqueCodes));
  const items = [...map.values()].map((flow) => ({
    ...flow,
    source: sourceMeta(provider, {
      referenceUrl: providerReferenceUrl(provider, { code: flow.stockCode }),
      marketTime: flow.updatedAt ? String(flow.updatedAt) : undefined,
      stale: !flow.updatedAt,
      warnings: ["capital_flow_is_observation_not_main_force_proof"],
    }),
  }));
  const foundCodes = new Set(items.map((item) => item.stockCode));
  const missing = uniqueCodes.filter((code) => !foundCodes.has(code.replace(/^(sh|sz|SH|SZ)/, "")));
  return {
    items,
    warnings: missing.length ? [`missing_capital_flow:${missing.join(",")}`] : [],
  };
}

export async function marketSectorTheme(
  codes: string[],
  userId: string | null = null,
): Promise<{ items: MarketSectorTheme[]; warnings: string[] }> {
  const uniqueCodes = normalizeCodes(codes);
  if (uniqueCodes.length === 0) return { items: [], warnings: ["empty_codes"] };
  const warnings: string[] = [];
  const items: MarketSectorTheme[] = [];
  await Promise.all(uniqueCodes.map(async (code) => {
    try {
      const result = await withSourceEvent("eastmoney_sector_theme", userId, () => getStockSectorTheme(code));
      if (!result) {
        warnings.push(`missing_sector_theme:${code}`);
        return;
      }
      items.push({
        ...result,
        source: sourceMeta("eastmoney_sector_theme", {
          referenceUrl: providerReferenceUrl("eastmoney_sector_theme", { code }),
          marketTime: result.updatedAt,
          stale: false,
          warnings: ["sector_theme_is_classification_not_investment_conclusion"],
        }),
      });
    } catch (error) {
      warnings.push(`sector_theme_failed:${code}:${(error as Error).message}`);
    }
  }));
  items.sort((a, b) => a.stockCode.localeCompare(b.stockCode));
  return { items, warnings };
}

export async function marketStockInfo(
  stocks: Array<{ code: string; name?: string }>,
  options: { days?: number; targetDate?: string } = {},
  userId: string | null = null,
): Promise<{ items: MarketStockInfo[]; warnings: string[] }> {
  const days = Math.max(1, Math.min(Number(options.days || 7), 90));
  const warnings: string[] = [];
  const items: MarketStockInfo[] = [];
  const normalized = stocks
    .map((item) => ({ code: normalizeCode(item.code), name: item.name || normalizeCode(item.code) }))
    .filter((item) => item.code);
  await Promise.all(normalized.map(async (stock) => {
    try {
      const [news, reports, announcements] = await Promise.all([
        withSourceEvent("eastmoney_stock_news", userId, () => getStockNews(stock.name, stock.code, days)),
        withSourceEvent("eastmoney_stock_reports", userId, () => getStockReports(stock.code, days, options.targetDate)),
        withSourceEvent("cninfo_announcements", userId, () => getStockAnnouncements(stock.code, days, stock.name, options.targetDate)),
      ]);
      if (news.length === 0 && reports.length === 0 && announcements.length === 0) {
        warnings.push(`empty_stock_info:${stock.code}`);
      }
      items.push({
        code: stock.code,
        name: stock.name,
        news,
        reports,
        announcements,
        source: sourceMeta("cninfo_announcements", {
          referenceUrl: providerReferenceUrl("cninfo_announcements", { code: stock.code }),
          warnings: [
            "announcements_are_primary_but_require_manual_review_for_materiality",
            "news_and_reports_are_secondary_evidence",
          ],
        }),
      });
    } catch (error) {
      warnings.push(`stock_info_failed:${stock.code}:${(error as Error).message}`);
    }
  }));
  items.sort((a, b) => a.code.localeCompare(b.code));
  return { items, warnings };
}

export async function marketResolve(
  keyword: string,
  userId: string | null = null,
) {
  const provider: ProviderName = "tencent_search";
  const meta = sourceMeta(provider);
  const trimmed = keyword.trim();
  if (!trimmed) return { items: [], warnings: ["empty_keyword"], source: meta };
  const items = await withSourceEvent(provider, userId, () => searchStock(trimmed));
  return {
    items,
    warnings: items.length === 0 ? ["empty_resolve_result"] : [],
    source: meta,
  };
}

export async function marketCalendar(
  date: Date = new Date(),
  userId: string | null = null,
): Promise<MarketCalendarReport> {
  return withSourceEvent("service_calendar_cn_ashare", userId, async () => ashareCalendarReport(date));
}

/**
 * 健康检查:同步从内存 endpointStats 返回,不再做主动探测。
 * 进程冷启动后短期内 endpoints 列表可能为空——属于预期,因为 ondemand 调用会逐步填充。
 */
export async function marketHealth(): Promise<MarketHealthReport> {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    capabilities: MARKET_DATA_CAPABILITIES,
    endpoints: snapshotEndpointStats().map((stat) => ({
      provider: stat.provider,
      runtimeProvider: stat.runtimeProvider,
      endpoint: stat.endpoint,
      confidence: stat.confidence,
      evidenceLevel: getProvider(stat.provider).evidenceLevel,
      usageBoundary: getProvider(stat.provider).usageBoundary,
      consecutiveFailures: stat.consecutiveFailures,
      totalCalls: stat.totalCalls,
      totalFailures: stat.totalFailures,
      lastSuccessAt: stat.lastSuccessAt,
      lastFailureAt: stat.lastFailureAt,
      lastStatus: stat.lastStatus,
      lastError: stat.lastError,
      recentLatencyP95: percentile(stat.recentLatencies, 0.95),
    })),
  };
}

export async function marketSnapshot(input: {
  userId: string;
  instanceId: string;
  includeCapitalFlow?: boolean;
}): Promise<MarketSnapshot> {
  const [holdingsRaw, watchlistRaw, plansRaw, indicesResult] = await Promise.all([
    portfolioBackend.listActive(input.userId, input.instanceId),
    watchlistBackend.list(input.userId, input.instanceId),
    planBackend.list(input.userId, input.instanceId),
    marketIndices(input.userId).catch((error) => ({ items: [], warnings: [`indices_failed:${(error as Error).message}`] })),
  ]);

  const codes = normalizeCodes([
    ...holdingsRaw.map((item) => item.code),
    ...watchlistRaw.map((item) => item.code),
    ...plansRaw.map((item) => item.code),
  ]);
  const quoteResult = await marketQuote(codes, input.userId).catch((error) => ({ items: [], warnings: [`quotes_failed:${(error as Error).message}`] }));
  const quoteMap = new Map(quoteResult.items.map((quote) => [normalizeCode(quote.code), quote]));

  const capitalResult = input.includeCapitalFlow
    ? await marketCapitalFlow(codes, input.userId).catch((error) => ({ items: [], warnings: [`capital_flow_failed:${(error as Error).message}`] }))
    : undefined;

  return {
    ok: true,
    userId: input.userId,
    instanceId: input.instanceId,
    updatedAt: new Date().toISOString(),
    holdings: holdingsRaw.map((item) => ({
      stockCode: item.code,
      stockName: item.name,
      quote: quoteMap.get(normalizeCode(item.code)),
    })),
    watchlist: watchlistRaw.map((item) => ({
      stockCode: item.code,
      stockName: item.name,
      quote: quoteMap.get(normalizeCode(item.code)),
    })),
    plans: plansRaw.map((item) => ({
      stockCode: item.code,
      stockName: item.name,
      support: item.support,
      resistance: item.resistance,
      targetPrice: item.targetPrice,
      stopLoss: item.stopLoss,
      quote: quoteMap.get(normalizeCode(item.code)),
    })),
    indices: indicesResult.items,
    capitalFlows: capitalResult?.items,
    warnings: [
      ...quoteResult.warnings,
      ...indicesResult.warnings,
      ...(capitalResult?.warnings ?? []),
    ],
  };
}

function normalizeCodes(codes: string[]) {
  return [...new Set(codes.map(normalizeCode).filter(Boolean))];
}

function normalizeCode(code: string) {
  return String(code || "").trim().replace(/^(sh|sz|SH|SZ)/, "").replace(/\.(sh|sz|SH|SZ)$/, "");
}

function boundedCount(value: number | undefined, max: number) {
  const count = Number(value || 120);
  if (!Number.isFinite(count) || count <= 0) return 120;
  return Math.min(Math.floor(count), max);
}
