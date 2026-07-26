/**
 * Optional, service-owned market-data adapters.
 *
 * These functions deliberately expose narrow, typed operations. They are not
 * MCP tools and do not permit callers to submit vendor-specific queries.
 */

import { config } from "../lib/config.js";
import { withSourceEvent } from "./market-data-providers.js";

const TUSHARE_ENDPOINT = "https://api.tushare.pro";
const REQUEST_TIMEOUT_MS = 12_000;

export type ExternalProviderAvailability = {
  provider: "tushare" | "tdx";
  configured: boolean;
  capabilities: string[];
  activation: "env";
};

export type ExternalProviderResult<T> = {
  data: T;
  source: {
    provider: "tushare" | "tdx";
    fetchedAt: string;
    marketDate?: string;
    reportingPeriods?: Record<string, string | null>;
    warnings: string[];
  };
};

export class ExternalProviderError extends Error {
  constructor(
    public readonly code: "not_configured" | "permission_denied" | "rate_limited" | "upstream_error" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "ExternalProviderError";
  }
}

export type TushareDailyBar = {
  tradeDate: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  previousClose: number | null;
  change: number | null;
  percentChange: number | null;
  volume: number | null;
  amount: number | null;
};

export type TushareDailyBasic = {
  tradeDate: string;
  close: number | null;
  turnoverRate: number | null;
  volumeRatio: number | null;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  ps: number | null;
  psTtm: number | null;
  dividendYield: number | null;
  totalMarketValue: number | null;
  circulatingMarketValue: number | null;
};

export type TushareTradeCalendarDay = {
  exchange: string;
  calendarDate: string;
  isOpen: boolean;
  previousTradeDate: string | null;
};

export type TdxFundamentals = {
  code: string;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  revenue: number | null;
  netIncome: number | null;
};

export type IntegratedFundamentals = {
  code: string;
  values: {
    pe: number | null;
    pb: number | null;
    roe: number | null;
    revenue: number | null;
    netIncome: number | null;
    turnoverRate: number | null;
    volumeRatio: number | null;
  };
  sources: ExternalProviderResult<unknown>["source"][];
  warnings: string[];
};

type CacheEntry = { expiresAt: number; value: unknown };
const providerCache = new Map<string, CacheEntry>();
const providerLastCallAt = new Map<string, number>();
const providerInflight = new Map<string, Promise<unknown>>();

/** Merge the optional providers without exposing a vendor-specific query surface. */
export async function integratedFundamentals(input: {
  code: string;
  tradeDate?: string;
  userId?: string | null;
}): Promise<IntegratedFundamentals> {
  const code = normalizeCode(input.code);
  if (!code) throw new ExternalProviderError("invalid_response", "股票代码格式无效");
  const warnings: string[] = [];
  const sources: IntegratedFundamentals["sources"] = [];
  const values: IntegratedFundamentals["values"] = {
    pe: null, pb: null, roe: null, revenue: null, netIncome: null, turnoverRate: null, volumeRatio: null,
  };

  const [tdxResult, basicResult] = await Promise.allSettled([
    config.marketProviders.tdxMcpApiKey
      ? cachedProviderCall(`tdx:fundamentals:${code}`, "tdx:fundamentals", 5 * 60_000, 2_000, () => tdxFundamentals({ code, userId: input.userId }))
      : Promise.resolve(null),
    input.tradeDate && config.marketProviders.tushareToken
      ? cachedProviderCall(`tushare:daily_basic:${code}:${input.tradeDate}`, "tushare:daily_basic", 60 * 60_000, 60 * 60_000, () => tushareDailyBasic({ code, tradeDate: input.tradeDate!, userId: input.userId }))
      : Promise.resolve(null),
  ]);

  if (tdxResult.status === "fulfilled" && tdxResult.value) {
    const result = tdxResult.value;
    values.pe = result.data.pe; values.pb = result.data.pb; values.roe = result.data.roe;
    values.revenue = result.data.revenue; values.netIncome = result.data.netIncome;
    sources.push(result.source);
    warnings.push(...result.source.warnings);
  } else if (tdxResult.status === "rejected") warnings.push(providerWarning("tdx", tdxResult.reason));
  else warnings.push("tdx:not_configured");
  if (basicResult.status === "fulfilled" && basicResult.value) {
    const result = basicResult.value;
    values.pe ??= result.data?.pe ?? null; values.pb ??= result.data?.pb ?? null;
    values.turnoverRate = result.data?.turnoverRate ?? null; values.volumeRatio = result.data?.volumeRatio ?? null;
    sources.push(result.source); warnings.push(...result.source.warnings);
  } else if (input.tradeDate && basicResult.status === "rejected") warnings.push(providerWarning("tushare", basicResult.reason));
  if (!config.marketProviders.tushareToken) warnings.push("tushare:not_configured");
  else if (!input.tradeDate) warnings.push("tushare_daily_basic_requires_trade_date");
  if (sources.length === 0) warnings.push("no_external_fundamentals_source_available");
  return { code, values, sources, warnings: [...new Set(warnings)] };
}

async function cachedProviderCall<T>(cacheKey: string, rateKey: string, ttlMs: number, minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value as T;
  const inflight = providerInflight.get(cacheKey);
  if (inflight) return inflight as Promise<T>;
  const lastCallAt = providerLastCallAt.get(rateKey) ?? 0;
  if (now - lastCallAt < minIntervalMs) throw new ExternalProviderError("rate_limited", "服务层调用间隔限制");
  providerLastCallAt.set(rateKey, now);
  const request = fn().then((value) => {
    providerCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    return value;
  }).finally(() => providerInflight.delete(cacheKey));
  providerInflight.set(cacheKey, request);
  return request;
}

function providerWarning(provider: string, reason: unknown): string {
  const code = reason instanceof ExternalProviderError ? reason.code : "upstream_error";
  return `${provider}:${code}`;
}

export function externalProviderAvailability(): ExternalProviderAvailability[] {
  return [
    {
      provider: "tushare",
      configured: Boolean(config.marketProviders.tushareToken),
      capabilities: ["daily", "daily_basic", "trade_cal"],
      activation: "env",
    },
    {
      provider: "tdx",
      configured: Boolean(config.marketProviders.tdxMcpApiKey),
      capabilities: ["fixed_prompt_fundamentals"],
      activation: "env",
    },
  ];
}

export async function tushareDailyBars(input: {
  code: string;
  startDate: string;
  endDate: string;
  userId?: string | null;
}): Promise<ExternalProviderResult<TushareDailyBar[]>> {
  const result = await withSourceEvent("tushare_daily", input.userId ?? null, () =>
    tushareCall("daily", { ts_code: toTsCode(input.code), start_date: input.startDate, end_date: input.endDate }, [
      "trade_date", "open", "high", "low", "close", "pre_close", "change", "pct_chg", "vol", "amount",
    ]),
  );
  const data = result.rows.map((row) => ({
    tradeDate: text(row.trade_date), open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low),
    close: numberOrNull(row.close), previousClose: numberOrNull(row.pre_close), change: numberOrNull(row.change),
    percentChange: numberOrNull(row.pct_chg), volume: numberOrNull(row.vol), amount: numberOrNull(row.amount),
  }));
  return {
    data,
    source: {
      provider: "tushare",
      fetchedAt: new Date().toISOString(),
      marketDate: data[0]?.tradeDate,
      warnings: ["daily_bars_are_unadjusted"],
    },
  };
}

export async function tushareDailyBasic(input: {
  code: string;
  tradeDate: string;
  userId?: string | null;
}): Promise<ExternalProviderResult<TushareDailyBasic | null>> {
  const result = await withSourceEvent("tushare_daily_basic", input.userId ?? null, () =>
    tushareCall("daily_basic", { ts_code: toTsCode(input.code), trade_date: input.tradeDate }, [
      "trade_date", "close", "turnover_rate", "volume_ratio", "pe", "pe_ttm", "pb", "ps", "ps_ttm", "dv_ratio", "total_mv", "circ_mv",
    ]),
  );
  const row = result.rows[0];
  const data = row ? {
    tradeDate: text(row.trade_date), close: numberOrNull(row.close), turnoverRate: numberOrNull(row.turnover_rate),
    volumeRatio: numberOrNull(row.volume_ratio), pe: numberOrNull(row.pe), peTtm: numberOrNull(row.pe_ttm),
    pb: numberOrNull(row.pb), ps: numberOrNull(row.ps), psTtm: numberOrNull(row.ps_ttm), dividendYield: numberOrNull(row.dv_ratio),
    totalMarketValue: numberOrNull(row.total_mv), circulatingMarketValue: numberOrNull(row.circ_mv),
  } : null;
  return {
    data,
    source: {
      provider: "tushare",
      fetchedAt: new Date().toISOString(),
      marketDate: input.tradeDate,
      warnings: data ? ["market_value_unit_is_10k_cny", "ratios_are_percent_except_valuation_multiples"] : ["empty_result"],
    },
  };
}

export async function tushareTradeCalendar(input: {
  startDate: string;
  endDate: string;
  exchange?: string;
  userId?: string | null;
}): Promise<ExternalProviderResult<TushareTradeCalendarDay[]>> {
  const result = await withSourceEvent("tushare_trade_cal", input.userId ?? null, () =>
    tushareCall("trade_cal", {
      exchange: input.exchange ?? "SSE", start_date: input.startDate, end_date: input.endDate,
    }, ["exchange", "cal_date", "is_open", "pretrade_date"]),
  );
  const data = result.rows.map((row) => ({
    exchange: text(row.exchange), calendarDate: text(row.cal_date), isOpen: String(row.is_open) === "1",
    previousTradeDate: nullableText(row.pretrade_date),
  }));
  return {
    data,
    source: { provider: "tushare", fetchedAt: new Date().toISOString(), marketDate: input.endDate, warnings: [] },
  };
}

export async function tdxFundamentals(input: {
  code: string;
  userId?: string | null;
}): Promise<ExternalProviderResult<TdxFundamentals>> {
  const code = normalizeCode(input.code);
  if (!code) throw new ExternalProviderError("invalid_response", "TDX 股票代码不能为空");
  return withSourceEvent("tdx_mcp_fundamentals", input.userId ?? null, async () => {
    const result = await callTdxMcp(config.marketProviders.tdxMcpFundamentalsTool, {
      question: `${code}最新PE、PB、ROE、营业收入和归母净利润`, range: "AG", page: "1", size: "10",
    });
    const row = result.rows[0];
    if (!row) throw new ExternalProviderError("invalid_response", "TDX 未返回结构化基本面字段");
    const peHeader = findHeader(result.headers, ["PE", "市盈率", "市盈("]);
    const pbHeader = findHeader(result.headers, ["PB", "市净率"]);
    const roeHeader = findHeader(result.headers, ["ROE", "净资产收益率"]);
    const revenueHeader = findHeader(result.headers, ["营业收入(元)", "营收"]);
    const netIncomeHeader = findHeader(result.headers, ["归属于母公司所有者的净利润", "归母净利润"]);
    const reportingPeriods = {
      pe: periodFromHeader(peHeader), pb: periodFromHeader(pbHeader), roe: periodFromHeader(roeHeader),
      revenue: periodFromHeader(revenueHeader), netIncome: periodFromHeader(netIncomeHeader),
    };
    const warnings = Object.values(reportingPeriods).some((period) => !period) ? ["some_fields_missing_reporting_period"] : [];
    return {
      data: {
        code,
        pe: valueAtHeader(row, peHeader), pb: valueAtHeader(row, pbHeader), roe: valueAtHeader(row, roeHeader),
        revenue: valueAtHeader(row, revenueHeader), netIncome: valueAtHeader(row, netIncomeHeader),
      },
      source: { provider: "tdx", fetchedAt: new Date().toISOString(), reportingPeriods, warnings },
    };
  });
}

type TushareResult = { rows: Array<Record<string, unknown>> };

async function tushareCall(apiName: string, params: Record<string, string>, fields: string[]): Promise<TushareResult> {
  const token = config.marketProviders.tushareToken;
  if (!token) throw new ExternalProviderError("not_configured", "Tushare 未配置");
  let response: Response;
  try {
    response = await fetch(TUSHARE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ api_name: apiName, token, params, fields: fields.join(",") }),
    });
  } catch (error) {
    throw new ExternalProviderError("upstream_error", `Tushare 请求失败: ${(error as Error).message}`);
  }
  if (!response.ok) throw new ExternalProviderError("upstream_error", `Tushare HTTP ${response.status}`);
  const payload = await response.json() as { code?: unknown; msg?: unknown; data?: { fields?: unknown; items?: unknown } };
  const code = Number(payload.code ?? -1);
  if (code !== 0) throw classifyTushareError(code, String(payload.msg ?? "未知错误"));
  const resultFields = Array.isArray(payload.data?.fields) ? payload.data.fields.map(String) : [];
  const items = Array.isArray(payload.data?.items) ? payload.data.items : [];
  if (!resultFields.length) throw new ExternalProviderError("invalid_response", "Tushare 返回缺少字段定义");
  return { rows: items.map((item) => rowFromArray(resultFields, item)) };
}

function classifyTushareError(code: number, message: string): ExternalProviderError {
  if (/频率|rate|limit/i.test(message)) return new ExternalProviderError("rate_limited", `Tushare 限流 (${code})`);
  if (code === 40203 || /权限|permission/i.test(message)) return new ExternalProviderError("permission_denied", `Tushare 权限不足 (${code})`);
  return new ExternalProviderError("upstream_error", `Tushare 上游错误 (${code})`);
}

async function callTdxMcp(toolName: string, args: Record<string, unknown>): Promise<{ headers: string[]; rows: Array<Record<string, unknown>> }> {
  const apiKey = config.marketProviders.tdxMcpApiKey;
  if (!apiKey) throw new ExternalProviderError("not_configured", "TDX MCP 未配置");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "tdx-api-key": apiKey,
  };
  const initialized = await mcpPost({ method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "invest-agent", version: "1.0" } } }, headers);
  const sessionId = initialized.headers.get("mcp-session-id");
  const response = await mcpPost({ method: "tools/call", params: { name: toolName, arguments: args } }, {
    ...headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });
  const payload = await readMcpPayload(response);
  const structured = payload?.result?.structuredContent;
  const rawHeaders = Array.isArray(structured?.headers) ? structured.headers.map(String) : [];
  const data: unknown[] = Array.isArray(structured?.data) ? structured.data as unknown[] : [];
  if (!rawHeaders.length || !data.length) throw new ExternalProviderError("invalid_response", "TDX 未返回可校验的 structuredContent");
  return { headers: rawHeaders, rows: data.map((item) => rowFromArray(rawHeaders, item)) };
}

async function mcpPost(body: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(config.marketProviders.tdxMcpUrl, { method: "POST", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), ...body }) });
  } catch (error) {
    throw new ExternalProviderError("upstream_error", `TDX MCP 请求失败: ${(error as Error).message}`);
  }
  if (!response.ok) throw new ExternalProviderError("upstream_error", `TDX MCP HTTP ${response.status}`);
  return response;
}

async function readMcpPayload(response: Response): Promise<Record<string, any> | null> {
  const raw = await response.text();
  const jsonLine = raw.split("\n").map((line) => line.replace(/^data:\s*/, "").trim()).find((line) => line.startsWith("{"));
  if (!jsonLine) throw new ExternalProviderError("invalid_response", "TDX MCP 返回为空");
  try {
    return JSON.parse(jsonLine) as Record<string, any>;
  } catch {
    throw new ExternalProviderError("invalid_response", "TDX MCP 返回不是 JSON");
  }
}

function rowFromArray(fields: string[], raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw)) return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  return Object.fromEntries(fields.map((field, index) => [field, raw[index]]));
}

function normalizeCode(value: string): string { return value.replace(/[^0-9]/g, "").slice(0, 6); }
function toTsCode(code: string): string {
  const normalized = normalizeCode(code);
  if (!normalized) throw new ExternalProviderError("invalid_response", "股票代码格式无效");
  if (normalized.startsWith("8") || normalized.startsWith("4")) return `${normalized}.BJ`;
  return `${normalized}.${normalized.startsWith("6") || normalized.startsWith("5") ? "SH" : "SZ"}`;
}
function text(value: unknown): string { return value === null || value === undefined ? "" : String(value); }
function nullableText(value: unknown): string | null { const result = text(value); return result ? result : null; }
function numberOrNull(value: unknown): number | null { const result = Number(value); return Number.isFinite(result) ? result : null; }
function findHeader(headers: string[], candidates: string[]): string | undefined {
  return headers.find((item) => candidates.some((candidate) => item.toUpperCase().includes(candidate.toUpperCase())));
}
function valueAtHeader(row: Record<string, unknown>, header: string | undefined): number | null {
  return header ? numberOrNull(row[header]) : null;
}
function periodFromHeader(header: string | undefined): string | null {
  const match = header?.match(/(20\d{2})[.\-/](\d{2})[.\-/](\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
