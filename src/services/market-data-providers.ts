/**
 * 数据源 provider 权威表与调用埋点。
 *
 * 设计原则:数据源服务**独立于 workspace**。
 *   - provider 实现细节(endpoint URL / confidence / category)是服务层契约,所有 workspace 共享
 *   - 调用遥测(source_telemetry_event)写到服务层 data/source-telemetry/YYYY-MM-DD.jsonl,
 *     与 sqlite db 同在 data/ 下(gitignore),workspace 内不感知
 *   - 进程内 endpointStats 是全局的,不按用户分目录;telemetry 记录里带 userId 标签
 *
 * 该模块是 provider 表的 SSOT。market-data.ts 的 sourceMeta() 引用此表(消除硬编码重复),
 * handlers/data-quality-report.ts 读 telemetry jsonl 生成服务层每日汇总。
 */

import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";

export type MarketDataProvider = "tencent" | "sina" | "eastmoney" | "tushare" | "tdx" | "web" | "service";
export type MarketDataConfidence = "high" | "medium" | "low";
export type EvidenceLevel = "primary_fact" | "secondary_evidence" | "signal" | "operational";

export type ProviderName =
  | "tencent_quote"
  | "tencent_kline_d"
  | "tencent_kline_m5"
  | "tencent_indices"
  | "tencent_search"
  | "sina_quote"
  | "sina_kline_d"
  | "sina_indices"
  | "service_calendar_cn_ashare"
  | "eastmoney_sector_theme"
  | "eastmoney_stock_news"
  | "eastmoney_finance_search"
  | "sogou_web_search"
  | "searxng_web_search"
  | "public_web_page"
  | "eastmoney_stock_reports"
  | "cninfo_announcements"
  | "eastmoney_flow"
  | "tushare_daily"
  | "tushare_daily_basic"
  | "tushare_trade_cal"
  | "tdx_mcp_fundamentals";

export interface ProviderMeta {
  /** 细粒度 provider 标识,程序内部使用 */
  name: ProviderName;
  /** 粗粒度 provider 标签(给用户/AI 看的 sourceMeta.provider 用) */
  runtimeProvider: MarketDataProvider;
  endpoint: string;
  confidence: MarketDataConfidence;
  evidenceLevel: EvidenceLevel;
  usageBoundary: string;
  category:
    | "quote"
    | "kline_day"
    | "kline_5min"
    | "indices"
    | "resolve"
    | "capital_flow"
    | "trading_calendar"
    | "sector_theme"
    | "news"
    | "web_search"
    | "web_page"
    | "research_report"
    | "announcement"
    | "fundamentals";
}

const PROVIDERS: Record<ProviderName, ProviderMeta> = {
  tencent_quote: {
    name: "tencent_quote",
    runtimeProvider: "tencent",
    endpoint: "qt.gtimg.cn/q",
    confidence: "high",
    evidenceLevel: "primary_fact",
    usageBoundary: "可作为价格/涨跌幅事实,但异常状态需结合 fallback 和交易日历判断。",
    category: "quote",
  },
  tencent_kline_d: {
    name: "tencent_kline_d",
    runtimeProvider: "tencent",
    endpoint: "web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    confidence: "high",
    evidenceLevel: "primary_fact",
    usageBoundary: "可作为技术指标输入,复权口径与完整性需记录。",
    category: "kline_day",
  },
  tencent_kline_m5: {
    name: "tencent_kline_m5",
    runtimeProvider: "tencent",
    endpoint: "ifzq.gtimg.cn/appstock/app/kline/mkline",
    confidence: "medium",
    evidenceLevel: "signal",
    usageBoundary: "仅作盘中观察和短周期信号,不能单独支撑买卖结论。",
    category: "kline_5min",
  },
  tencent_indices: {
    name: "tencent_indices",
    runtimeProvider: "tencent",
    endpoint: "qt.gtimg.cn/q",
    confidence: "high",
    evidenceLevel: "primary_fact",
    usageBoundary: "可作为市场背景事实,主题/行业归因需结合板块数据。",
    category: "indices",
  },
  tencent_search: {
    name: "tencent_search",
    runtimeProvider: "tencent",
    endpoint: "smartbox.gtimg.cn/s3",
    confidence: "medium",
    evidenceLevel: "operational",
    usageBoundary: "仅用于代码解析和候选匹配,不是投资证据。",
    category: "resolve",
  },
  sina_quote: {
    name: "sina_quote",
    runtimeProvider: "sina",
    endpoint: "hq.sinajs.cn/list",
    confidence: "medium",
    evidenceLevel: "primary_fact",
    usageBoundary: "作为行情 fallback 和交叉校验来源,与主源冲突时标记 degraded。",
    category: "quote",
  },
  sina_kline_d: {
    name: "sina_kline_d",
    runtimeProvider: "sina",
    endpoint: "money.finance.sina.com.cn/CN_MarketData.getKLineData",
    confidence: "medium",
    evidenceLevel: "primary_fact",
    usageBoundary: "作为日 K fallback,不保证与腾讯复权口径一致。",
    category: "kline_day",
  },
  sina_indices: {
    name: "sina_indices",
    runtimeProvider: "sina",
    endpoint: "hq.sinajs.cn/list",
    confidence: "medium",
    evidenceLevel: "primary_fact",
    usageBoundary: "作为指数 fallback 和交叉校验来源。",
    category: "indices",
  },
  service_calendar_cn_ashare: {
    name: "service_calendar_cn_ashare",
    runtimeProvider: "service",
    endpoint: "service://calendar/cn-ashare",
    confidence: "medium",
    evidenceLevel: "operational",
    usageBoundary: "用于调度、stale 判断和交易时段识别,不构成投资判断本身。",
    category: "trading_calendar",
  },
  eastmoney_sector_theme: {
    name: "eastmoney_sector_theme",
    runtimeProvider: "eastmoney",
    endpoint: "emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "用于行业/主题归因和筛选线索,不是投资结论。",
    category: "sector_theme",
  },
  eastmoney_stock_news: {
    name: "eastmoney_stock_news",
    runtimeProvider: "eastmoney",
    endpoint: "np-listapi.eastmoney.com/comm/wap/getListInfo",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "新闻只能作为线索,重大事项需公告或监管来源确认。",
    category: "news",
  },
  eastmoney_finance_search: {
    name: "eastmoney_finance_search",
    runtimeProvider: "eastmoney",
    endpoint: "search-api-web.eastmoney.com/search/jsonp",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "用于公开财经新闻和事件线索检索；标题与摘要不是公告或专业数据，重要事实必须继续核验。",
    category: "news",
  },
  sogou_web_search: {
    name: "sogou_web_search",
    runtimeProvider: "web",
    endpoint: "www.sogou.com/web",
    confidence: "low",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "通用网页搜索用于发现来源；搜索摘要不是事实，必须打开原文核验。生产可通过配置切换到自建 SearXNG。",
    category: "web_search",
  },
  searxng_web_search: {
    name: "searxng_web_search",
    runtimeProvider: "web",
    endpoint: "configured SearXNG JSON endpoint",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "聚合搜索结果用于发现来源；搜索摘要不是事实，必须打开原文核验。",
    category: "web_search",
  },
  public_web_page: {
    name: "public_web_page",
    runtimeProvider: "web",
    endpoint: "validated public HTTP(S) page",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "清洗后的公开页面正文用于证据核验；来源权威性仍需由 Agent 判断，不能替代正式披露。",
    category: "web_page",
  },
  eastmoney_stock_reports: {
    name: "eastmoney_stock_reports",
    runtimeProvider: "eastmoney",
    endpoint: "reportapi.eastmoney.com/report/list",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "研报是观点材料,不能单独支撑买卖确认。",
    category: "research_report",
  },
  cninfo_announcements: {
    name: "cninfo_announcements",
    runtimeProvider: "service",
    endpoint: "www.cninfo.com.cn/new/hisAnnouncement/query + eastmoney announcements fallback",
    confidence: "high",
    evidenceLevel: "primary_fact",
    usageBoundary: "公告可作为事实来源,但重大性和投资影响仍需人工/规则判断。",
    category: "announcement",
  },
  eastmoney_flow: {
    name: "eastmoney_flow",
    runtimeProvider: "eastmoney",
    endpoint: "emdatah5.eastmoney.com/dc/ZJLX/getZJLXData",
    confidence: "medium",
    evidenceLevel: "signal",
    usageBoundary: "资金流只作观察信号,不能证明主力控盘或单独触发交易。",
    category: "capital_flow",
  },
  tushare_daily: {
    name: "tushare_daily",
    runtimeProvider: "tushare",
    endpoint: "api.tushare.pro/daily",
    confidence: "high",
    evidenceLevel: "primary_fact",
    usageBoundary: "用于经授权的日线事实和交叉校验；复权、权限和返回日期必须随结果记录。",
    category: "kline_day",
  },
  tushare_daily_basic: {
    name: "tushare_daily_basic",
    runtimeProvider: "tushare",
    endpoint: "api.tushare.pro/daily_basic",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "用于估值与换手等结构化参考，报告期和交易日期必须明确；不能替代正式财报。",
    category: "fundamentals",
  },
  tushare_trade_cal: {
    name: "tushare_trade_cal",
    runtimeProvider: "tushare",
    endpoint: "api.tushare.pro/trade_cal",
    confidence: "high",
    evidenceLevel: "operational",
    usageBoundary: "用于交易日历交叉校验和补齐，临时休市仍需以交易所公告为准。",
    category: "trading_calendar",
  },
  tdx_mcp_fundamentals: {
    name: "tdx_mcp_fundamentals",
    runtimeProvider: "tdx",
    endpoint: "official TDX MCP fixed fundamentals prompt",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "仅接受服务层固定提问并校验结构化字段；返回值需要带报告期，不能替代公告或正式财报。",
    category: "fundamentals",
  },
};

export function getProvider(name: ProviderName): ProviderMeta {
  const meta = PROVIDERS[name];
  if (!meta) throw new Error(`UNKNOWN_PROVIDER:${name}`);
  return meta;
}

export function listProviders(): ProviderMeta[] {
  return Object.values(PROVIDERS);
}

// ============ EndpointStat:进程内调用统计(状态变化驱动落盘) ============

export interface EndpointStat {
  provider: ProviderName;
  runtimeProvider: MarketDataProvider;
  endpoint: string;
  confidence: MarketDataConfidence;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  recentLatencies: number[];
  lastStatus: "ok" | "fail" | "degraded" | "unknown";
  lastError: string | null;
}

const ENDPOINT_LATENCY_WINDOW = 20;
const endpointStats = new Map<string, EndpointStat>();

function statKey(provider: ProviderName) {
  return provider;
}

function getOrCreateStat(meta: ProviderMeta): EndpointStat {
  const key = statKey(meta.name);
  let stat = endpointStats.get(key);
  if (!stat) {
    stat = {
      provider: meta.name,
      runtimeProvider: meta.runtimeProvider,
      endpoint: meta.endpoint,
      confidence: meta.confidence,
      consecutiveFailures: 0,
      totalCalls: 0,
      totalFailures: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      recentLatencies: [],
      lastStatus: "unknown",
      lastError: null,
    };
    endpointStats.set(key, stat);
  }
  return stat;
}

function pushLatency(stat: EndpointStat, ms: number) {
  stat.recentLatencies.push(ms);
  if (stat.recentLatencies.length > ENDPOINT_LATENCY_WINDOW) stat.recentLatencies.shift();
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

/** 同步快照所有 endpoint 的运行状态,给 marketHealth 用。 */
export function snapshotEndpointStats(): EndpointStat[] {
  return listProviders().map((meta) => getOrCreateStat(meta));
}

export async function recordSourceDegraded(
  provider: ProviderName,
  userId: string | null,
  message: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const meta = getProvider(provider);
  const stat = getOrCreateStat(meta);
  const now = new Date().toISOString();
  stat.totalCalls += 1;
  stat.lastStatus = "degraded";
  stat.lastError = message;
  await appendTelemetry({
    id: randomUUID(),
    type: "source_telemetry_event",
    provider: meta.name,
    runtimeProvider: meta.runtimeProvider,
    endpoint: meta.endpoint,
    ok: true,
    latencyMs: 0,
    error: JSON.stringify({ message, ...detail }).slice(0, 1000),
    consecutiveFailures: stat.consecutiveFailures,
    reason: "degraded",
    userId,
    created_at: now,
  });
}

// ============ Telemetry jsonl 落盘 ============

export type SourceTelemetryReason = "ok" | "failed" | "recovered" | "degraded";

export interface SourceTelemetryRecord {
  id: string;
  type: "source_telemetry_event";
  provider: ProviderName;
  runtimeProvider: MarketDataProvider;
  endpoint: string;
  ok: boolean;
  latencyMs: number;
  error: string | null;
  consecutiveFailures: number;
  reason: SourceTelemetryReason;
  /** 触发本次调用的用户(标签用,不影响存储路径) */
  userId: string | null;
  created_at: string;
}

function telemetryFilePath(dateKey: string): string {
  return join(config.runtimeData.sourceTelemetryDir, `${dateKey}.jsonl`);
}

function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

async function appendTelemetry(record: SourceTelemetryRecord): Promise<void> {
  const filePath = telemetryFilePath(todayKey());
  try {
    await mkdir(config.runtimeData.sourceTelemetryDir, { recursive: true });
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf-8");
  } catch (error) {
    logger.warn(
      `source.telemetry.append failed provider=${record.provider} endpoint=${record.endpoint}: ${(error as Error).message}`,
    );
  }
}

/**
 * 读取指定日期的全部 telemetry 记录。文件不存在返回空数组。
 * 给 handlers/data-quality-report.ts 每日汇总用。
 */
export async function readTelemetryByDate(dateKey: string): Promise<SourceTelemetryRecord[]> {
  const filePath = telemetryFilePath(dateKey);
  if (!existsSync(filePath)) return [];
  try {
    const raw = await readFile(filePath, "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SourceTelemetryRecord);
  } catch (error) {
    logger.warn(`source.telemetry.read failed date=${dateKey}: ${(error as Error).message}`);
    return [];
  }
}

// ============ withSourceEvent:埋点 wrapper ============

/** 告警触发阈值:连续失败达到该值时,append 一条 P1 到 workspace alerts 卡片。 */
export interface AlertSink {
  appendAlert(userId: string, event: {
    severity: "P1" | "P2" | "P3";
    provider: ProviderName;
    runtimeProvider: MarketDataProvider;
    endpoint: string;
    message: string;
    detail?: Record<string, unknown> | null;
  }): Promise<void>;
}

let alertSink: AlertSink | null = null;

/** 注入告警 sink(由 handlers/data-quality-report.ts 调用),避免循环依赖。 */
export function setAlertSink(sink: AlertSink): void {
  alertSink = sink;
}

/**
 * Provider 调用埋点 wrapper。
 * - 成功:更新内存计数器;只在 previousStatus=fail 时写一条 "recovered"
 * - 失败:更新内存计数器 + 总是写一条 "failed";连续失败达到阈值时通过 alertSink 触发 P1/P2 卡片
 * - 不吞异常,fn 抛什么,wrapper 原样抛出
 * - userId 只作为 telemetry / service-level quality alert 标签,不决定存储路径
 */
export async function withSourceEvent<T>(
  provider: ProviderName,
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const meta = getProvider(provider);
  const stat = getOrCreateStat(meta);
  const start = Date.now();
  try {
    const result = await fn();
    const latencyMs = Date.now() - start;
    const previousStatus = stat.lastStatus;
    stat.totalCalls += 1;
    stat.consecutiveFailures = 0;
    stat.lastSuccessAt = new Date().toISOString();
    pushLatency(stat, latencyMs);
    stat.lastError = null;
    stat.lastStatus = "ok";
    if (previousStatus === "fail") {
      await appendTelemetry({
        id: randomUUID(),
        type: "source_telemetry_event",
        provider: meta.name,
        runtimeProvider: meta.runtimeProvider,
        endpoint: meta.endpoint,
        ok: true,
        latencyMs,
        error: null,
        consecutiveFailures: stat.consecutiveFailures,
        reason: "recovered",
        userId,
        created_at: new Date().toISOString(),
      });
    }
    return result;
  } catch (err) {
    const latencyMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    stat.totalCalls += 1;
    stat.totalFailures += 1;
    stat.consecutiveFailures += 1;
    stat.lastFailureAt = new Date().toISOString();
    pushLatency(stat, latencyMs);
    stat.lastError = errorMsg;
    stat.lastStatus = "fail";
    await appendTelemetry({
      id: randomUUID(),
      type: "source_telemetry_event",
      provider: meta.name,
      runtimeProvider: meta.runtimeProvider,
      endpoint: meta.endpoint,
      ok: false,
      latencyMs,
      error: errorMsg,
      consecutiveFailures: stat.consecutiveFailures,
      reason: "failed",
      userId,
      created_at: new Date().toISOString(),
    });
    if (userId && alertSink) {
      const isFirstThreshold = stat.consecutiveFailures === 3;
      const isRepeatedThreshold = stat.consecutiveFailures > 3 && stat.consecutiveFailures % 10 === 0;
      if (isFirstThreshold || isRepeatedThreshold) {
        await alertSink.appendAlert(userId, {
          severity: isFirstThreshold ? "P1" : "P2",
          provider: meta.name,
          runtimeProvider: meta.runtimeProvider,
          endpoint: meta.endpoint,
          message: `连续失败 ${stat.consecutiveFailures} 次,最近错误:${errorMsg.slice(0, 200)}`,
          detail: {
            confidence: stat.confidence,
            lastSuccessAt: stat.lastSuccessAt,
          },
        });
      }
    }
    throw err;
  }
}
