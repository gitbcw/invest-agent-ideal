/**
 * L3a 复合指标巡检运行器
 *
 * 职责:
 *   1. 加载 workspace/config/composite_indicators.yaml(每次巡检都重新读,5min 一次开销可忽略)
 *   2. 对每只股票构建 source context(signals + indicators)
 *   3. 调用 CompositeIndicatorEngine.evaluate
 *   4. triggered 时返回结构化结果(供 alert-check 拼 AlertItem)
 *
 * 不负责:
 *   - 去重/状态机(走 alert-check 现有 filterAndRecordAlerts)
 *   - 推送(走现有 push 流程)
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CompositeIndicatorEngine, parseCompositeYaml, type CompositeIndicatorConfig } from "./composite-indicator-engine.js";
import { analyzeIndicators, computeMA, computeMACD, computeRSI, computeKDJ } from "./indicators.js";
import { logger } from "../lib/logger.js";
import type { StockKline } from "./market-types.js";

export interface L3aTriggeredItem {
  configKey: string;
  configName: string;
  reliability: "stable" | "experimental";
  score?: number;
  notes: string[];
}

/** builtin 信号触发后填这个集合,key 是 signal suffix 中的"指标 key"(下划线格式) */
export type BuiltinSignalSet = Set<string>;

interface StockContext {
  stockCode: string;
  klines: StockKline[];
  builtinSignals: BuiltinSignalSet;
}

/**
 * 解析 source 字符串到具体值。
 * - signal.<key>: 检查 builtinSignals 是否包含 key(下划线格式)
 * - indicator.<key>: 调 L1 算子算当前值
 */
function resolveSource(
  source: string,
  ctx: { builtinSignals: BuiltinSignalSet; indicatorsCache: Map<string, number> },
): number | boolean | undefined {
  if (source.startsWith("signal.")) {
    const key = source.slice("signal.".length);
    return ctx.builtinSignals.has(key);
  }
  if (source.startsWith("indicator.")) {
    const key = source.slice("indicator.".length);
    if (ctx.indicatorsCache.has(key)) return ctx.indicatorsCache.get(key);
    return undefined;
  }
  return undefined;
}

/** 预算 L1 indicator 值,放进 cache 供 source resolver 用 */
function buildIndicatorsCache(klines: StockKline[]): Map<string, number> {
  const cache = new Map<string, number>();
  if (klines.length === 0) return cache;
  const closes = klines.map((k) => k.close);

  try {
    const report = analyzeIndicators(klines);
    cache.set("volume_ratio", report.volume.ratioToAvg5);
  } catch {
    // klines 不足时 analyzeIndicators 可能抛错,忽略
  }

  try {
    const ma20 = computeMA(closes, 20).last;
    if (ma20 != null) cache.set("ma20", ma20);
  } catch {
    // 忽略
  }

  try {
    const macd = computeMACD(closes);
    if (macd.dif.length > 0) {
      cache.set("macd_dif", macd.dif[macd.dif.length - 1]);
      cache.set("macd_dea", macd.dea[macd.dea.length - 1]);
    }
  } catch {
    // 忽略
  }

  try {
    const rsi = computeRSI(closes, 6).last;
    if (rsi != null) cache.set("rsi", rsi);
  } catch {
    // 忽略
  }

  try {
    const kdj = computeKDJ(klines);
    if (kdj.d.length > 0) {
      cache.set("kdj_d", kdj.d[kdj.d.length - 1]);
      cache.set("kdj_k", kdj.k[kdj.k.length - 1]);
      cache.set("kdj_j", kdj.j[kdj.j.length - 1]);
    }
  } catch {
    // 忽略
  }

  return cache;
}

let cachedWorkspacePath: string | null = null;

async function resolveWorkspacePath(): Promise<string> {
  if (cachedWorkspacePath) return cachedWorkspacePath;
  const { ensureWorkspace } = await import("../lib/workspace.js");
  const { DEFAULT_USER_ID } = await import("../lib/user-context.js");
  const workspace = await ensureWorkspace({ userId: DEFAULT_USER_ID });
  cachedWorkspacePath = workspace.path;
  return cachedWorkspacePath;
}

async function loadL3aConfigs(): Promise<CompositeIndicatorConfig[]> {
  try {
    const workspacePath = await resolveWorkspacePath();
    const yamlPath = join(workspacePath, "config", "composite_indicators.yaml");
    if (!existsSync(yamlPath)) return [];
    const text = await readFile(yamlPath, "utf8");
    const parsed = parseCompositeYaml(text);
    // 跳过未签告知协议的 experimental
    return parsed.filter((c) => c.reliability !== "experimental" || c.user_acknowledged);
  } catch (err) {
    logger.warn(`L3a YAML 加载失败: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 对单只股票跑所有 L3a 复合指标。
 *
 * @returns 触发的指标列表(可能多条)
 */
export async function runL3aIndicatorsForStock(ctx: StockContext): Promise<L3aTriggeredItem[]> {
  const configs = await loadL3aConfigs();
  if (configs.length === 0) return [];

  const indicatorsCache = buildIndicatorsCache(ctx.klines);
  const engine = new CompositeIndicatorEngine();
  const triggered: L3aTriggeredItem[] = [];

  for (const cfg of configs) {
    const inputs: Record<string, number | boolean> = {};
    let allResolved = true;
    for (const inp of cfg.inputs) {
      const val = resolveSource(inp.source, { builtinSignals: ctx.builtinSignals, indicatorsCache });
      if (val === undefined) {
        allResolved = false;
        break;
      }
      inputs[inp.key] = val;
    }
    if (!allResolved) continue;

    try {
      const result = engine.evaluate(cfg, { inputs });
      if (result.triggered) {
        triggered.push({
          configKey: cfg.key,
          configName: cfg.name,
          reliability: cfg.reliability,
          score: result.score,
          notes: result.notes,
        });
      }
    } catch (err) {
      logger.warn(`L3a ${cfg.key} 求值失败 stock=${ctx.stockCode}: ${(err as Error).message}`);
    }
  }

  return triggered;
}
