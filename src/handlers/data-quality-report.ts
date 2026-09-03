/**
 * 服务层数据源质量告警与每日汇总。
 *
 * 数据源运行遥测与可评测性属于平台服务资产,不写入用户 workspace。
 * workspace 只保留与投资判断直接相关的业务 source_events / alert reports。
 */

import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { beijingDateKey } from "../lib/market-calendar.js";
import {
  readTelemetryByDate,
  setAlertSink,
  type ProviderName,
  type MarketDataProvider,
} from "../services/source-telemetry.js";

export type DataQualitySeverity = "P1" | "P2" | "P3";

export interface DataQualityAlertEvent {
  severity: DataQualitySeverity;
  provider: ProviderName;
  runtimeProvider: MarketDataProvider;
  endpoint: string;
  message: string;
  detail?: Record<string, unknown> | null;
}

interface DataQualityBucket {
  provider: ProviderName;
  runtimeProvider: MarketDataProvider;
  endpoint: string;
  total: number;
  failed: number;
  degraded: number;
  recovered: number;
  longestFailStreak: number;
  currentStreak: number;
  lastReason: string;
  p95Latency: number[];
}

interface SourceQualitySummary {
  ok: true;
  dateKey: string;
  generatedAt: string;
  eventCount: number;
  endpointsTouched: number;
  totalFailures: number;
  totalDegraded: number;
  longestFailureStreak: number;
  endpoints: Array<{
    provider: ProviderName;
    runtimeProvider: MarketDataProvider;
    endpoint: string;
    total: number;
    failed: number;
    degraded: number;
    recovered: number;
    longestFailStreak: number;
    lastReason: string;
    p95LatencyMs: number | null;
  }>;
}

function todayKey(): string {
  // 文件按北京日历日落键，与调度器传入的 beijingDateKey 口径一致。
  return beijingDateKey();
}

function qualityFilePath(dateKey: string, ext: "md" | "json" | "jsonl") {
  return join(config.runtimeData.sourceQualityDir, `${dateKey}.${ext}`);
}

async function appendDataQualityAlert(userId: string, event: DataQualityAlertEvent): Promise<void> {
  const filePath = qualityFilePath(todayKey(), "jsonl");
  try {
    await mkdir(config.runtimeData.sourceQualityDir, { recursive: true });
    await appendFile(filePath, JSON.stringify({
      type: "source_quality_alert",
      userId,
      ...event,
      created_at: new Date().toISOString(),
    }) + "\n", "utf-8");
  } catch (error) {
    logger.warn(`data-quality.alert append failed user=${userId} provider=${event.provider}: ${(error as Error).message}`);
  }
}

/**
 * 注册告警 sink 给 services/source-telemetry.ts 使用,避免循环依赖。
 * 必须在 server 启动早期调用一次。
 */
export function registerDataQualityAlertSink(): void {
  setAlertSink({
    async appendAlert(userId, event) {
      await appendDataQualityAlert(userId, event);
    },
  });
}

/**
 * 扫描服务层 data/source-telemetry/YYYY-MM-DD.jsonl,聚合成平台级数据质量日报。
 *
 * 触发时机:每个交易日收盘后(15:30 由 scheduler 触发)。
 */
export async function generateDailyDataQualityReport(dateKey = todayKey()): Promise<{
  ok: true;
  filePath: string;
  jsonPath: string;
  endpointsTouched: number;
  totalFailures: number;
  longestFailureStreak: number;
}> {
  const events = await readTelemetryByDate(dateKey);
  const byKey = new Map<string, DataQualityBucket>();

  for (const ev of events) {
    if (ev.type !== "source_telemetry_event") continue;
    const key = `${ev.provider}:${ev.endpoint}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        provider: ev.provider,
        runtimeProvider: ev.runtimeProvider,
        endpoint: ev.endpoint,
        total: 0,
        failed: 0,
        degraded: 0,
        recovered: 0,
        longestFailStreak: 0,
        currentStreak: 0,
        lastReason: "",
        p95Latency: [],
      };
      byKey.set(key, bucket);
    }
    bucket.total += 1;
    if (ev.reason === "failed") {
      bucket.failed += 1;
      bucket.currentStreak += 1;
      bucket.longestFailStreak = Math.max(bucket.longestFailStreak, bucket.currentStreak);
    } else if (ev.reason === "recovered") {
      bucket.recovered += 1;
      bucket.currentStreak = 0;
    } else if (ev.reason === "degraded") {
      bucket.degraded += 1;
    }
    bucket.lastReason = ev.reason;
    if (typeof ev.latencyMs === "number") bucket.p95Latency.push(ev.latencyMs);
  }

  const buckets = [...byKey.values()].sort((a, b) => b.failed - a.failed || a.provider.localeCompare(b.provider));
  const totalFailures = buckets.reduce((sum, b) => sum + b.failed, 0);
  const totalDegraded = buckets.reduce((sum, b) => sum + b.degraded, 0);
  const longestFailureStreak = buckets.reduce((max, b) => Math.max(max, b.longestFailStreak), 0);
  const summary: SourceQualitySummary = {
    ok: true as const,
    dateKey,
    generatedAt: new Date().toISOString(),
    eventCount: events.length,
    endpointsTouched: byKey.size,
    totalFailures,
    totalDegraded,
    longestFailureStreak,
    endpoints: buckets.map((b) => ({
      provider: b.provider,
      runtimeProvider: b.runtimeProvider,
      endpoint: b.endpoint,
      total: b.total,
      failed: b.failed,
      degraded: b.degraded,
      recovered: b.recovered,
      longestFailStreak: b.longestFailStreak,
      lastReason: b.lastReason,
      p95LatencyMs: percentile(b.p95Latency, 0.95),
    })),
  };

  const mdPath = qualityFilePath(dateKey, "md");
  const jsonPath = qualityFilePath(dateKey, "json");
  await mkdir(config.runtimeData.sourceQualityDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(summary, null, 2), "utf-8");
  await writeFile(mdPath, renderMarkdown(summary), "utf-8");

  return {
    ok: true,
    filePath: mdPath,
    jsonPath,
    endpointsTouched: byKey.size,
    totalFailures,
    longestFailureStreak,
  };
}

function renderMarkdown(summary: SourceQualitySummary) {
  const lines: string[] = [];
  lines.push(`# ${summary.dateKey} 数据源运行质量`);
  lines.push("");
  lines.push(`- generatedAt: ${summary.generatedAt}`);
  lines.push(`- telemetry events: ${summary.eventCount}`);
  lines.push(`- endpoints touched: ${summary.endpointsTouched}`);
  lines.push(`- failures: ${summary.totalFailures}`);
  lines.push(`- degraded: ${summary.totalDegraded}`);
  lines.push(`- longest failure streak: ${summary.longestFailureStreak}`);
  lines.push("");
  if (summary.endpoints.length === 0) {
    lines.push("_当日无 source_telemetry_event 记录。_");
    lines.push("");
    return lines.join("\n");
  }
  lines.push("| Provider | Endpoint | 失败/降级/总 | 恢复次数 | 最长连续失败 | p95 延迟(ms) | Last |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const item of summary.endpoints) {
    lines.push(`| ${item.provider} | ${item.endpoint} | ${item.failed}/${item.degraded}/${item.total} | ${item.recovered} | ${item.longestFailStreak} | ${item.p95LatencyMs ?? "-"} | ${item.lastReason || "-"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}
