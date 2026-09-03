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
import { beijingDateKey } from "../lib/market-calendar.js";

export type RuntimeDataProvider = "eastmoney" | "web";
export type MarketDataProvider = RuntimeDataProvider;
export type MarketDataConfidence = "high" | "medium" | "low";
export type EvidenceLevel = "primary_fact" | "secondary_evidence" | "signal" | "operational";

export type ProviderName =
  | "eastmoney_finance_search"
  | "sogou_web_search"
  | "searxng_web_search"
  | "doubao_web_search"
  | "public_web_page";

export interface ProviderMeta {
  /** 细粒度 provider 标识,程序内部使用 */
  name: ProviderName;
  /** 粗粒度 provider 标签(给用户/AI 看的 sourceMeta.provider 用) */
  runtimeProvider: RuntimeDataProvider;
  endpoint: string;
  confidence: MarketDataConfidence;
  evidenceLevel: EvidenceLevel;
  usageBoundary: string;
  category: "news" | "web_search" | "web_page";
}

const PROVIDERS: Record<ProviderName, ProviderMeta> = {
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
  doubao_web_search: {
    name: "doubao_web_search",
    runtimeProvider: "web",
    endpoint: "open.feedcoopapi.com/search_api/web_search",
    confidence: "medium",
    evidenceLevel: "secondary_evidence",
    usageBoundary: "豆包搜索 Custom 仅用于来源发现；返回的标题、摘要、相关度或正文内容都不能替代原文核验、公告、监管披露或结构化专业数据。",
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
  runtimeProvider: RuntimeDataProvider;
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
  runtimeProvider: RuntimeDataProvider;
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
  // 遥测按北京日历日落键，与日报读取（调度器 beijingDateKey）口径一致。
  return beijingDateKey(date);
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
    runtimeProvider: RuntimeDataProvider;
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
