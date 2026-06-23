import { logger } from "../lib/logger.js";

// 股票代码格式化：纯数字 → 带市场前缀
function formatCode(code: string): string {
  const pure = code.replace(/^(sh|sz|SH|SZ)/, "");
  if (pure.startsWith("6") || pure.startsWith("5")) return `sh${pure}`;
  return `sz${pure}`;
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
  const market = prefix.startsWith("sh") ? 1 : 0;
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
