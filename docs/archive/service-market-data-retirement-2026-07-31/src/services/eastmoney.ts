import { logger } from "../lib/logger.js";

const BASE_URL = "https://emdatah5.eastmoney.com/dc/ZJLX/getZJLXData";

export interface CapitalFlow {
  stockCode: string;
  stockName: string;
  mainInflow: number;
  mainOutflow: number;
  mainNetInflow: number;
  superLargeNetInflow: number;
  largeNetInflow: number;
  mediumNetInflow: number;
  smallNetInflow: number;
  updatedAt: number;
}

function toSecid(code: string): string {
  if (code.startsWith("6")) return `1.${code}`;
  return `0.${code}`;
}

export async function getCapitalFlow(code: string): Promise<CapitalFlow | null> {
  const secid = toSecid(code);
  const url = `${BASE_URL}?secid=${secid}&fields=f57,f58,f135,f136,f140,f143,f146,f149,f86`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://data.eastmoney.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`东方财富 API HTTP ${res.status}: ${code}`);
      return null;
    }

    const json = (await res.json()) as { data?: Record<string, unknown> };
    const d = json.data;
    if (!d || !d.f57) return null;

    const mainInflow = Number(d.f135) || 0;
    const mainOutflow = Number(d.f136) || 0;

    return {
      stockCode: String(d.f57),
      stockName: String(d.f58),
      mainInflow,
      mainOutflow,
      mainNetInflow: mainInflow - mainOutflow,
      superLargeNetInflow: Number(d.f140) || 0,
      largeNetInflow: Number(d.f143) || 0,
      mediumNetInflow: Number(d.f146) || 0,
      smallNetInflow: Number(d.f149) || 0,
      updatedAt: Number(d.f86) || 0,
    };
  } catch (error) {
    logger.warn(`东方财富资金流获取失败 ${code}: ${(error as Error).message}`);
    return null;
  }
}

export async function getCapitalFlowBatch(codes: string[], concurrency = 5): Promise<Map<string, CapitalFlow>> {
  const results = new Map<string, CapitalFlow>();
  const queue = [...codes];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const code = queue.shift()!;
      const flow = await getCapitalFlow(code);
      if (flow) results.set(code, flow);
    }
  });
  await Promise.all(workers);
  return results;
}

export function formatCapitalFlow(flow: CapitalFlow): string {
  const mainNet = formatMoney(flow.mainNetInflow);
  const superLarge = formatMoney(flow.superLargeNetInflow);
  const large = formatMoney(flow.largeNetInflow);
  return [
    `${flow.stockName}(${flow.stockCode}) 资金流向`,
    `主力净流入: ${mainNet}`,
    `  超大单: ${superLarge}  大单: ${large}`,
    `  主力流入: ${formatMoney(flow.mainInflow)}  流出: ${formatMoney(flow.mainOutflow)}`,
  ].join("\n");
}

function formatMoney(yuan: number): string {
  const abs = Math.abs(yuan);
  const sign = yuan >= 0 ? "+" : "-";
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${abs.toFixed(0)}`;
}
