import { logger } from "../lib/logger.js";

// 股票代码格式化：纯数字 → 带市场前缀
function formatCode(code: string): string {
  const trimmed = code.trim();
  const explicitPrefix = trimmed.match(/^(sh|sz)(\d{6})$/i);
  if (explicitPrefix) return `${explicitPrefix[1].toLowerCase()}${explicitPrefix[2]}`;
  const explicitSuffix = trimmed.match(/^(\d{6})\.(sh|sz)$/i);
  if (explicitSuffix) return `${explicitSuffix[2].toLowerCase()}${explicitSuffix[1]}`;
  const pure = pureCode(trimmed);
  if (pure.startsWith("6") || pure.startsWith("5")) return `sh${pure}`;
  return `sz${pure}`;
}

function pureCode(code: string): string {
  return code.replace(/^(sh|sz|SH|SZ)/, "").replace(/\.(sh|sz|SH|SZ)$/, "");
}

/** 实时行情数据 */
export interface StockQuote {
  code: string;
  name: string;
  price: number;
  yesterdayClose: number;
  open: number;
  volume: number; // 手
  amount: number; // 万元
  high: number;
  low: number;
  change: number;
  changePercent: number;
  turnoverRate: number;
  time: string;
  bidVolume?: number; // 五档买盘量，手
  askVolume?: number; // 五档卖盘量，手
  bidAskImbalance?: number; // (买盘量-卖盘量)/(买盘量+卖盘量)，仅作盘口观察
}

/** 历史K线数据 */
export interface StockKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

/**
 * 获取实时行情（腾讯 API）
 * 支持单只或多只，逗号分隔
 */
export async function getQuote(codes: string[]): Promise<StockQuote[]> {
  const formatted = codes.map(formatCode);
  const url = `https://qt.gtimg.cn/q=${formatted.join(",")}&_=${Date.now()}`;

  const response = await fetch(url, {
    headers: { Referer: "https://finance.qq.com" },
  });
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());

  const results: StockQuote[] = [];
  const lines = text.trim().split(";").filter(Boolean);

  for (const line of lines) {
    try {
      const match = line.match(/"(.+)"/);
      if (!match) continue;

      const fields = match[1].split("~");
      if (fields.length < 38) continue;
      const bidVolume = [10, 12, 14, 16, 18]
        .map((index) => parseInt(fields[index]) || 0)
        .reduce((sum, value) => sum + value, 0);
      const askVolume = [20, 22, 24, 26, 28]
        .map((index) => parseInt(fields[index]) || 0)
        .reduce((sum, value) => sum + value, 0);
      const bidAskTotal = bidVolume + askVolume;

      results.push({
        code: fields[2],
        name: fields[1],
        price: parseFloat(fields[3]) || 0,
        yesterdayClose: parseFloat(fields[4]) || 0,
        open: parseFloat(fields[5]) || 0,
        volume: parseInt(fields[6]) || 0,
        amount: parseFloat(fields[37]) || 0,
        high: parseFloat(fields[33]) || 0,
        low: parseFloat(fields[34]) || 0,
        change: parseFloat(fields[31]) || 0,
        changePercent: parseFloat(fields[32]) || 0,
        turnoverRate: parseFloat(fields[38]) || 0,
        time: fields[30] || "",
        bidVolume,
        askVolume,
        bidAskImbalance: bidAskTotal > 0 ? (bidVolume - askVolume) / bidAskTotal : undefined,
      });
    } catch {
      logger.warn(`解析行情数据失败: ${line.slice(0, 50)}`);
    }
  }

  return results;
}

/** 获取实时行情（新浪 fallback API） */
export async function getSinaQuote(codes: string[]): Promise<StockQuote[]> {
  const formatted = codes.map(formatCode);
  const url = `https://hq.sinajs.cn/rn=${Date.now()}&list=${formatted.join(",")}`;

  const response = await fetch(url, {
    headers: { Referer: "https://finance.sina.com.cn" },
    signal: AbortSignal.timeout(8000),
  });
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());
  const results: StockQuote[] = [];
  const lines = text.trim().split(";").filter(Boolean);

  for (const line of lines) {
    try {
      const codeMatch = line.match(/hq_str_(sh|sz)(\d{6})=/i);
      const valueMatch = line.match(/"([^"]*)"/);
      if (!codeMatch || !valueMatch) continue;
      const fields = valueMatch[1].split(",");
      if (fields.length < 32 || !fields[0]) continue;
      const yesterdayClose = parseFloat(fields[2]) || 0;
      const price = parseFloat(fields[3]) || 0;
      const change = price && yesterdayClose ? price - yesterdayClose : 0;
      const bidVolume = [10, 12, 14, 16, 18]
        .map((index) => parseFloat(fields[index]) || 0)
        .reduce((sum, value) => sum + value, 0);
      const askVolume = [20, 22, 24, 26, 28]
        .map((index) => parseFloat(fields[index]) || 0)
        .reduce((sum, value) => sum + value, 0);
      const bidAskTotal = bidVolume + askVolume;
      results.push({
        code: codeMatch[2],
        name: fields[0],
        price,
        yesterdayClose,
        open: parseFloat(fields[1]) || 0,
        volume: Math.round((parseFloat(fields[8]) || 0) / 100),
        amount: (parseFloat(fields[9]) || 0) / 10000,
        high: parseFloat(fields[4]) || 0,
        low: parseFloat(fields[5]) || 0,
        change,
        changePercent: yesterdayClose ? (change / yesterdayClose) * 100 : 0,
        turnoverRate: 0,
        time: [fields[30], fields[31]].filter(Boolean).join(" "),
        bidVolume,
        askVolume,
        bidAskImbalance: bidAskTotal > 0 ? (bidVolume - askVolume) / bidAskTotal : undefined,
      });
    } catch {
      logger.warn(`解析新浪行情数据失败: ${line.slice(0, 50)}`);
    }
  }

  return results;
}

/**
 * 获取历史日K线（腾讯 API）
 * @param code 股票代码
 * @param count 返回条数
 * @param startDate 起始日期（可选，格式 YYYY-MM-DD）
 * @param endDate 结束日期（可选，格式 YYYY-MM-DD）
 */
export async function getKline(
  code: string,
  count = 250,
  startDate?: string,
  endDate?: string,
): Promise<StockKline[]> {
  const prefix = formatCode(code);
  const start = startDate ? startDate.replace(/-/g, "-") : "";
  const end = endDate ? endDate.replace(/-/g, "-") : "";
  // 腾讯日K线接口 param 格式: {prefix},day,{startDate},{endDate},{count},qfq
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix},day,${start},${end},${count},qfq`;

  const response = await fetch(url);
  const data = (await response.json()) as {
    data: Record<
      string,
      {
        day?: string[][];
        qfqday?: string[][];
      }
    >;
  };

  const stockData = data.data?.[prefix];
  const rawKlines = stockData?.qfqday || stockData?.day || [];

  return rawKlines.map((k) => ({
    date: k[0],
    open: parseFloat(k[1]) || 0,
    close: parseFloat(k[2]) || 0,
    high: parseFloat(k[3]) || 0,
    low: parseFloat(k[4]) || 0,
    volume: parseInt(k[5]) || 0,
  }));
}

/** 获取历史日K线（新浪 fallback API,不含复权口径保证） */
export async function getSinaKline(code: string, count = 250): Promise<StockKline[]> {
  const symbol = formatCode(code);
  const limit = Math.max(1, Math.min(Math.floor(count || 120), 500));
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${limit}`;
  const response = await fetch(url, {
    headers: { Referer: "https://finance.sina.com.cn" },
    signal: AbortSignal.timeout(10000),
  });
  const raw = (await response.json()) as Array<{
    day?: string;
    open?: string;
    close?: string;
    high?: string;
    low?: string;
    volume?: string;
  }>;

  return (raw || []).map((k) => ({
    date: String(k.day || "").slice(0, 10),
    open: parseFloat(k.open || "0") || 0,
    close: parseFloat(k.close || "0") || 0,
    high: parseFloat(k.high || "0") || 0,
    low: parseFloat(k.low || "0") || 0,
    volume: parseInt(k.volume || "0") || 0,
  })).filter((item) => item.date);
}

/**
 * 获取5分钟K线（腾讯 API）
 * @param code 股票代码（纯数字，如 002460）
 * @param limit 返回条数
 */
export async function getMinuteKline(code: string, limit = 48): Promise<Array<{ time: string; open: number; close: number; high: number; low: number; volume: number; amount: number }>> {
  const prefix = formatCode(code);
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${prefix},m5,,${limit}`;

  const response = await fetch(url);
  const data = (await response.json()) as {
    data?: Record<string, { m5?: string[][] }>;
  };

  const stockData = data.data?.[prefix];
  const raw = stockData?.m5 ?? [];

  return raw.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]) || 0,
    close: parseFloat(k[2]) || 0,
    high: parseFloat(k[3]) || 0,
    low: parseFloat(k[4]) || 0,
    volume: parseFloat(k[5]) || 0,
    amount: parseFloat(k[6] as string || "0") || 0,
  }));
}

/** 搜索股票（模糊匹配） */
export async function searchStock(keyword: string): Promise<Array<{ code: string; name: string }>> {
  const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(keyword)}&t=all`;

  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());

  const results: Array<{ code: string; name: string }> = [];
  const match = text.match(/"(.+)"/);
  if (!match) return results;

  const entries = match[1].split("^");
  for (const entry of entries) {
    const parts = entry.split("~");
    if (parts.length >= 3) {
      results.push({ code: parts[1], name: parts[2] });
    }
  }

  return results;
}

/** 获取大盘指数概况 */
export async function getMarketIndex(): Promise<Array<{ name: string; code: string; price: number; change: number; changePercent: number; amount: number }>> {
  const codes = ["sh000001", "sz399001", "sz399006", "sh000300"];
  const url = `https://qt.gtimg.cn/q=${codes.join(",")}&_=${Date.now()}`;

  const response = await fetch(url, { headers: { Referer: "https://finance.qq.com" } });
  const text = new TextDecoder("gb18030").decode(await response.arrayBuffer());

  const results: Array<{ name: string; code: string; price: number; change: number; changePercent: number; amount: number }> = [];
  const lines = text.trim().split(";").filter(Boolean);

  for (const line of lines) {
    try {
      const match = line.match(/"(.+)"/);
      if (!match) continue;
      const fields = match[1].split("~");
      if (fields.length < 38) continue;
      results.push({
        name: fields[1],
        code: fields[2],
        price: parseFloat(fields[3]) || 0,
        change: parseFloat(fields[31]) || 0,
        changePercent: parseFloat(fields[32]) || 0,
        amount: parseFloat(fields[37]) || 0,
      });
    } catch {}
  }

  return results;
}

/** 获取大盘指数概况（新浪 fallback API） */
export async function getSinaMarketIndex(): Promise<Array<{ name: string; code: string; price: number; change: number; changePercent: number; amount: number }>> {
  const quoteResult = await getSinaQuote(["sh000001", "sz399001", "sz399006", "sh000300"]);
  const indexNames: Record<string, string> = {
    "000001": "上证指数",
    "399001": "深证成指",
    "399006": "创业板指",
    "000300": "沪深300",
  };
  return quoteResult.map((quote) => {
    const code = pureCode(quote.code);
    return {
      name: indexNames[code] || quote.name,
      code,
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      amount: quote.amount,
    };
  });
}

/** 格式化行情摘要 */
export function formatQuoteSummary(quote: StockQuote): string {
  const direction = quote.change >= 0 ? "涨" : "跌";
  return [
    `${quote.name}(${quote.code})`,
    `现价: ${quote.price} ${direction} ${quote.change} (${quote.changePercent}%)`,
    `今开: ${quote.open} 最高: ${quote.high} 最低: ${quote.low}`,
    `成交量: ${(quote.volume / 10000).toFixed(1)}万手 成交额: ${(quote.amount / 10000).toFixed(2)}亿`,
    `换手率: ${quote.turnoverRate}%`,
    quote.bidAskImbalance == null
      ? "五档盘口: 暂无"
      : `五档盘口: 买盘 ${(quote.bidVolume ?? 0).toFixed(0)}手 / 卖盘 ${(quote.askVolume ?? 0).toFixed(0)}手 / 差值 ${quote.bidAskImbalance.toFixed(2)}（仅作盘口观察）`,
    `时间: ${quote.time}`,
  ].join("\n");
}
