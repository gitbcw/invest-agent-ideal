import { db } from "../db/index.js";
import { alertEvents } from "../db/schema.js";
import { settings } from "../db/schema.js";
import { eq, desc, gte, lte, and } from "drizzle-orm";
import { marketDataReadCapability, type MarketSourceMeta } from "../services/market-data.js";
import type { StockKline, StockQuote } from "../services/stock.js";
import { indicatorCapability } from "../services/indicators.js";
import { callDeepSeek } from "../services/deepseek.js";
import { getStockInfoBatch, formatStockInfoForReview } from "../services/stock-news.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { portfolioBackend, watchlistBackend, planBackend, isWorkspaceBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { reviewViewpointBackend } from "../lib/review-viewpoint-backend.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { resolveWorkspacePath } from "../lib/workspace.js";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "path";

const REVIEWS_DIR = resolve(process.env.REVIEWS_ROOT || join(process.cwd(), "reviews"));
const TEMPLATE_KEY = "review_template";

type ReviewKind = "daily" | "weekly" | "monthly";

/** 把复盘产物同步到对应用户工作空间的 reports/<kind>/<key>.md。workspace 未初始化或写入失败都不抛错。 */
async function mirrorReviewToWorkspace(userId: string, kind: ReviewKind, key: string, content: string): Promise<void> {
  try {
    const wsRoot = resolveWorkspacePath(userId);
    if (!existsSync(join(wsRoot, "AGENTS.md"))) return;
    const dir = join(wsRoot, "reports", kind);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.md`), content, "utf-8");
  } catch (error) {
    logger.warn(`mirrorReviewToWorkspace failed user=${userId} kind=${kind} key=${key}: ${(error as Error).message}`);
  }
}

function ensureDir() {
  if (!existsSync(REVIEWS_DIR)) mkdirSync(REVIEWS_DIR, { recursive: true });
}

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateString(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function isReviewStockCode(code: unknown): code is string {
  return /^(?:sh|sz)?\d{6}(?:\.(?:sh|sz))?$/i.test(String(code || "").trim());
}

function weekRangeForDate(date?: string): { weekStart: string; weekEnd: string } {
  const baseDate = date ? parseDateString(date) : new Date();
  const weekStart = new Date(baseDate);
  const day = baseDate.getDay() || 7;
  weekStart.setDate(baseDate.getDate() - day + 1);
  return {
    weekStart: localDateString(weekStart),
    weekEnd: localDateString(baseDate),
  };
}

function monthRangeForDate(date?: string): { monthStart: string; monthEnd: string; monthKey: string } {
  const baseDate = date ? parseDateString(date) : new Date();
  const monthStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
  return {
    monthStart: localDateString(monthStart),
    monthEnd: localDateString(baseDate),
    monthKey: `${baseDate.getFullYear()}-${String(baseDate.getMonth() + 1).padStart(2, "0")}`,
  };
}

export interface ReviewTemplate {
  sections: {
    market_overview: { enabled: boolean; label: string };
    holdings: { enabled: boolean; label: string };
    watchlist: { enabled: boolean; label: string };
    capital_flow: { enabled: boolean; label: string };
    info_filter: { enabled: boolean; label: string };
    plan: { enabled: boolean; label: string };
    ai_analysis: { enabled: boolean; label: string };
  };
  focusPoints: string[];
  customInstructions: string;
}

const DEFAULT_TEMPLATE: ReviewTemplate = {
  sections: {
    market_overview: { enabled: true, label: "市场概况" },
    holdings: { enabled: true, label: "持仓情况" },
    watchlist: { enabled: true, label: "自选股" },
    capital_flow: { enabled: false, label: "资金流向（已从日复盘停用）" },
    info_filter: { enabled: true, label: "重大信息（公告/新闻/研报）" },
    plan: { enabled: true, label: "明日关注" },
    ai_analysis: { enabled: true, label: "AI 分析" },
  },
  focusPoints: [],
  customInstructions: "",
};

export async function getReviewTemplate(): Promise<ReviewTemplate> {
  const row = await db.select().from(settings).where(eq(settings.key, TEMPLATE_KEY)).limit(1);
  if (row.length === 0) return { ...DEFAULT_TEMPLATE };
  try {
    return { ...DEFAULT_TEMPLATE, ...JSON.parse(row[0].value) };
  } catch {
    return { ...DEFAULT_TEMPLATE };
  }
}

async function saveReviewTemplate(template: ReviewTemplate): Promise<void> {
  const existing = await db.select().from(settings).where(eq(settings.key, TEMPLATE_KEY)).limit(1);
  const value = JSON.stringify(template);
  if (existing.length > 0) {
    await db.update(settings).set({ value }).where(eq(settings.key, TEMPLATE_KEY));
  } else {
    await db.insert(settings).values({ key: TEMPLATE_KEY, value });
  }
}

/** 解析复盘操作 */
function parseAction(message: string): { action: string; date?: string } {
  const dateMatch = message.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) return { action: "query", date: dateMatch[1] };
  if (message.includes("周复盘")) return { action: "weekly" };
  if (message.includes("月复盘")) return { action: "monthly" };
  if (message.includes("日复盘") || message.includes("复盘") || message.includes("总结")) {
    return { action: "daily" };
  }
  return { action: "daily" };
}

interface StockPlanItem {
  code: string;
  name: string;
  pool: "holding" | "watchlist";
  support: number | null;
  resistance: number | null;
  observe: string[];
  risks: string[];
  confidence: "low" | "medium" | "high";
}

interface DailyPlanData {
  date: string;
  generatedAt: string;
  items: StockPlanItem[];
  pushSummary?: string;
}

interface DailyReviewContextStock extends StockPlanItem {
  price: number | null;
  changePercent: number | null;
  trend: string;
  macd: string;
  volume: string;
  description: string;
}

export interface DailyReviewSourceQualityItem {
  data: string;
  provider: string;
  endpoint: string;
  referenceUrl?: string;
  time: string;
  confidence: string;
  status: string;
}

function sourceStatus(source: MarketSourceMeta): string {
  const parts: string[] = [];
  if (source.stale) parts.push("stale");
  parts.push(...source.warnings);
  return parts.length > 0 ? parts.join(";") : "ok";
}

function collectSourceQuality(
  bucket: DailyReviewSourceQualityItem[],
  label: string,
  source?: MarketSourceMeta | null,
  fallbackStatus?: string,
) {
  if (!source) {
    bucket.push({
      data: label,
      provider: "missing",
      endpoint: "-",
      time: "-",
      confidence: "unavailable",
      status: fallbackStatus || "missing",
    });
    return;
  }
  const item: DailyReviewSourceQualityItem = {
    data: label,
    provider: source.provider,
    endpoint: source.endpoint,
    referenceUrl: source.referenceUrl,
    time: source.marketTime || source.fetchedAt,
    confidence: source.confidence,
    status: sourceStatus(source),
  };
  const key = [item.data, item.provider, item.endpoint, item.referenceUrl ?? "", item.time, item.confidence, item.status].join("|");
  if (!bucket.some((existing) => [existing.data, existing.provider, existing.endpoint, existing.referenceUrl ?? "", existing.time, existing.confidence, existing.status].join("|") === key)) {
    bucket.push(item);
  }
}

async function reviewKlines(
  code: string,
  count: number,
  userId: string,
  options: { startDate?: string; endDate?: string } = {},
): Promise<StockKline[]> {
  const result = await marketDataReadCapability.kline({
    code,
    period: "day",
    count,
    startDate: options.startDate,
    endDate: options.endDate,
  }, userId);
  return result.items as StockKline[];
}

async function reviewKlinesResult(
  code: string,
  count: number,
  userId: string,
  options: { startDate?: string; endDate?: string } = {},
) {
  return marketDataReadCapability.kline({
    code,
    period: "day",
    count,
    startDate: options.startDate,
    endDate: options.endDate,
  }, userId);
}

async function reviewQuote(code: string, userId: string): Promise<StockQuote | undefined> {
  const result = await marketDataReadCapability.quote([code], userId);
  if (result.warnings.length > 0) {
    logger.warn(`复盘行情数据不完整 user=${userId} code=${code}: ${result.warnings.join(";")}`);
  }
  return result.items[0];
}

async function reviewQuoteResult(code: string, userId: string) {
  const result = await marketDataReadCapability.quote([code], userId);
  if (result.warnings.length > 0) {
    logger.warn(`复盘行情数据不完整 user=${userId} code=${code}: ${result.warnings.join(";")}`);
  }
  return result;
}

async function reviewMarketIndexLines(input: {
  userId: string;
  today: string;
  isHistorical: boolean;
}): Promise<string[]> {
  try {
    if (input.isHistorical) {
      const indexCodes = [
        { code: "000001", name: "上证指数", prefix: "sh" },
        { code: "399001", name: "深证成指", prefix: "sz" },
        { code: "399006", name: "创业板指", prefix: "sz" },
        { code: "000300", name: "沪深300", prefix: "sh" },
      ];
      const lines: string[] = [];
      for (const idx of indexCodes) {
        const klines = await reviewKlines(idx.prefix + idx.code, 5, input.userId, { endDate: input.today });
        const dayK = klines.find((k) => k.date === input.today) ?? klines[klines.length - 1];
        if (dayK) {
          const prevK = klines[klines.indexOf(dayK) - 1];
          const pct = prevK ? ((dayK.close - prevK.close) / prevK.close * 100) : 0;
          lines.push(`${idx.name} ${dayK.close} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
        }
      }
      return lines;
    }
    const indices = await marketDataReadCapability.indices(input.userId);
    if (indices.warnings.length > 0) {
      logger.warn(`复盘指数数据不完整 user=${input.userId}: ${indices.warnings.join(";")}`);
    }
    return indices.items.map((i) => `${i.name} ${i.price} ${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%`);
  } catch {
    return ["大盘指数数据获取失败"];
  }
}

async function reviewMarketIndexData(input: {
  userId: string;
  today: string;
  isHistorical: boolean;
  sourceQuality: DailyReviewSourceQualityItem[];
}): Promise<string[]> {
  try {
    if (input.isHistorical) {
      const indexCodes = [
        { code: "000001", name: "上证指数", prefix: "sh" },
        { code: "399001", name: "深证成指", prefix: "sz" },
        { code: "399006", name: "创业板指", prefix: "sz" },
        { code: "000300", name: "沪深300", prefix: "sh" },
      ];
      const lines: string[] = [];
      for (const idx of indexCodes) {
        const result = await reviewKlinesResult(idx.prefix + idx.code, 5, input.userId, { endDate: input.today });
        collectSourceQuality(input.sourceQuality, "大盘指数日K", result.source);
        const klines = result.items as StockKline[];
        const dayK = klines.find((k) => k.date === input.today) ?? klines[klines.length - 1];
        if (dayK) {
          const prevK = klines[klines.indexOf(dayK) - 1];
          const pct = prevK ? ((dayK.close - prevK.close) / prevK.close * 100) : 0;
          lines.push(`${idx.name} ${dayK.close} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`);
        }
      }
      return lines;
    }
    const indices = await marketDataReadCapability.indices(input.userId);
    if (indices.warnings.length > 0) {
      logger.warn(`复盘指数数据不完整 user=${input.userId}: ${indices.warnings.join(";")}`);
    }
    for (const index of indices.items) collectSourceQuality(input.sourceQuality, "大盘指数", index.source);
    return indices.items.map((i) => `${i.name} ${i.price} ${i.changePercent >= 0 ? "+" : ""}${i.changePercent}%`);
  } catch {
    collectSourceQuality(input.sourceQuality, "大盘指数", null, "获取失败");
    return ["大盘指数数据获取失败"];
  }
}

function compactSourceQuality(items: DailyReviewSourceQualityItem[]): DailyReviewSourceQualityItem[] {
  const seen = new Set<string>();
  const out: DailyReviewSourceQualityItem[] = [];
  for (const item of items) {
    const key = [item.data, item.provider, item.endpoint, item.referenceUrl ?? "", item.confidence, item.status].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 20);
}

export interface DailyReviewContext {
  date: string;
  generatedAt: string;
  isHistorical: boolean;
  previousReview: {
    date: string;
    summary: string;
    generatedAt: string;
  } | null;
  openViewpoints: Array<{
    id: string;
    view: string;
    reason: string;
    action: string;
    validation: string;
    expectedReviewDate: string;
    sourceDate: string;
  }>;
  marketIndex: string[];
  sourceQuality: DailyReviewSourceQualityItem[];
  stocks: DailyReviewContextStock[];
  holdings: DailyReviewContextStock[];
  watchlist: DailyReviewContextStock[];
  capitalFlow: string[];
  infoFilter: string;
  alerts: Array<{
    id: number;
    stockCode: string;
    stockName: string;
    eventType: string;
    signalKey: string;
    message: string;
    relationToPlan: string;
    severity: string;
    price: number | null;
    status: string;
    feedback: string | null;
    createdAt: string;
  }>;
  existingPlans: Array<{
    code: string;
    name: string;
    support?: number | null;
    resistance?: number | null;
    targetPrice?: number | null;
    stopLoss?: number | null;
    notes?: string | null;
    updatedAt?: string;
  }>;
  template: ReviewTemplate;
  dataLimits: string[];
}

export async function handleReview(message: string): Promise<string> {
  const { action, date } = parseAction(message);

  switch (action) {
    case "daily":
      return generateDailyReview();
    case "weekly":
      return generateWeeklyReview();
    case "monthly":
      return "月复盘功能开发中...";
    case "query":
      return queryReview(date!);
    default:
      return generateDailyReview();
  }
}

export async function buildDailyReviewContext(options: { targetDate?: string; userId?: string; instanceId?: string } = {}): Promise<DailyReviewContext> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const today = options.targetDate ?? localDateString();
  const generatedAt = new Date().toISOString();
  const template = await getReviewTemplate();
  const watchItems = await watchlistBackend.list(userId, instanceId);
  const positions = await portfolioBackend.listActive(userId, instanceId);
  const todayAlerts = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), eq(alertEvents.eventDate, today)));
  await updateAlertFeedback(userId, todayAlerts);

  const allCodes = new Map<string, { name: string; pool: "holding" | "watchlist" }>();
  for (const p of positions) {
    if (isReviewStockCode(p.code)) allCodes.set(p.code, { name: p.name, pool: "holding" });
  }
  for (const w of watchItems) {
    if (isReviewStockCode(w.code) && !allCodes.has(w.code)) {
      allCodes.set(w.code, { name: w.name, pool: "watchlist" });
    }
  }

  const isHistorical = !!options.targetDate;
  const sourceQuality: DailyReviewSourceQualityItem[] = [];
  const marketIndexLines = await reviewMarketIndexData({ userId, today, isHistorical, sourceQuality });

  const stocks: DailyReviewContextStock[] = [];
  for (const [code, meta] of allCodes) {
    try {
      const klineResult = await reviewKlinesResult(code, 120, userId, { endDate: isHistorical ? today : undefined });
      collectSourceQuality(sourceQuality, `${meta.name}(${code})日K`, klineResult.source);
      const klines = klineResult.items as StockKline[];
      const indicator = klines.length >= 30 ? indicatorCapability.analyzeIndicators(klines) : null;
      const levels = estimateLevels(klines);

      let price: number | undefined;
      let changePercent: number | undefined;
      if (isHistorical) {
        const dayK = klines.find(k => k.date === today) ?? klines[klines.length - 1];
        const prevK = dayK ? klines[klines.indexOf(dayK) - 1] : undefined;
        if (dayK) price = dayK.close;
        if (dayK && prevK) changePercent = (dayK.close - prevK.close) / prevK.close * 100;
      } else {
        const quoteResult = await reviewQuoteResult(code, userId);
        const quote = quoteResult.items[0];
        collectSourceQuality(sourceQuality, `${meta.name}(${code})实时行情`, quote?.source, quoteResult.warnings.join(";") || "missing_quote");
        price = quote?.price;
        changePercent = quote?.changePercent;
      }

      const observe = buildObserveRules(price, levels.support, levels.resistance, indicator?.summary);
      const trend = indicator?.trend.trendDesc ?? "-";
      const macd = indicator?.trend.macdSignal ? indicator.trend.macdSignal.replace(/^MACD\s*/, "") : "-";
      const volume = indicator?.volume.status ?? "-";
      const dir = (changePercent ?? 0) >= 0 ? "+" : "";
      stocks.push({
        code,
        name: meta.name,
        pool: meta.pool,
        price: price ?? null,
        changePercent: changePercent ?? null,
        trend,
        macd,
        volume,
        description: `${meta.name}(${code}) ${isHistorical ? "收盘" : "现价"}${price ?? "-"} ${dir}${(changePercent ?? 0).toFixed(2)}% 趋势${trend} MACD${macd} 量能${volume}`,
        support: levels.support,
        resistance: levels.resistance,
        observe,
        risks: ["量价判断仅作参考", "重大公告需人工确认"],
        confidence: klines.length >= 60 ? "medium" : "low",
      });
    } catch {
      collectSourceQuality(sourceQuality, `${meta.name}(${code})行情`, null, "获取失败");
      stocks.push({
        code,
        name: meta.name,
        pool: meta.pool,
        price: null,
        changePercent: null,
        trend: "-",
        macd: "-",
        volume: "-",
        description: `${meta.name}(${code}) 行情获取失败`,
        support: null,
        resistance: null,
        observe: ["行情获取失败"],
        risks: ["数据缺失"],
        confidence: "low",
      });
    }
  }

  let infoFilterText = "暂无重大信息。";
  if (template.sections.info_filter.enabled) {
    try {
      const stockList = [...allCodes.entries()].map(([code, meta]) => ({ code, name: meta.name }));
      const infos = await getStockInfoBatch(stockList, 3, 3, isHistorical ? today : undefined);
      infoFilterText = formatStockInfoForReview(infos);
    } catch {
      infoFilterText = "信息面数据获取失败，请人工确认。";
    }
  }

  const existingPlans = await planBackend.list(userId, instanceId);
  const previousReview = await getPreviousDailyReview(userId, instanceId, today);
  const structuredOpenViewpoints = await getOpenReviewViewpoints(userId, instanceId, today);
  const openViewpoints = structuredOpenViewpoints.length > 0
    ? structuredOpenViewpoints
    : previousReview
      ? extractViewpoints(previousReview.content, previousReview.planDate)
      : [];
  return {
    date: today,
    generatedAt,
    isHistorical,
    previousReview: previousReview
      ? {
          date: previousReview.planDate,
          summary: summarizeReview(previousReview.content || previousReview.summary || ""),
          generatedAt: previousReview.generatedAt,
        }
      : null,
    openViewpoints,
    marketIndex: marketIndexLines,
    sourceQuality: compactSourceQuality(sourceQuality),
    stocks,
    holdings: stocks.filter((stock) => stock.pool === "holding"),
    watchlist: stocks.filter((stock) => stock.pool === "watchlist"),
    capitalFlow: [],
    infoFilter: infoFilterText,
    alerts: todayAlerts,
    existingPlans,
    template,
    dataLimits: [
      "主力控盘、筹码集中度、逐笔成交尚未接入可靠确定性数据源。",
      "新闻、公告、研报需区分事实与观点，重大事项建议人工复核。",
    ],
  };
}

async function getPreviousDailyReview(userId: string, instanceId: string, beforeDate: string) {
  return dailyPlanBackend.getPrevious(userId, instanceId, beforeDate);
}

function summarizeReview(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const core = extractSection(normalized, /##\s*一[、.．]\s*核心结论|【核心结论】|一[、.．]\s*核心结论/);
  const source = core || normalized;
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("|") && !/^[-:| ]+$/.test(line))
    .slice(0, 8)
    .join("\n")
    .slice(0, 1200);
}

function compactLines(value: string, limit: number): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("|") && !/^[-:| ]+$/.test(line))
    .filter((line) => !/^#{1,6}\s+/.test(line) && !/^【.+】$/.test(line) && !/^\d{4}-\d{2}-\d{2}\s*(收盘)?复盘$/.test(line))
    .filter((line) => !/^仅供参考/.test(line))
    .filter((line) => !/(完整复盘已保存|需要展开|查看今日复盘|已保存复盘内容)/.test(line))
    .slice(0, limit);
}

function firstMatchingSection(content: string, patterns: RegExp[], limit: number): string[] {
  for (const pattern of patterns) {
    const section = extractSection(content, pattern);
    const lines = compactLines(section, limit);
    if (lines.length > 0) return lines;
  }
  return [];
}

function buildWeixinReviewSummary(date: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const core = compactLines(summarizeReview(normalized), 4);
  const fallbackCore = firstMatchingSection(normalized, [/【AI 分析】/, /【持仓情况】/, /【市场概况】/], 4);
  const alerts = firstMatchingSection(normalized, [/【今日提醒】/, /今日提醒回测/], 4);
  const tomorrow = firstMatchingSection(normalized, [/【明日关注】/, /【明日交易预案】/, /(?:##\s*)?(?:[一二三四五六七八九十]+[、.．]\s*)?明日操作与观察/, /明日重点/], 6);
  const confirmations = firstMatchingSection(normalized, [/需要你确认/, /待确认/], 4);

  const lines: string[] = [`【${date} 复盘摘要】`];

  lines.push("", "1. 核心判断");
  const wholeContentFallback = compactLines(normalized, 4);
  const coreLines = core.length > 0 ? core : fallbackCore.length > 0 ? fallbackCore : wholeContentFallback;
  lines.push(...(coreLines.length > 0 ? coreLines.map((line) => `- ${line.replace(/^[-•]\s*/, "")}`) : ["- 今日复盘已生成，核心结论见完整复盘。"]));

  if (alerts.length > 0) {
    lines.push("", "2. 今日提醒");
    lines.push(...alerts.map((line) => `- ${line.replace(/^[-•]\s*/, "")}`));
  }

  if (tomorrow.length > 0) {
    lines.push("", "3. 明日只看");
    lines.push(...tomorrow.map((line) => `- ${line.replace(/^[-•]\s*/, "")}`));
  }

  if (confirmations.length > 0) {
    lines.push("", "4. 需要你确认");
    lines.push(...confirmations.map((line) => `- ${line.replace(/^[-•]\s*/, "")}`));
  }

  lines.push("", "完整复盘已保存。需要展开可以回复「查看今日复盘」。");
  return lines.join("\n").slice(0, 1200);
}

export function buildReviewPushSummary(content: string, date = localDateString()): string {
  const dateMatch = content.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return buildWeixinReviewSummary(dateMatch?.[1] ?? date, content);
}

function extractSection(content: string, heading: RegExp): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start < 0) return "";
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line) || /^【.+】$/.test(line.trim()) || /^[一二三四五六七八九十]+[、.．]/.test(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function extractViewpoints(content: string, sourceDate: string): DailyReviewContext["openViewpoints"] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => /^#{0,3}\s*(?:[一二三四五六七八九十]+[、.．]\s*)?【?观点追踪表】?\s*$/.test(line.trim()));
  if (headingIndex < 0) return [];

  const rows: DailyReviewContext["openViewpoints"] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (rows.length > 0) break;
      continue;
    }
    if (/^#{1,3}\s+/.test(trimmed) || /^【.+】$/.test(trimmed)) break;
    if (!trimmed.startsWith("|")) continue;
    if (/编号\s*\|/.test(trimmed) || /^[:|\-\s]+$/.test(trimmed.replace(/\|/g, ""))) continue;

    const cells = trimmed
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 6) continue;
    rows.push({
      id: cells[0],
      view: cells[1],
      reason: cells[2],
      action: cells[3],
      validation: cells[4],
      expectedReviewDate: cells[5],
      sourceDate,
    });
  }

  return rows.slice(0, 12);
}

function dateAfterDays(sourceDate: string, days: number): string {
  const date = parseDateString(sourceDate);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function formatViewpointCell(value: string | number | null | undefined): string {
  return String(value ?? "-")
    .replace(/\|/g, "／")
    .replace(/\r?\n/g, " ")
    .trim()
    .slice(0, 180) || "-";
}

function buildViewpointTrackingTable(sourceDate: string, planItems: StockPlanItem[], alerts: Array<{ stockCode: string; stockName: string; message: string; severity: string }>): string[] {
  const rows: Array<{
    id: string;
    view: string;
    reason: string;
    action: string;
    validation: string;
    expectedReviewDate: string;
  }> = [];
  const alertCodes = new Set(alerts.map((alert) => alert.stockCode));
  const ordered = [...planItems].sort((a, b) => {
    const alertDiff = Number(alertCodes.has(b.code)) - Number(alertCodes.has(a.code));
    if (alertDiff !== 0) return alertDiff;
    const poolDiff = Number(b.pool === "holding") - Number(a.pool === "holding");
    if (poolDiff !== 0) return poolDiff;
    return confidenceRank(b.confidence) - confidenceRank(a.confidence);
  });

  for (const item of ordered.slice(0, 3)) {
    const prefix = item.pool === "holding" ? "持仓" : "自选";
    const observe = item.observe[0] || "继续观察量价变化";
    const priceArea = item.support && item.resistance
      ? `支撑${item.support}、压力${item.resistance}`
      : "关键价位仍需补充确认";
    rows.push({
      id: `${sourceDate.replace(/-/g, "")}-${String(rows.length + 1).padStart(2, "0")}`,
      view: `${prefix}${item.name}(${item.code})短线先按观察处理，不追高确认。`,
      reason: `${priceArea}；${observe}；置信度${item.confidence}。`,
      action: item.pool === "holding" ? "保留跟踪，按预案价位和提醒事件复核。" : "留在自选池，满足观察条件后再考虑升级。",
      validation: `未来3个交易日验证是否触发：${observe}。`,
      expectedReviewDate: dateAfterDays(sourceDate, 3),
    });
  }

  if (rows.length === 0) return [];
  return [
    "【观点追踪表】",
    "| 编号 | 观点 | 依据 | 动作 | 验证条件 | 预计复盘日期 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => [
      row.id,
      row.view,
      row.reason,
      row.action,
      row.validation,
      row.expectedReviewDate,
    ].map(formatViewpointCell).join(" | ")).map((line) => `| ${line} |`),
    "",
  ];
}

function confidenceRank(value: StockPlanItem["confidence"]): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function buildDailySourceQualitySection(input: {
  generatedAt: string;
  today: string;
  isHistorical: boolean;
  hasStocks: boolean;
  missingStockNames: string[];
  infoFilterText: string;
  sourceQuality?: DailyReviewSourceQualityItem[];
}): string[] {
  const quoteStatus = input.missingStockNames.length > 0
    ? `部分缺失：${input.missingStockNames.join("、")}`
    : input.hasStocks
      ? "正常；若服务层返回 warnings，正文需降低结论强度"
      : "无持仓/观察仓行情";
  const quoteTime = input.isHistorical ? input.today : input.generatedAt;
  const infoStatus =
    input.infoFilterText === "暂无重大信息。" ? "未发现重大信息" :
    input.infoFilterText.includes("获取失败") ? "缺失/需人工确认" :
    "已拉取摘要；新闻/研报观点需人工核验";
  const sourceRows = input.sourceQuality?.length
    ? input.sourceQuality.slice(0, 12).map((item) =>
        `| ${item.data} | ${item.provider} / ${item.endpoint} | ${item.referenceUrl ?? item.endpoint} | ${item.time} | ${item.confidence} | ${item.status} |`
      )
    : [
        `| 持仓/观察仓行情 | 服务层行情 API（腾讯行情优先，失败时按 provider fallback 标注） | qt.gtimg.cn/q 或 fallback endpoint | ${quoteTime} | medium/high | ${quoteStatus} |`,
        `| 大盘指数 | 服务层指数 API（腾讯指数优先，失败时按 provider fallback 标注） | qt.gtimg.cn/q 或 fallback endpoint | ${quoteTime} | high/medium | 以正文指数行和服务 warnings 为准 |`,
      ];
  return [
    "【数据来源与质量】",
    "| 数据 | 来源 | 外部引用 | 时间 | 置信度 | 状态 |",
    "|---|---|---|---|---|---|",
    ...sourceRows,
    `| 信息面 | 公告/新闻/研报公开来源摘要 | 东方财富/巨潮等公开页面或 API 摘要 | ${input.generatedAt} | secondary | ${infoStatus} |`,
    `| 用户持仓成本与观察规则 | 用户确认配置 | workspace 配置 | ${input.generatedAt} | user_confirmed | 作为成本市值和规则口径，不等同实时市值 |`,
    `| 主力控盘/筹码集中度/逐笔成交 | 未接入可靠确定性数据源 | 缺失 | ${input.generatedAt} | unavailable | 不作为交易判断依据 |`,
    "",
  ];
}

function buildViewpointBacktestTable(openViewpoints: DailyReviewContext["openViewpoints"]): string[] {
  if (openViewpoints.length === 0) return [];
  return [
    "【上一轮观点回测】",
    "| 编号 | 状态 | 回测说明 |",
    "| --- | --- | --- |",
    ...openViewpoints.slice(0, 12).map((item) => {
      const explanation = [
        `原观点：${item.view}`,
        `验证条件：${item.validation}`,
        "当前仍需结合后续价格、量能、提醒事件或人工复盘继续确认。",
      ].join("；");
      return `| ${formatViewpointCell(item.id)} | pending | ${formatViewpointCell(explanation)} |`;
    }),
    "",
  ];
}

function normalizeViewpointStatus(value: string): "validated" | "invalidated" | "pending" | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["validated", "命中", "已验证", "正确", "有效"].includes(normalized)) return "validated";
  if (["invalidated", "未命中", "失效", "错误", "无效"].includes(normalized)) return "invalidated";
  if (["pending", "待验证", "继续观察", "未验证"].includes(normalized)) return "pending";
  return null;
}

function extractViewpointResolutions(content: string): Array<{
  id: string;
  status: "validated" | "invalidated" | "pending";
  resolution: string;
}> {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  // WP5.2:新增"日复盘观点回测/周观点回测"标题,兼容周复盘 agent 输出。
  const headingIndex = lines.findIndex((line) => /^#{0,3}\s*(?:[一二三四五六七八九十]+[、.．]\s*)?【?(?:上一轮观点回测|观点回测表|历史观点回测|日复盘观点回测|周观点回测)】?\s*$/.test(line.trim()));
  if (headingIndex < 0) return [];

  const rows: Array<{ id: string; status: "validated" | "invalidated" | "pending"; resolution: string }> = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (rows.length > 0) break;
      continue;
    }
    if (/^#{1,3}\s+/.test(trimmed) || /^【.+】$/.test(trimmed)) break;
    if (!trimmed.startsWith("|")) continue;
    if (/编号\s*\|/.test(trimmed) || /^[:|\-\s]+$/.test(trimmed.replace(/\|/g, ""))) continue;

    const cells = trimmed
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length < 3) continue;

    const status = normalizeViewpointStatus(cells[1]);
    if (!status) continue;
    rows.push({
      id: cells[0],
      status,
      resolution: cells.slice(2).join("；").slice(0, 1200),
    });
  }
  return rows.slice(0, 24);
}

async function getOpenReviewViewpoints(userId: string, instanceId: string, reviewDate: string): Promise<DailyReviewContext["openViewpoints"]> {
  const rows = await reviewViewpointBackend.list(userId, instanceId, {
    status: "open",
    expectedReviewDateTo: reviewDate,
    limit: 12,
  });

  return rows.map((row) => ({
    id: row.viewpointId,
    view: row.view,
    reason: row.reason,
    action: row.action,
    validation: row.validation,
    expectedReviewDate: row.expectedReviewDate,
    sourceDate: row.sourceDate,
  }));
}

async function syncReviewViewpoints(userId: string, instanceId: string, sourceDate: string, content: string) {
  await syncViewpointResolutions(userId, instanceId, content);

  const extracted = extractViewpoints(content, sourceDate);
  await reviewViewpointBackend.replaceByDate({
    userId, instanceId, sourceDate,
    viewpoints: extracted.map((item) => ({
      viewpointId: item.id,
      view: item.view,
      reason: item.reason,
      action: item.action,
      validation: item.validation,
      expectedReviewDate: item.expectedReviewDate,
    })),
  });
}

export async function syncViewpointResolutions(userId: string, instanceId: string, content: string) {
  const resolutions = extractViewpointResolutions(content);
  if (resolutions.length === 0) return;

  for (const item of resolutions) {
    await reviewViewpointBackend.resolve({
      userId, instanceId,
      viewpointId: item.id,
      // resolution 表里没有 sourceDate 列,保留原 SQLite 的"按 viewpointId 找最新"宽容语义
      status: item.status,
      resolution: item.resolution,
    });
  }
}

async function getWeeklyViewpointSummary(userId: string, instanceId: string, weekStart: string, weekEnd: string) {
  const rows = await reviewViewpointBackend.list(userId, instanceId, {
    sourceDateFrom: weekStart,
    sourceDateTo: weekEnd,
  });

  const counts = rows.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    counts: {
      validated: counts.validated ?? 0,
      invalidated: counts.invalidated ?? 0,
      pending: counts.pending ?? 0,
      open: counts.open ?? 0,
    },
    // WP5.2:透出 invalidationSignals/confidence/expectedReviewDate/reason/action,
    // 让 agent 在周复盘里自行调 get_quote/get_kline 拉行情,根据失效信号和验证条件判定 hit/miss。
    rows: rows.map((item) => ({
      sourceDate: item.sourceDate,
      id: item.viewpointId,
      status: item.status,
      view: item.view,
      reason: item.reason,
      action: item.action,
      validation: item.validation,
      invalidationSignals: item.invalidationSignals,
      confidence: item.confidence,
      expectedReviewDate: item.expectedReviewDate,
      resolution: item.resolution,
    })),
  };
}

async function getDailyReviewCoverage(userId: string, instanceId: string, startDate: string, endDate: string) {
  const rows = await dailyPlanBackend.listInRange(userId, instanceId, startDate, endDate);
  return rows.map((row) => ({
    date: row.planDate,
    generatedAt: row.generatedAt,
    summaryPreview: (row.summary || "").replace(/\s+/g, " ").slice(0, 240),
  }));
}

/**
 * WP5.6:周/月复盘行为纠偏统计。
 *
 * 读 memory/behavior_events.jsonl,按时间范围筛,按 event_type 聚合计数 + 最近 30 条 action_confirmed 详情。
 * agent 看 detail 自行识别追高/频繁短线/规则外请求模式(代码不做"模式识别",信任 agent)。
 *
 * sqlite 模式无 behavior_events 返回 available=false,agent 在报告里说明"数据缺失"。
 */
async function collectBehaviorStats(
  userId: string,
  instanceId: string,
  startDate: string,
  endDate: string,
): Promise<{
  available: boolean;
  rangeStart: string;
  rangeEnd: string;
  actionConfirmedCount: number;
  conversationTurnCount: number;
  outOfScopeCount: number;
  /** action_confirmed 详情(按时间排序,最多 30 条),agent 据此识别追高/频繁短线 */
  recentActions: Array<{
    occurred_at: string;
    code: string | null;
    action: string | null;
    price: number | null;
    quantity: number | null;
  }>;
}> {
  if (!isWorkspaceBackend()) {
    return {
      available: false,
      rangeStart: startDate,
      rangeEnd: endDate,
      actionConfirmedCount: 0,
      conversationTurnCount: 0,
      outOfScopeCount: 0,
      recentActions: [],
    };
  }

  try {
    const store = new WorkspaceStore(userId);
    type EventRecord = {
      event_type?: string;
      occurred_at?: string;
      payload?: {
        instance_id?: string;
        code?: string;
        action?: string;
        price?: number | null;
        quantity?: number | null;
      };
    };
    const events = await store.listBehaviorEvents<EventRecord>();
    const inRange = events.filter((e) => {
      if (!e.occurred_at) return false;
      // occurred_at 是 ISO 时间,startDate/endDate 是 YYYY-MM-DD 日期
      const date = e.occurred_at.slice(0, 10);
      return date >= startDate && date <= endDate;
    });
    const scoped = inRange.filter((e) => !e.payload?.instance_id || e.payload.instance_id === instanceId);

    const actionConfirmed = scoped.filter((e) => e.event_type === "action_confirmed");
    const conversationTurns = scoped.filter((e) => e.event_type === "wechat_conversation_turn");
    const outOfScope = scoped.filter((e) => e.event_type === "out_of_scope_query");

    return {
      available: true,
      rangeStart: startDate,
      rangeEnd: endDate,
      actionConfirmedCount: actionConfirmed.length,
      conversationTurnCount: conversationTurns.length,
      outOfScopeCount: outOfScope.length,
      recentActions: actionConfirmed
        .slice(-30) // 取最近 30 条(按写入顺序,jsonl 是 append-only)
        .map((e) => ({
          occurred_at: e.occurred_at ?? "",
          code: e.payload?.code ?? null,
          action: e.payload?.action ?? null,
          price: e.payload?.price ?? null,
          quantity: e.payload?.quantity ?? null,
        })),
    };
  } catch (err) {
    logger.warn(`collectBehaviorStats 失败,降级为 available=false: ${err}`);
    return {
      available: false,
      rangeStart: startDate,
      rangeEnd: endDate,
      actionConfirmedCount: 0,
      conversationTurnCount: 0,
      outOfScopeCount: 0,
      recentActions: [],
    };
  }
}

function formatWeeklyViewpointSummary(summary: Awaited<ReturnType<typeof getWeeklyViewpointSummary>>): string {
  const counts = summary.counts;
  const lines = [
    `- 汇总: validated ${counts.validated}，invalidated ${counts.invalidated}，pending ${counts.pending}，open ${counts.open}`,
    "",
    "| 日期 | 编号 | 状态 | 置信度 | 复核日期 | 观点 |",
    "|------|------|------|--------|---------|------|",
  ];

  if (summary.rows.length === 0) {
    lines.push("| - | - | - | - | - | 本周暂无结构化观点追踪记录 |");
  } else {
    for (const item of summary.rows.slice(0, 30)) {
      lines.push(`| ${item.sourceDate} | ${item.id} | ${item.status} | ${item.confidence} | ${item.expectedReviewDate} | ${item.view} |`);
    }
  }

  // WP5.2:对 open/pending 观点展开回测字段,让 agent 拿到完整判定依据(失效信号 + 验证条件 + 行动建议)
  const backtestCandidates = summary.rows.filter((r) => r.status === "open" || r.status === "pending");
  if (backtestCandidates.length > 0) {
    lines.push("", "### 待回测观点详情(状态 open/pending)", "");
    for (const item of backtestCandidates) {
      lines.push(
        `**${item.id}** (${item.sourceDate}) — ${item.view}`,
        `- 理由: ${item.reason || "-"}`,
        `- 行动: ${item.action || "-"}`,
        `- 验证条件(满足→validated): ${item.validation || "-"}`,
        `- 失效信号(触发→invalidated): ${item.invalidationSignals.length > 0 ? item.invalidationSignals.join("; ") : "(未声明)"}`,
        `- 当前回测说明: ${item.resolution ?? "(未回测)"}`,
        "",
      );
    }
  }

  return lines.join("\n");
}

export async function buildWeeklyReviewContext(options: { userId?: string; instanceId?: string; date?: string } = {}) {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const { weekStart: weekStartStr, weekEnd: weekEndStr } = weekRangeForDate(options.date);

  const weekAlerts = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), gte(alertEvents.eventDate, weekStartStr), lte(alertEvents.eventDate, weekEndStr)))
    .orderBy(desc(alertEvents.createdAt));
  const viewpointSummary = await getWeeklyViewpointSummary(userId, instanceId, weekStartStr, weekEndStr);
  // WP5.6:周复盘行为纠偏统计
  const behaviorStats = await collectBehaviorStats(userId, instanceId, weekStartStr, weekEndStr);

  return {
    userId,
    instanceId,
    weekStart: weekStartStr,
    weekEnd: weekEndStr,
    alertCount: weekAlerts.length,
    alertSummary: formatAlertSummary(weekAlerts),
    viewpointSummary,
    viewpointSummaryText: formatWeeklyViewpointSummary(viewpointSummary),
    behaviorStats,
  };
}

export async function buildMonthlyReviewContext(options: { userId?: string; instanceId?: string; date?: string } = {}) {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const { monthStart, monthEnd, monthKey } = monthRangeForDate(options.date);

  const monthAlerts = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), gte(alertEvents.eventDate, monthStart), lte(alertEvents.eventDate, monthEnd)))
    .orderBy(desc(alertEvents.createdAt));
  const viewpointSummary = await getWeeklyViewpointSummary(userId, instanceId, monthStart, monthEnd);
  const dailyReviews = await getDailyReviewCoverage(userId, instanceId, monthStart, monthEnd);
  // WP5.3:月复盘归因需要看到本月已有的 proposed 方法候选,避免 agent 在月复盘中重复提议同一改动。
  // 决策:不加 status filter,让 agent 看到 proposed/confirmed/rejected 全部,确认语义后自己判断是否重新提议。
  const methodChangeProposals = await methodChangeBackend.list(userId, instanceId, { limit: 30 });
  // WP5.6:月复盘行为纠偏统计
  const behaviorStats = await collectBehaviorStats(userId, instanceId, monthStart, monthEnd);

  const alertCounts = monthAlerts.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  return {
    userId,
    instanceId,
    monthKey,
    monthStart,
    monthEnd,
    dailyReviewCount: dailyReviews.length,
    dailyReviews,
    alertCount: monthAlerts.length,
    alertCounts: {
      hit: alertCounts["命中"] ?? 0,
      falsePositive: alertCounts["误报"] ?? 0,
      pending: alertCounts["待验证"] ?? 0,
      unassessed: alertCounts.pending ?? 0,
    },
    alertSummary: formatAlertSummary(monthAlerts),
    viewpointSummary,
    viewpointSummaryText: formatWeeklyViewpointSummary(viewpointSummary),
    // WP5.3:本月方法候选全量(含 proposed/confirmed/rejected),agent 据此判断是否提议新候选
    methodChangeProposals: methodChangeProposals.map((r) => ({
      id: r.id,
      sourceType: r.sourceType,
      proposedChange: r.proposedChange,
      reason: r.reason,
      affectedResource: r.affectedResource,
      status: r.status,
      createdAt: r.createdAt,
    })),
    // WP5.6:本月行为纠偏统计
    behaviorStats,
  };
}

export async function saveSkillDailyReview(input: {
  userId?: string;
  instanceId?: string;
  date?: string;
  content: string;
  summary?: string;
  context?: unknown;
}): Promise<{ date: string; filePath: string }> {
  const userId = input.userId ?? DEFAULT_USER_ID;
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  const date = input.date ?? localDateString();
  ensureDir();
  const filePath =
    userId === DEFAULT_USER_ID
      ? join(REVIEWS_DIR, `${date}.md`)
      : join(REVIEWS_DIR, userId, `${date}.md`);
  if (userId !== DEFAULT_USER_ID) mkdirSync(join(REVIEWS_DIR, userId), { recursive: true });
  writeFileSync(filePath, input.content, "utf-8");
  await mirrorReviewToWorkspace(userId, "daily", date, input.content);

  const generatedAt = new Date().toISOString();
  const pushSummary = input.summary ?? buildWeixinReviewSummary(date, input.content);
  await dailyPlanBackend.upsert(userId, instanceId, {
    planDate: date,
    generatedAt,
    summary: pushSummary,
    content: input.content,
    data: {
      source: "skill",
      pushSummary,
      savedAt: generatedAt,
      context: input.context ?? null,
    },
  });
  await syncReviewViewpoints(userId, instanceId, date, input.content);
  logger.info(`skill 日复盘已保存: ${filePath}`);
  return { date, filePath };
}

/** 生成日复盘 */
export async function generateDailyReview(options: { force?: boolean; targetDate?: string; userId?: string; instanceId?: string } = {}): Promise<string> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const today = options.targetDate ?? localDateString();
  const generatedAt = new Date().toISOString();
  const filePath = userId === DEFAULT_USER_ID ? join(REVIEWS_DIR, `${today}.md`) : join(REVIEWS_DIR, userId, `${today}.md`);
  const legacyFilePath = userId === DEFAULT_USER_ID ? join(REVIEWS_DIR, `${today}.txt`) : join(REVIEWS_DIR, userId, `${today}.txt`);

  // 非强制模式且已有今日复盘，直接返回
  if (!options.force && existsSync(filePath)) {
    return readFileSync(filePath, "utf-8");
  }
  if (!options.force && existsSync(legacyFilePath)) {
    return readFileSync(legacyFilePath, "utf-8");
  }

  ensureDir();

  // 1. 收集数据
  const template = await getReviewTemplate();
  if (userId !== DEFAULT_USER_ID) mkdirSync(join(REVIEWS_DIR, userId), { recursive: true });
  const watchItems = await watchlistBackend.list(userId, instanceId);
  const positions = await portfolioBackend.listActive(userId, instanceId);
  const todayAlerts = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), eq(alertEvents.eventDate, today)));
  await updateAlertFeedback(userId, todayAlerts);

  const allCodes = new Map<string, { name: string; pool: "holding" | "watchlist" }>();
  for (const p of positions) {
    if (isReviewStockCode(p.code)) allCodes.set(p.code, { name: p.name, pool: "holding" });
  }
  for (const w of watchItems) {
    if (isReviewStockCode(w.code) && !allCodes.has(w.code)) {
      allCodes.set(w.code, { name: w.name, pool: "watchlist" });
    }
  }

  const isHistorical = !!options.targetDate;

  // 2. 大盘指数
  const sourceQuality: DailyReviewSourceQualityItem[] = [];
  const marketIndexLines = await reviewMarketIndexData({ userId, today, isHistorical, sourceQuality });

  // 3. 自选股行情（纯文字）
  const stockDescriptions: string[] = [];
  const planItems: StockPlanItem[] = [];

  for (const [code, meta] of allCodes) {
    try {
      const klineResult = await reviewKlinesResult(code, 120, userId, { endDate: isHistorical ? today : undefined });
      collectSourceQuality(sourceQuality, `${meta.name}(${code})日K`, klineResult.source);
      const klines = klineResult.items as StockKline[];
      const indicator = klines.length >= 30 ? indicatorCapability.analyzeIndicators(klines) : null;
      const levels = estimateLevels(klines);

      // 历史日期从 K 线取目标日收盘价；实时日期走服务层行情 facade。
      let price: number | undefined;
      let changePercent: number | undefined;

      if (isHistorical) {
        const dayK = klines.find(k => k.date === today) ?? klines[klines.length - 1];
        const prevK = dayK ? klines[klines.indexOf(dayK) - 1] : undefined;
        if (dayK) price = dayK.close;
        if (dayK && prevK) changePercent = (dayK.close - prevK.close) / prevK.close * 100;
      } else {
        const quoteResult = await reviewQuoteResult(code, userId);
        const quote = quoteResult.items[0];
        collectSourceQuality(sourceQuality, `${meta.name}(${code})实时行情`, quote?.source, quoteResult.warnings.join(";") || "missing_quote");
        price = quote?.price;
        changePercent = quote?.changePercent;
      }

      const observe = buildObserveRules(price, levels.support, levels.resistance, indicator?.summary);

      const trend = indicator?.trend.trendDesc ?? "-";
      const macd = indicator?.trend.macdSignal ? indicator.trend.macdSignal.replace(/^MACD\s*/, "") : "-";
      const vol = indicator?.volume.status ?? "-";
      const dir = (changePercent ?? 0) >= 0 ? "+" : "";
      stockDescriptions.push(
        `${meta.name}(${code}) ${isHistorical ? "收盘" : "现价"}${price ?? "-"} ${dir}${(changePercent ?? 0).toFixed(2)}% 趋势${trend} MACD${macd} 量能${vol}`
      );

      planItems.push({
        code,
        name: meta.name,
        pool: meta.pool,
        support: levels.support,
        resistance: levels.resistance,
        observe,
        risks: ["量价判断仅作参考", "重大公告需人工确认"],
        confidence: klines.length >= 60 ? "medium" : "low",
      });
    } catch {
      collectSourceQuality(sourceQuality, `${meta.name}(${code})行情`, null, "获取失败");
      stockDescriptions.push(`${meta.name}(${code}) 行情获取失败`);
      planItems.push({
        code, name: meta.name, pool: meta.pool,
        support: null, resistance: null,
        observe: ["行情获取失败"], risks: ["数据缺失"], confidence: "low",
      });
    }
  }

  // 4.5 信息面数据（新闻/研报/公告）
  let infoFilterText = "暂无重大信息。";
  if (template.sections.info_filter.enabled) {
    try {
      const stockList = [...allCodes.entries()].map(([code, meta]) => ({ code, name: meta.name }));
      const infos = await getStockInfoBatch(stockList, 3, 3, isHistorical ? today : undefined);
      infoFilterText = formatStockInfoForReview(infos);
    } catch {
      infoFilterText = "信息面数据获取失败，请人工确认。";
    }
  }

  // 5. AI 综合分析
  const focusBlock = template.focusPoints.length > 0
    ? `\n额外关注重点：${template.focusPoints.join("、")}`
    : "";
  const customBlock = template.customInstructions
    ? `\n用户自定义要求：${template.customInstructions}`
    : "";

  const aiPrompt = `请根据以下数据生成投资复盘总结，必须使用适合微信阅读的 Markdown；可以使用分段、列表和重点加粗，但不要机械套用复杂表格。

大盘指数：${marketIndexLines.join("、")}
持仓/自选股：${stockDescriptions.join("\n")}
信息面（新闻/研报/公告）：${infoFilterText}
今日提醒：${todayAlerts.length > 0 ? todayAlerts.map(a => `[${severityToPriorityLabel(a.severity)}] ${a.stockName} ${a.message}`).join("；") : "无"}
明日预案草案：${planItems.map(p => `${p.name} 支撑${p.support ?? "-"} 压力${p.resistance ?? "-"}`).join("；")}

要求：
1. 先总结今日市场整体表现（基于大盘指数数据）
2. 逐个简要分析持仓和自选股表现，结合信息面（如有重大公告、新闻或研报调整）
3. 信息面数据来自公开渠道，注意区分事实（公告）和观点（新闻/研报）
4. 列出明日关注要点,并按以下 6 大风险类别自检(无则跳过,不要编造):
   - portfolio:单一标的/行业集中度、现金安全垫、核心/非核心/观察仓角色漂移
   - market_structure:流动性、风格切换、相关性、估值分位
   - asset_specific:基本面、财报质量、治理监管、停牌退市信用
   - product_specific:ETF 跟踪误差、基金清盘、可转债强赎溢价、港股通汇率、商品联动
   - behavior:追高、频繁查询、临时改规则、忽略安全垫、单日涨跌改变长期判断
   - data_quality:行情延迟、财报缺失、新闻未核验、来源冲突
5. 提醒按 P0(需确认)→P1(关注)→P2(沉淀)顺序回应;P0 必须明确建议操作或不操作的依据
6. 事实、推断、建议分开表达，不要编造数据
7. 数据来源、时效、置信度和缺失项必须显式保留；新闻/研报未核验时只能作为 secondary 线索
8. 主力控盘如无确定性数据源，只在最后的数据限制中说明，不作为核心判断
9. 不构成投资建议${focusBlock}${customBlock}`;

  const aiAnalysis = await safeAi(aiPrompt, "deep");
  const planData: DailyPlanData = { date: today, generatedAt, items: planItems };
  const previousOpenViewpoints = await getOpenReviewViewpoints(userId, instanceId, today);

  // 6. 组装纯文本复盘（一份内容同时用于推送和存档）
  const s = template.sections;
  const parts: string[] = [`${today} 收盘复盘`, ""];

  if (s.market_overview.enabled) {
    parts.push(`【${s.market_overview.label}】`, ...marketIndexLines, "");
  }

  parts.push(...buildDailySourceQualitySection({
    generatedAt,
    today,
    isHistorical,
    hasStocks: allCodes.size > 0,
    missingStockNames: planItems.filter((item) => item.confidence === "low" && item.observe.includes("行情获取失败")).map((item) => item.name),
    infoFilterText,
    sourceQuality: compactSourceQuality(sourceQuality),
  }));

  if (s.holdings.enabled) {
    parts.push(`【${s.holdings.label}】`);
    const holdingStocks = stockDescriptions.filter((_, i) => [...allCodes.values()][i]?.pool === "holding");
    parts.push(...(holdingStocks.length > 0 ? holdingStocks : ["无持仓"]), "");
  }

  if (s.watchlist.enabled) {
    const watchOnly = watchItems.filter(w => !allCodes.has(w.code) || allCodes.get(w.code)?.pool === "watchlist");
    if (watchOnly.length > 0) {
      parts.push(`【${s.watchlist.label}】`);
      for (const w of watchOnly) {
        const desc = stockDescriptions.find(d => d.includes(w.code));
        if (desc) parts.push(desc);
      }
      parts.push("");
    }
  }

  if (s.info_filter.enabled && infoFilterText !== "暂无重大信息。") {
    parts.push(`【${s.info_filter.label}】`, infoFilterText, "");
  }

  if (s.plan.enabled) {
    parts.push(`【${s.plan.label}】`);
    for (const item of planItems) {
      const parts2 = [`${item.name}(${item.code})`];
      if (item.support) parts2.push(`支撑${item.support}`);
      if (item.resistance) parts2.push(`压力${item.resistance}`);
      if (item.observe.length > 0) parts2.push(item.observe[0]);
      parts.push(parts2.join(" "));
    }
    parts.push("");
  }

  if (s.ai_analysis.enabled) {
    if (todayAlerts.length > 0) {
      parts.push(...formatDailyAlertsByPriority(todayAlerts));
    }
    parts.push("【AI 分析】", aiAnalysis, "");
  }

  const viewpointBacktestTable = buildViewpointBacktestTable(previousOpenViewpoints);
  if (viewpointBacktestTable.length > 0) {
    parts.push(...viewpointBacktestTable);
  }

  const viewpointTrackingTable = buildViewpointTrackingTable(today, planItems, todayAlerts);
  if (viewpointTrackingTable.length > 0) {
    parts.push(...viewpointTrackingTable);
  }

  parts.push("【主力控盘情况】", "当前未接入可靠的主力控盘/筹码集中度/逐笔成交确定性数据源，本次不据此作判断。", "");
  parts.push("仅供参考，不构成投资建议");
  const reviewText = parts.join("\n");
  const pushSummary = buildWeixinReviewSummary(today, reviewText);

  writeFileSync(filePath, reviewText, "utf-8");
  await mirrorReviewToWorkspace(userId, "daily", today, reviewText);
  await saveDailyPlan(userId, instanceId, today, reviewText, { ...planData, pushSummary });
  await syncReviewViewpoints(userId, instanceId, today, reviewText);
  logger.info(`日复盘已生成: ${filePath}`);

  // 预案调整建议
  const suggestions = await buildPlanSuggestions(planItems, userId, instanceId);
  if (suggestions) {
    return reviewText + "\n\n" + suggestions;
  }
  return reviewText;
}

/** 生成周复盘 */
export async function generateWeeklyReview(options: { userId?: string; instanceId?: string } = {}): Promise<string> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const { weekStart: weekStartStr, weekEnd: weekEndStr } = weekRangeForDate();
  const weekKey = `${weekStartStr}_weekly`;
  const reviewDir = userId === DEFAULT_USER_ID ? REVIEWS_DIR : join(REVIEWS_DIR, userId);
  const filePath = join(reviewDir, `${weekKey}.md`);

  if (existsSync(filePath)) {
    return readFileSync(filePath, "utf-8");
  }

  ensureDir();
  if (userId !== DEFAULT_USER_ID) mkdirSync(reviewDir, { recursive: true });

  const watchItems = await watchlistBackend.list(userId, instanceId);
  const weekAlerts = await db
    .select()
    .from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId), gte(alertEvents.eventDate, weekStartStr), lte(alertEvents.eventDate, weekEndStr)))
    .orderBy(desc(alertEvents.createdAt));
  const viewpointSummary = await getWeeklyViewpointSummary(userId, instanceId, weekStartStr, weekEndStr);
  const viewpointSummaryText = formatWeeklyViewpointSummary(viewpointSummary);

  // 收集每只自选股的周度分析
  const weeklyData: string[] = [];
  for (const item of watchItems) {
    try {
      const klines = await reviewKlines(item.code, 30, userId);
      // 取本周 K 线
      const weekKlines = klines.filter(k => k.date >= weekStartStr && k.date <= weekEndStr);
      if (weekKlines.length === 0) continue;

      const firstClose = weekKlines[0].close;
      const lastClose = weekKlines[weekKlines.length - 1].close;
      const weekChange = ((lastClose - firstClose) / firstClose * 100).toFixed(2);
      const maxHigh = Math.max(...weekKlines.map(k => k.high));
      const minLow = Math.min(...weekKlines.map(k => k.low));
      const totalVol = weekKlines.reduce((s, k) => s + k.volume, 0);

      const indicator = klines.length >= 30 ? indicatorCapability.analyzeIndicators(klines) : null;

      weeklyData.push(`| ${item.name}(${item.code}) | ${firstClose} → ${lastClose} | ${weekChange}% | ${maxHigh} | ${minLow} | ${(totalVol / 10000).toFixed(0)}万手 | ${indicator?.trend.trendDesc || "-"} |`);
    } catch {
      weeklyData.push(`| ${item.name}(${item.code}) | 数据获取失败 | - | - | - | - | - |`);
    }
  }

  // AI 周度分析
  const aiPrompt = `请根据以下自选股本周表现，生成周度复盘。

本周数据 (${weekStartStr} ~ ${weekEndStr})：
${weeklyData.join("\n")}

本周提醒事件：
${formatAlertSummary(weekAlerts)}

本周观点追踪回测：
${viewpointSummaryText}

要求：
1. 总结本周市场整体走势
2. 逐个分析自选股本周表现
3. 根据提醒事件评估信号质量，区分命中、误报、待验证;P0(需确认)事件必须在分析中明确回应
4. 根据结构化观点追踪统计，指出本周判断质量、误判来源和仍需验证的观点
5. 提出下周关注方向,按以下 6 大风险类别自检(无则跳过,不要编造):
   - portfolio:单一标的/行业集中度、现金安全垫、核心/非核心/观察仓角色漂移
   - market_structure:流动性、风格切换、相关性、估值分位
   - asset_specific:基本面、财报质量、治理监管、停牌退市信用
   - product_specific:ETF 跟踪误差、基金清盘、可转债强赎溢价、港股通汇率、商品联动
   - behavior:追高、频繁查询、临时改规则、忽略安全垫、单日涨跌改变长期判断
   - data_quality:行情延迟、财报缺失、新闻未核验、来源冲突
6. 明确主力控盘等直接数据当前缺失
7. 不构成投资建议`;

  const aiAnalysis = await safeAi(aiPrompt, "deep");

  const md = [
    `# ${weekStartStr} ~ ${weekEndStr} 周复盘`,
    "",
    `> 生成时间: ${new Date().toISOString()}`,
    "",
    "## 本周自选股表现",
    "",
    "| 股票 | 周初→周末 | 涨跌幅 | 最高 | 最低 | 总成交量 | 趋势 |",
    "|------|----------|--------|------|------|---------|------|",
    ...weeklyData,
    "",
    "## 本周提醒反馈",
    "",
    formatAlertSummary(weekAlerts),
    "",
    "## 本周观点追踪回测",
    "",
    viewpointSummaryText,
    "",
    "## AI 周度分析",
    "",
    aiAnalysis,
    "",
    "---",
    "*本复盘由 AI 生成，仅供参考，不构成投资建议*",
  ].join("\n");

  writeFileSync(filePath, md, "utf-8");
  await mirrorReviewToWorkspace(userId, "weekly", weekKey, md);
  logger.info(`周复盘已生成: ${filePath}`);

  return md;
}

async function updateAlertFeedback(
  userId: string,
  alerts: Array<{
    id: number;
    stockCode: string;
    eventType: string;
    signalKey: string;
    price: number | null;
    status: string;
    feedback: string | null;
  }>
) {
  for (const event of alerts) {
    if (event.status !== "pending" || event.price == null) continue;

    const current = (await reviewQuote(event.stockCode, userId))?.price;
    if (!current) continue;

    const change = ((current - event.price) / event.price) * 100;
    let status = "待验证";

    if (event.signalKey.includes("down") || event.signalKey.includes("dead")) {
      status = change < -1 ? "命中" : change > 1 ? "误报" : "待验证";
    } else if (event.signalKey.includes("near-support")) {
      status = change > 1 ? "命中" : change < -1 ? "误报" : "待验证";
    } else {
      status = change > 1 ? "命中" : change < -1 ? "误报" : "待验证";
    }

    await db.update(alertEvents).set({ status }).where(eq(alertEvents.id, event.id));
    event.status = status;
  }
}

function formatAlertSummary(
  alerts: Array<{
    eventDate: string;
    stockName: string;
    stockCode: string;
    eventType: string;
    message: string;
    relationToPlan: string;
    status: string;
    feedback: string | null;
    severity?: string | null;
  }>
): string {
  if (alerts.length === 0) return "本周期暂无提醒事件。";

  const counts = alerts.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});

  // WP3c:按 P0→P1→P2 排序(severity 别名 high/medium/low),同级按日期倒序。
  const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...alerts].sort((a, b) => {
    const ra = severityRank[a.severity ?? "medium"] ?? 1;
    const rb = severityRank[b.severity ?? "medium"] ?? 1;
    if (ra !== rb) return ra - rb;
    return b.eventDate.localeCompare(a.eventDate);
  });

  const lines = [
    `- 汇总: 命中 ${counts["命中"] ?? 0}，误报 ${counts["误报"] ?? 0}，待验证 ${counts["待验证"] ?? 0}，未评估 ${counts.pending ?? 0}`,
    "",
    "| 优先级 | 日期 | 股票 | 类型 | 预案关系 | 状态 | 用户反馈 | 提醒 |",
    "|--------|------|------|------|----------|------|----------|------|",
  ];

  for (const item of sorted) {
    const priority = severityToPriorityLabel(item.severity);
    lines.push(
      `| ${priority} | ${item.eventDate} | ${item.stockName}(${item.stockCode}) | ${item.eventType} | ${item.relationToPlan} | ${item.status} | ${item.feedback ?? "-"} | ${item.message} |`
    );
  }

  return lines.join("\n");
}

/** severity(high/medium/low) → P0/P1/P2 标签。 */
function severityToPriorityLabel(severity: string | null | undefined): "P0" | "P1" | "P2" {
  if (severity === "high") return "P0";
  if (severity === "low") return "P2";
  return "P1";
}

/**
 * 日复盘"今日提醒"段:按 P0/P1/P2 分组输出。
 * P0 段直接展示;P1/P2 仅显示计数,详情折叠到 AI 分析段。
 */
function formatDailyAlertsByPriority(
  alerts: Array<{
    stockName: string;
    message: string;
    status: string;
    severity?: string | null;
  }>
): string[] {
  const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...alerts].sort((a, b) => {
    const ra = severityRank[a.severity ?? "medium"] ?? 1;
    const rb = severityRank[b.severity ?? "medium"] ?? 1;
    return ra - rb;
  });

  const p0 = sorted.filter((a) => severityToPriorityLabel(a.severity) === "P0");
  const p1 = sorted.filter((a) => severityToPriorityLabel(a.severity) === "P1");
  const p2 = sorted.filter((a) => severityToPriorityLabel(a.severity) === "P2");

  const lines: string[] = ["【今日提醒】"];

  if (p0.length > 0) {
    lines.push(`P0(需确认):`);
    for (const a of p0) lines.push(`  ${a.stockName}: ${a.message}（${a.status}）`);
  }
  if (p1.length > 0) {
    lines.push(`P1(关注): ${p1.length} 条`);
    for (const a of p1.slice(0, 5)) lines.push(`  ${a.stockName}: ${a.message}（${a.status}）`);
    if (p1.length > 5) lines.push(`  ... 还有 ${p1.length - 5} 条`);
  }
  if (p2.length > 0) {
    lines.push(`P2(沉淀): ${p2.length} 条,详见 alert_events 表`);
  }
  if (p0.length === 0 && p1.length === 0 && p2.length === 0) {
    lines.push("无");
  }

  lines.push("");
  return lines;
}

/** 查询历史复盘 */
function queryReview(date: string, userId = DEFAULT_USER_ID): string {
  const baseDir = userId === DEFAULT_USER_ID ? REVIEWS_DIR : join(REVIEWS_DIR, userId);
  const mdPath = join(baseDir, `${date}.md`);
  const txtPath = join(baseDir, `${date}.txt`);
  const filePath = existsSync(mdPath) ? mdPath : txtPath;
  if (!existsSync(filePath)) {
    return `未找到 ${date} 的复盘记录`;
  }
  return readFileSync(filePath, "utf-8");
}

function estimateLevels(klines: Array<{ high: number; low: number }>): {
  support: number | null;
  resistance: number | null;
} {
  const recent = klines.slice(-20);
  if (recent.length < 5) return { support: null, resistance: null };
  const support = Math.min(...recent.map((k) => k.low));
  const resistance = Math.max(...recent.map((k) => k.high));
  return {
    support: Math.round(support * 100) / 100,
    resistance: Math.round(resistance * 100) / 100,
  };
}

function buildObserveRules(
  price?: number,
  support?: number | null,
  resistance?: number | null,
  indicatorSummary?: string
): string[] {
  const rules: string[] = [];
  if (support) rules.push(`关注是否跌破支撑位 ${support}`);
  if (resistance) rules.push(`关注是否放量突破压力位 ${resistance}`);
  if (price && support && price <= support * 1.03) rules.push("当前接近支撑区，观察是否缩量企稳");
  if (price && resistance && price >= resistance * 0.97) rules.push("当前接近压力区，观察是否放量突破");
  if (indicatorSummary) rules.push(`技术面摘要：${indicatorSummary}`);
  if (rules.length === 0) rules.push("数据不足，明日以价格和成交量变化为主观察");
  return rules;
}

async function saveDailyPlan(userId: string, instanceId: string, date: string, content: string, data: DailyPlanData) {
  await dailyPlanBackend.upsert(userId, instanceId, {
    planDate: date,
    generatedAt: data.generatedAt,
    summary: data.pushSummary ?? buildWeixinReviewSummary(date, content),
    content,
    data,
  });
}

export interface ReviewToolInput {
  operation: "generate_daily" | "generate_weekly" | "query";
  date?: string;
  userId?: string;
  instanceId?: string;
}

export async function handleReviewTool(input: ReviewToolInput): Promise<string> {
  const userId = input.userId ?? DEFAULT_USER_ID;
  const instanceId = input.instanceId ?? DEFAULT_INSTANCE_ID;
  switch (input.operation) {
    case "generate_daily":
      return generateDailyReview({ force: true, targetDate: input.date, userId, instanceId });
    case "generate_weekly":
      return generateWeeklyReview({ userId, instanceId });
    case "query":
      if (!input.date) return "请指定要查询的日期，格式 YYYY-MM-DD。";
      return queryReview(input.date, userId);
    default:
      return "不支持的复盘操作。";
  }
}

/** 输出预案建议：无预案的建议新建，有预案的建议调整 */
export async function buildPlanSuggestions(
  planItems: StockPlanItem[],
  userId = DEFAULT_USER_ID,
  instanceId = DEFAULT_INSTANCE_ID
): Promise<string> {
  if (planItems.length === 0) return "";

  const existingPlans = await planBackend.list(userId, instanceId);
  const planMap = new Map(existingPlans.map((p) => [p.code, p]));

  const newSuggestions: string[] = [];
  const adjustSuggestions: string[] = [];

  for (const item of planItems) {
    if (item.support == null || item.resistance == null) continue;
    const existing = planMap.get(item.code);

    if (!existing) {
      // 无预案：建议新建
      newSuggestions.push(
        `- ${item.name}(${item.code}): 支撑 ${item.support} | 压力 ${item.resistance}${item.observe.length > 0 ? ` | ${item.observe[0]}` : ""}`
      );
    } else {
      // 有预案：检查是否需要调整
      const parts: string[] = [];
      if (existing.support != null && Math.abs(item.support - existing.support) > existing.support * 0.02) {
        parts.push(`支撑位 ${existing.support} → ${item.support}`);
      }
      if (existing.resistance != null && Math.abs(item.resistance - existing.resistance) > existing.resistance * 0.02) {
        parts.push(`压力位 ${existing.resistance} → ${item.resistance}`);
      }
      if (parts.length > 0) {
        adjustSuggestions.push(`- ${item.name}(${item.code}): ${parts.join("，")}`);
      }
    }
  }

  const sections: string[] = [];
  if (newSuggestions.length > 0) {
    sections.push(
      `【预案建议】（以下股票暂无交易预案，基于近20日K线估算）`,
      ...newSuggestions,
      `可以说"按建议设置预案"快速创建（用 K 线估算值）,`,
      `或者说"按我的 X 策略给 Y 出预案"走 invest-agent-strategy-plan-drafting 流程起草。`
    );
  }
  if (adjustSuggestions.length > 0) {
    sections.push(
      `【预案调整建议】（基于近20日K线估算，变化超过2%）`,
      ...adjustSuggestions,
      `可以说"重新评估 Y 的预案",会基于现有预案 + 当天行情走两道闸门流程。`
    );
  }

  return sections.length > 0 ? sections.join("\n") : "";
}

async function safeAi(prompt: string, profile: "light" | "deep" = "light"): Promise<string> {
  try {
    return await callDeepSeek(prompt, undefined, [], {
      profile,
      thinking: profile === "deep",
      reasoningEffort: "high",
      maxTokens: profile === "deep" ? 4000 : 2000,
    });
  } catch (error) {
    logger.warn(`AI 复盘不可用: ${(error as Error).message}`);
    return [
      "AI 分析暂时不可用。",
      "",
      "事实：系统已完成行情、自选股、持仓和预案草案整理。",
      "推断：由于模型调用失败，无法生成更深入的行业或基本面分析。",
      "建议：请先人工检查明日预案中的支撑位、压力位和风险点。",
    ].join("\n");
  }
}

export interface ReviewTemplateToolInput {
  operation: "query" | "update";
  sectionKey?: string;
  enabled?: boolean;
  label?: string;
  focusPoints?: string[];
  customInstructions?: string;
}

export async function handleReviewTemplateTool(input: ReviewTemplateToolInput): Promise<string> {
  if (input.operation === "query") {
    const template = await getReviewTemplate();
    const lines = ["【复盘模板配置】", ""];
    const sectionNames: Record<string, string> = {
      market_overview: "市场概况",
      holdings: "持仓分析",
      watchlist: "自选股机会",
      capital_flow: "资金流向（已从日复盘停用）",
      info_filter: "重大信息过滤",
      plan: "明日交易预案",
      ai_analysis: "AI 判断记录",
    };
    for (const [key, name] of Object.entries(sectionNames)) {
      const s = template.sections[key as keyof typeof template.sections];
      lines.push(`- ${name}(${key}): ${s.enabled ? "开启" : "关闭"} — 标题: "${s.label}"`);
    }
    if (template.focusPoints.length > 0) {
      lines.push("", "关注重点:", ...template.focusPoints.map(f => `  - ${f}`));
    }
    if (template.customInstructions) {
      lines.push("", "自定义要求:", `  ${template.customInstructions}`);
    }
    return lines.join("\n");
  }

  if (input.operation === "update") {
    const template = await getReviewTemplate();

    if (input.sectionKey) {
      const section = template.sections[input.sectionKey as keyof typeof template.sections];
      if (!section) return `未知的章节: ${input.sectionKey}。可选: ${Object.keys(template.sections).join(", ")}`;
      if (input.enabled !== undefined) section.enabled = input.enabled;
      if (input.label !== undefined) section.label = input.label;
    }

    if (input.focusPoints !== undefined) {
      template.focusPoints = input.focusPoints;
    }
    if (input.customInstructions !== undefined) {
      template.customInstructions = input.customInstructions;
    }

    await saveReviewTemplate(template);
    return "复盘模板已更新。";
  }

  return "不支持的操作。支持: query, update";
}

/** 供 scheduler 获取最近复盘的推送文本 */
export async function getLatestReviewPushSummary(options: { userId?: string; instanceId?: string } = {}): Promise<string | null> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const row = await dailyPlanBackend.getLatest(userId, instanceId);
  if (!row) return null;
  const content = row.content || "";
  if (!content || content.startsWith("Daily plan") || content.startsWith("Experimental")) return null;
  return row.summary || buildWeixinReviewSummary(row.planDate, content);
}

export async function getLatestReviewPreMarketContext(options: { userId?: string; instanceId?: string } = {}): Promise<{
  date: string;
  coreConclusion: string;
  observationFocus: string;
} | null> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const row = await dailyPlanBackend.getLatest(userId, instanceId);
  if (!row) return null;

  const content = row.content || row.summary || "";
  if (!content || content.startsWith("Daily plan") || content.startsWith("Experimental")) return null;

  const coreConclusion = summarizeReview(content);
  const observationFocus = [
    extractSection(content, /##\s*七[、.．]\s*明日操作与观察|【明日关注】|【明日交易预案】|【明日关注】|明日重点|明日操作与观察/),
    extractSection(content, /##\s*九[、.．]\s*观点追踪表|观点追踪表/),
  ]
    .filter(Boolean)
    .join("\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^[:|\-\s]+$/.test(line.replace(/\|/g, "")))
    .slice(0, 12)
    .join("\n")
    .slice(0, 1600);

  return {
    date: row.planDate,
    coreConclusion,
    observationFocus,
  };
}
