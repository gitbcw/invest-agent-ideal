import { searchStock } from "./stock.js";

export interface StockRef {
  code?: string;
  name?: string;
  /** 每股成本价(单价);可选,用于 portfolio 浮亏计算 */
  costPrice?: number;
}

export interface ResolvedStockRef {
  input: StockRef;
  code: string;
  name: string;
  confidence: "high" | "medium";
  candidates: Array<{ code: string; name: string }>;
}

export async function resolveStockRefs(refs: StockRef[]): Promise<{ codes: string[]; unresolved: StockRef[] }> {
  const resolved = await resolveStockRefDetails(refs);
  return {
    codes: Array.from(new Set(resolved.resolved.map((item) => item.code))),
    unresolved: resolved.unresolved,
  };
}

export async function resolveStockRefDetails(refs: StockRef[]): Promise<{ resolved: ResolvedStockRef[]; unresolved: StockRef[] }> {
  const resolved: ResolvedStockRef[] = [];
  const codes: string[] = [];
  const unresolved: StockRef[] = [];

  for (const ref of refs) {
    if (ref.code && /^\d{6}$/.test(ref.code)) {
      if (!codes.includes(ref.code)) {
        codes.push(ref.code);
        resolved.push({
          input: ref,
          code: ref.code,
          name: ref.name || ref.code,
          confidence: "high",
          candidates: [{ code: ref.code, name: ref.name || ref.code }],
        });
      }
      continue;
    }

    if (!ref.name) {
      unresolved.push(ref);
      continue;
    }

    // 优先用东方财富搜索（更准确），fallback 腾讯 smartbox
    const results = await searchStockByEastMoney(ref.name);
    const fallback = results.length === 0 ? await searchStock(ref.name) : [];

    const all = results.length > 0 ? results : fallback;
    const matched =
      all.find((item) => item.name === ref.name && /^\d{6}$/.test(item.code)) ??
      all.find((item) => item.name.includes(ref.name!) && /^\d{6}$/.test(item.code));

    if (matched) {
      if (!codes.includes(matched.code)) {
        codes.push(matched.code);
        resolved.push({
          input: ref,
          code: matched.code,
          name: matched.name,
          confidence: matched.name === ref.name ? "high" : "medium",
          candidates: all.filter((item) => /^\d{6}$/.test(item.code)).slice(0, 5),
        });
      }
    } else {
      unresolved.push(ref);
    }
  }

  return { resolved, unresolved };
}

/** 东方财富股票搜索（更准确、支持更名后查询） */
async function searchStockByEastMoney(keyword: string): Promise<Array<{ code: string; name: string }>> {
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=5`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://so.eastmoney.com/",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as {
      QuotationCodeTable?: { Data?: Array<{ Code?: string; Name?: string; SecurityTypeName?: string }> };
    };

    const list = json?.QuotationCodeTable?.Data;
    if (!Array.isArray(list)) return [];

    return list
      .filter((item) => item.SecurityTypeName === "深A" || item.SecurityTypeName === "沪A")
      .map((item) => ({ code: item.Code ?? "", name: item.Name ?? "" }));
  } catch {
    return [];
  }
}
