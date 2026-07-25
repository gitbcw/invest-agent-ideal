import { logger } from "../lib/logger.js";
import { resolveStockRefs } from "./stock-resolver.js";

// ─── 类型 ───────────────────────────────────────────────

export interface StockNewsItem {
  title: string;
  content: string;
  date: string;
  source: string;
  url: string;
}

export interface StockReportItem {
  title: string;
  publishDate: string;
  orgName: string;
  rating: string;
  industry: string;
  stockName: string;
}

export interface StockAnnouncementItem {
  title: string;
  date: string;
  secName: string;
}

export interface StockInfo {
  code: string;
  name: string;
  news: StockNewsItem[];
  reports: StockReportItem[];
  announcements: StockAnnouncementItem[];
}

// ─── 新闻源 1：东方财富搜索 API（按名称搜索）────────────

async function getNewsFromSearch(keyword: string, days: number): Promise<StockNewsItem[]> {
  const params = JSON.stringify({
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize: 10,
        preTag: "",
        postTag: "",
      },
    },
  });

  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(params)}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://so.eastmoney.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const text = await res.text();
    const jsonMatch = text.match(/cb\((.*)\)/s);
    if (!jsonMatch) return [];

    const json = JSON.parse(jsonMatch[1]);
    const list = json?.result?.cmsArticleWebOld;
    if (!Array.isArray(list)) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return list
      .filter((item: { date?: string }) => (item.date ?? "").slice(0, 10) >= cutoffStr)
      .map((item: { title?: string; content?: string; date?: string; mediaName?: string; url?: string }) => ({
        title: (item.title ?? "").replace(/<[^>]*>/g, ""),
        content: (item.content ?? "").replace(/<[^>]*>/g, "").slice(0, 200),
        date: (item.date ?? "").slice(0, 10),
        source: item.mediaName ?? "东方财富",
        url: item.url ?? "",
      }));
  } catch (error) {
    logger.warn(`新闻源[搜索]获取失败 ${keyword}: ${(error as Error).message}`);
    return [];
  }
}

// ─── 新闻源 2：东方财富个股新闻 API（按代码精准匹配）────

async function getNewsByCode(code: string, days: number): Promise<StockNewsItem[]> {
  // mTypeAndCode: 0.深圳代码 / 1.上海代码
  const prefix = code.startsWith("6") ? "1" : "0";
  const url = `https://np-listapi.eastmoney.com/comm/wap/getListInfo?client=wap&type=1&mession=1&pageNo=1&pageSize=10&fields1=f1,f2,f3,f4&fields2=f51,f52,f53&mTypeAndCode=${prefix}.${code}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://wap.eastmoney.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as { data?: { list?: unknown[] } };
    const list = json?.data?.list;
    if (!Array.isArray(list)) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    return (list as Record<string, unknown>[])
      .filter((item) => {
        const date = String(item.Art_ShowTime ?? "").slice(0, 10);
        return date >= cutoffStr;
      })
      .map((item) => ({
        title: String(item.Art_Title ?? ""),
        content: "",
        date: String(item.Art_ShowTime ?? "").slice(0, 10),
        source: String(item.Art_MediaName ?? "东方财富"),
        url: String(item.Art_Url ?? ""),
      }));
  } catch (error) {
    logger.warn(`新闻源[个股]获取失败 ${code}: ${(error as Error).message}`);
    return [];
  }
}

// ─── 新闻聚合（多源合并去重）────────────────────────────

export async function getStockNews(keyword: string, code: string, days: number): Promise<StockNewsItem[]> {
  const [searchNews, codeNews] = await Promise.all([
    getNewsFromSearch(keyword, days),
    getNewsByCode(code, days),
  ]);

  // 按标题去重（取标题前20字符做模糊匹配）
  const seen = new Set<string>();
  const merged: StockNewsItem[] = [];

  const all = [...codeNews, ...searchNews]; // 个股新闻优先
  for (const item of all) {
    const key = item.title.slice(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }

  // 按日期降序
  merged.sort((a, b) => b.date.localeCompare(a.date));
  return merged;
}

// ─── 研报（东方财富研报 API）──────────────────────────────

export async function getStockReports(code: string, days: number, targetDate?: string): Promise<StockReportItem[]> {
  const now = targetDate ? new Date(targetDate + "T23:59:59") : new Date();
  const begin = new Date(now);
  begin.setDate(now.getDate() - days);
  const beginTime = begin.toISOString().slice(0, 10).replace(/-/g, "");
  const endTime = now.toISOString().slice(0, 10).replace(/-/g, "");

  const url = `https://reportapi.eastmoney.com/report/list?industryCode=*&pageSize=10&industry=*&rating=*&ratingChange=*&beginTime=${beginTime}&endTime=${endTime}&pageNo=1&fields=&qType=0&orgCode=&code=${code}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://data.eastmoney.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as { data?: unknown[] };
    if (!Array.isArray(json.data)) return [];

    return (json.data as Record<string, unknown>[]).map((item) => ({
      title: String(item.title ?? ""),
      publishDate: String(item.publishDate ?? "").slice(0, 10),
      orgName: String(item.orgSName ?? ""),
      rating: String(item.emRatingName ?? ""),
      industry: String(item.indvInduName ?? ""),
      stockName: String(item.stockName ?? ""),
    }));
  } catch (error) {
    logger.warn(`研报获取失败 ${code}: ${(error as Error).message}`);
    return [];
  }
}

// ─── 公告源 1：巨潮资讯 cninfo ──────────────────────────

async function getAnnouncementsFromCninfo(code: string, days: number, targetDate?: string): Promise<StockAnnouncementItem[]> {
  const prefix = code.startsWith("6") ? "gssh0" : "gssz0";
  const orgId = `${prefix}${code}`;

  const now = targetDate ? new Date(targetDate + "T23:59:59") : new Date();
  const begin = new Date(now);
  begin.setDate(now.getDate() - days);
  const seDate = `${begin.toISOString().slice(0, 10)}~${now.toISOString().slice(0, 10)}`;

  try {
    const res = await fetch("https://www.cninfo.com.cn/new/hisAnnouncement/query", {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.cninfo.com.cn/new/disclosure",
        Origin: "https://www.cninfo.com.cn",
      },
      body: `stock=${code},${orgId}&tabName=fulltext&pageSize=10&pageNum=1&column=&category=&plate=&seDate=${seDate}&searchkey=&secid=&sortName=&sortType=&isHLtitle=true`,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as { announcements?: unknown[] };
    if (!Array.isArray(json.announcements)) return [];

    return (json.announcements as Record<string, unknown>[]).map((item) => ({
      title: String(item.announcementTitle ?? ""),
      date: item.announcementTime
        ? new Date(Number(item.announcementTime)).toISOString().slice(0, 10)
        : "",
      secName: String(item.secName ?? ""),
    }));
  } catch (error) {
    logger.warn(`公告源[cninfo]获取失败 ${code}: ${(error as Error).message}`);
    return [];
  }
}

// ─── 公告源 2：东方财富个股公告 ─────────────────────────

async function getAnnouncementsFromEastMoney(code: string, days: number, targetDate?: string): Promise<StockAnnouncementItem[]> {
  const now = targetDate ? new Date(targetDate + "T23:59:59") : new Date();
  const begin = new Date(now);
  begin.setDate(now.getDate() - days);
  const beginTime = begin.toISOString().slice(0, 10).replace(/-/g, "");
  const endTime = now.toISOString().slice(0, 10).replace(/-/g, "");

  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=10&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0&begin_time=${beginTime}&end_time=${endTime}&stock_list=${code}`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: "https://data.eastmoney.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return [];

    const json = (await res.json()) as { data?: { list?: unknown[] } };
    const list = json?.data?.list;
    if (!Array.isArray(list)) return [];

    return (list as Record<string, unknown>[]).flatMap((item) => {
      const codes = Array.isArray(item.codes) ? item.codes as Record<string, unknown>[] : [];
      const matched = codes.find((candidate) => String(candidate.stock_code ?? "") === code);
      if (!matched) return [];
      return [{
        title: String(item.title ?? ""),
        date: String(item.notice_date ?? "").slice(0, 10),
        secName: String(matched.short_name ?? ""),
      }];
    });
  } catch (error) {
    logger.warn(`公告源[东财]获取失败 ${code}: ${(error as Error).message}`);
    return [];
  }
}

// ─── 公告聚合（多源合并去重）────────────────────────────

export async function getStockAnnouncements(code: string, days: number, name?: string, targetDate?: string): Promise<StockAnnouncementItem[]> {
  const [cninfoList, eastmoneyList] = await Promise.all([
    getAnnouncementsFromCninfo(code, days, targetDate),
    getAnnouncementsFromEastMoney(code, days, targetDate),
  ]);

  // 按标题去重，并清洗旧名称前缀（公司更名后数据源可能残留旧名）
  const seen = new Set<string>();
  const merged: StockAnnouncementItem[] = [];

  for (const item of [...cninfoList, ...eastmoneyList]) {
    // 去掉 "旧名:旧名xxx" → "xxx"，并用当前名称替换标题中残留的旧公司名
    let cleanTitle = item.title;
    // 提取冒号前的公司名（数据源残留的旧名）
    const colonIdx = cleanTitle.indexOf(":");
    if (colonIdx > 0 && name) {
      const oldName = cleanTitle.slice(0, colonIdx);
      const escapedOldName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      cleanTitle = cleanTitle.slice(colonIdx + 1).replace(new RegExp(escapedOldName, "g"), name);
    }
    if (seen.has(cleanTitle)) continue;
    seen.add(cleanTitle);
    merged.push({ ...item, title: cleanTitle, secName: name ?? item.secName });
  }

  merged.sort((a, b) => b.date.localeCompare(a.date));
  return merged;
}

// ─── 批量获取（并发池）────────────────────────────────────

export async function getStockInfoBatch(
  stocks: Array<{ code: string; name: string }>,
  days = 3,
  concurrency = 3,
  targetDate?: string,
): Promise<StockInfo[]> {
  const results: StockInfo[] = [];
  const queue = [...stocks];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const stock = queue.shift()!;
      try {
        const [news, reports, announcements] = await Promise.all([
          getStockNews(stock.name || stock.code, stock.code, days),
          getStockReports(stock.code, days, targetDate),
          getStockAnnouncements(stock.code, days, stock.name, targetDate),
        ]);
        results.push({ code: stock.code, name: stock.name, news, reports, announcements });
      } catch (error) {
        logger.warn(`信息面获取失败 ${stock.code}: ${(error as Error).message}`);
        results.push({ code: stock.code, name: stock.name, news: [], reports: [], announcements: [] });
      }
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── 格式化输出（供复盘 prompt 使用）────────────────────────

export function formatStockInfoForReview(infos: StockInfo[]): string {
  const lines: string[] = [];

  for (const info of infos) {
    const hasData = info.news.length > 0 || info.reports.length > 0 || info.announcements.length > 0;
    if (!hasData) continue;

    lines.push(`${info.name}(${info.code}) 信息面：`);

    if (info.announcements.length > 0) {
      lines.push("  公告：");
      for (const a of info.announcements.slice(0, 3)) {
        lines.push(`    - [${a.date}] ${a.title}`);
      }
    }

    if (info.news.length > 0) {
      lines.push("  新闻：");
      for (const n of info.news.slice(0, 3)) {
        lines.push(`    - [${n.date}] ${n.title}`);
      }
    }

    if (info.reports.length > 0) {
      lines.push("  研报：");
      for (const r of info.reports.slice(0, 3)) {
        lines.push(`    - [${r.publishDate}] ${r.orgName} "${r.title}" 评级:${r.rating || "未评"}`);
      }
    }

    lines.push("");
  }

  return lines.length > 0 ? lines.join("\n") : "暂无重大信息。";
}

// ─── Deterministic Service Handler ───────────────────────

export interface StockInfoToolInput {
  operation: "news" | "reports" | "announcements";
  stocks: Array<{ code?: string; name?: string }>;
}

export async function handleStockInfoTool(input: StockInfoToolInput): Promise<string> {
  const { operation, stocks } = input;
  const validStocks = stocks.filter((s) => s.code || s.name);
  if (validStocks.length === 0) return "请指定要查询的股票。";

  // 解析股票名称为代码
  const { codes, unresolved } = await resolveStockRefs(validStocks);
  if (codes.length === 0) {
    return `无法解析股票：${unresolved.map(s => s.name).join("、")}。请提供准确的股票名称。`;
  }

  // 构建 code -> name 映射
  const nameMap = new Map<string, string>();
  for (let i = 0; i < validStocks.length; i++) {
    const name = validStocks[i].name ?? "";
    if (name && i < codes.length) nameMap.set(codes[i], name);
  }
  for (const code of codes) {
    if (!nameMap.has(code)) nameMap.set(code, code);
  }

  const lines: string[] = [];
  const days = operation === "news" ? 7 : 30;

  for (const code of codes) {
    const name = nameMap.get(code) ?? code;

    try {
      if (operation === "news") {
        const items = await getStockNews(name, code, days);
        if (items.length === 0) {
          lines.push(`${name}(${code})：近 ${days} 天暂无新闻。`);
        } else {
          lines.push(`${name}(${code}) 近期新闻：`);
          for (const n of items.slice(0, 5)) {
            lines.push(`  - [${n.date}] ${n.title}（${n.source}）`);
          }
        }
      } else if (operation === "reports") {
        const items = await getStockReports(code, days);
        if (items.length === 0) {
          lines.push(`${name}(${code})：近 ${days} 天暂无研报。`);
        } else {
          lines.push(`${name}(${code}) 近期研报：`);
          for (const r of items.slice(0, 5)) {
            lines.push(`  - [${r.publishDate}] ${r.orgName} "${r.title}" 评级:${r.rating || "未评"}`);
          }
        }
      } else {
        const items = await getStockAnnouncements(code, days, name);
        if (items.length === 0) {
          lines.push(`${name}(${code})：近 ${days} 天暂无公告。`);
        } else {
          lines.push(`${name}(${code}) 近期公告：`);
          for (const a of items.slice(0, 5)) {
            lines.push(`  - [${a.date}] ${a.title}`);
          }
        }
      }
    } catch {
      lines.push(`${name}(${code})：数据获取失败。`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
