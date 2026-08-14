/**
 * L3b 沙箱脚本指标巡检运行器
 *
 * 职责:
 *   1. 读 workspace/scripts/indicators/.registry.yaml(每次巡检都重新读)
 *   2. 过滤 enabled && (reliability !== experimental || user_acknowledged) && schedule === intraday
 *   3. 对每只股票用 ScriptIndicatorEngine 跑脚本
 *   4. result.values 中 boolean === true 的字段 → 触发 AlertItem
 *
 * 注意:
 *   - L3b 默认 schedule = daily_post_market,因此默认不会进 alert-check 巡检
 *   - 只有用户显式声明 schedule: intraday 的脚本,才在盘中 5 分钟轮询时执行
 *   - 单脚本 64MB / 5s 熔断,大量股票时注意性能开销
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { ScriptIndicatorEngine } from "./script-indicator-engine.js";
import type { IndicatorContext, IndicatorResult } from "./sandbox-runtime.js";
import type { StockKline } from "./market-types.js";

export interface L3bTriggeredItem {
  registryKey: string;
  registryName: string;
  reliability: "stable" | "experimental";
  /** 触发的字段名(可能是 crossed_up / crossed_down / 或自定义) */
  triggeredField: string;
  notes: string[];
  values: Record<string, number | string | boolean>;
}

interface StockContext {
  stockCode: string;
  klines: StockKline[];
}

interface RegistryEntry {
  key: string;
  name?: string;
  script: string;
  enabled?: boolean;
  reliability?: "stable" | "experimental";
  schedule?: "intraday" | "daily_post_market" | "on_signal";
  user_acknowledged?: boolean;
  description?: string;
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

/** 极简 YAML 解析:只处理 registry 这种 entry 列表 */
function parseRegistryYaml(text: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  let current: RegistryEntry | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (indent === 0 && trimmed.startsWith("- key:")) {
      if (current) entries.push(current);
      current = { key: trimmed.slice("- key:".length).trim(), script: "" };
      continue;
    }
    if (!current) continue;
    const m = /^([a-z_]+):\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const [, k, v] = m;
    const value = v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (k === "name") current.name = value;
    else if (k === "script") current.script = value;
    else if (k === "enabled") current.enabled = value === "true";
    else if (k === "reliability") {
      if (value === "stable" || value === "experimental") current.reliability = value;
    } else if (k === "schedule") {
      if (value === "intraday" || value === "daily_post_market" || value === "on_signal") {
        current.schedule = value;
      }
    } else if (k === "user_acknowledged") current.user_acknowledged = value === "true";
    else if (k === "description") current.description = value;
  }
  if (current) entries.push(current);
  return entries;
}

async function loadL3bRegistry(): Promise<{ entries: RegistryEntry[]; workspaceRoot: string }> {
  if (ACTIVE_BACKEND === "mastra") {
    // Persistent user scripts must not become executable runtime inputs. A
    // future implementation needs an explicit published asset + isolated
    // staging contract; fail closed until then.
    return { entries: [], workspaceRoot: "" };
  }
  const workspaceRoot = await resolveWorkspacePath();
  const registryPath = join(workspaceRoot, "scripts", "indicators", ".registry.yaml");
  if (!existsSync(registryPath)) return { entries: [], workspaceRoot };
  try {
    const text = await readFile(registryPath, "utf8");
    const all = parseRegistryYaml(text);
    // 只保留 enabled && (stable || user_acknowledged) && schedule === intraday
    const intraday = all.filter(
      (e) =>
        e.enabled !== false &&
        e.schedule === "intraday" &&
        (e.reliability !== "experimental" || e.user_acknowledged === true) &&
        !!e.script,
    );
    return { entries: intraday, workspaceRoot };
  } catch (err) {
    logger.warn(`L3b registry 加载失败: ${(err as Error).message}`);
    return { entries: [], workspaceRoot };
  }
}

/**
 * 对单只股票跑所有 intraday L3b 脚本。
 */
export async function runL3bIndicatorsForStock(ctx: StockContext): Promise<L3bTriggeredItem[]> {
  const { entries, workspaceRoot } = await loadL3bRegistry();
  if (entries.length === 0) return [];

  const engine = new ScriptIndicatorEngine({ workspaceRoot });
  const scriptsDir = join(workspaceRoot, "scripts", "indicators");
  const triggered: L3bTriggeredItem[] = [];

  for (const entry of entries) {
    // script 字段形如 "./double_ma_cross.ts"
    const scriptPath = join(scriptsDir, entry.script.replace(/^\.\//, ""));
    if (!existsSync(scriptPath)) {
      logger.warn(`L3b 脚本不存在: ${entry.script}`);
      continue;
    }

    const sandboxCtx: IndicatorContext = {
      klines: ctx.klines,
      turnovers: [],
      params: {},
    };

    try {
      const result: IndicatorResult = await engine.run(scriptPath, sandboxCtx);
      // result.values 中 boolean === true 的字段都视为触发
      for (const [field, value] of Object.entries(result.values ?? {})) {
        if (value === true) {
          triggered.push({
            registryKey: entry.key,
            registryName: entry.name ?? entry.key,
            reliability: entry.reliability ?? "stable",
            triggeredField: field,
            notes: result.notes ?? [],
            values: result.values,
          });
          break; // 一个脚本一次最多触发一条
        }
      }
    } catch (err) {
      logger.warn(`L3b ${entry.key} 求值失败 stock=${ctx.stockCode}: ${(err as Error).message}`);
    }
  }

  return triggered;
}
