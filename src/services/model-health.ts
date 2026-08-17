import { sqlite } from "../db/index.js";
import { logger } from "../lib/logger.js";

/**
 * W1 自动模型路由（docs/open-work-items.md）。P1 范围：
 * - 候选链按质量优先级 + 能力过滤（图片轮走豆包，纯文本走 DeepSeek）。
 * - 健康状态来自真实调用反馈（trace 写入时的成败 + 首字延迟）。
 * - 降级防抖：连续 2 个坏证据才降级；P1 回升 = 30 分钟冷却后乐观重试
 *   （重试失败只需 1 个新坏证据即再次降级）。P2 引入小时探针后替换回升语义。
 * - 全链不健康时按优先级硬选第 1 位。
 */

export interface AutoChainEntry {
  model: string;
  /** 仅作为能力兜底档（true = 仅图片轮可选）。 */
  imageTier?: boolean;
  /** 纯文本模型（true = 图片轮不可选，如 DeepSeek 系列）。 */
  textOnly?: boolean;
}

export const AUTO_MODEL_CHAIN: AutoChainEntry[] = [
  { model: "gpt-5.6-sol" },
  { model: "gpt-5.6-terra" },
  { model: "gpt-5.5" },
  { model: "doubao-seed-2-1-turbo-260628", imageTier: true },
  { model: "deepseek-v4-pro", textOnly: true },
];

/** UI 展示用的一句话定位说明（W2）。不在此列的模型不进入选择器。 */
export const MODEL_DESCRIPTIONS: Record<string, string> = {
  "gpt-5.6-sol": "旗舰质量，复杂分析与长推理首选",
  "gpt-5.6-terra": "高质量均衡档，日常深度分析推荐",
  "gpt-5.5": "上代旗舰，质量稳定，速度通常更快",
  "deepseek-v4-pro": "深度思考档，中文与工具调用强",
  "deepseek-v4-flash": "极速性价比档，仅手动可选",
  "doubao-seed-2-1-turbo-260628": "多模态档，支持图片理解",
};

const WINDOW_MS = 30 * 60 * 1000;
const SLOW_FIRST_TOKEN_MS = 30_000;
const MAX_ERROR_RATE = 0.2;
const DEGRADE_EVIDENCES = 2;
const RECOVERY_COOLDOWN_MS = 30 * 60 * 1000;
const PROBATION_GOOD_EVIDENCES = 2;
const MAX_EVENTS_PER_MODEL = 50;
const SETTINGS_KEY = "model_health_state";

interface FeedbackEvent {
  at: number;
  ok: boolean;
  firstTokenMs?: number;
}

interface ModelState {
  events: FeedbackEvent[];
  consecutiveBad: number;
  degradedAt?: number;
  /** 冷却期满后的缓刑期：连续 2 次好探针（或好真实调用）才恢复健康。 */
  probation?: number;
}

const states = new Map<string, ModelState>();
let loaded = false;
let nowFn: () => number = Date.now;

/** 测试钩子：重置内存态并注入时钟。 */
export function __resetModelHealthForTest(now?: () => number): void {
  states.clear();
  // 测试隔离：置 loaded=true 阻止从（可能残留的）旧库快照回灌状态。
  loaded = true;
  nowFn = now ?? Date.now;
}

function loadSnapshot(): void {
  if (loaded) return;
  loaded = true;
  try {
    const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row?.value) return;
    const parsed = JSON.parse(row.value) as Record<string, { events?: FeedbackEvent[]; consecutiveBad?: number; degradedAt?: number; probation?: number }>;
    for (const [model, saved] of Object.entries(parsed)) {
      if (!Array.isArray(saved.events)) continue;
      states.set(model, {
        events: saved.events.filter((event) => event && typeof event.at === "number").slice(-MAX_EVENTS_PER_MODEL),
        consecutiveBad: Number.isFinite(saved.consecutiveBad) ? Number(saved.consecutiveBad) : 0,
        ...(typeof saved.degradedAt === "number" ? { degradedAt: saved.degradedAt } : {}),
        ...(typeof saved.probation === "number" ? { probation: saved.probation } : {}),
      });
    }
  } catch (error) {
    logger.warn(`model-health snapshot load failed: ${(error as Error).message}`);
  }
}

function persistSnapshot(): void {
  try {
    const snapshot: Record<string, Partial<ModelState>> = {};
    for (const [model, state] of states.entries()) {
      // 只保留窗口内事件，避免快照无限增长。
      const cutoff = nowFn() - WINDOW_MS;
      const events = state.events.filter((event) => event.at >= cutoff);
      snapshot[model] = { events, consecutiveBad: state.consecutiveBad, ...(state.degradedAt !== undefined ? { degradedAt: state.degradedAt } : {}), ...(state.probation !== undefined ? { probation: state.probation } : {}) };
    }
    sqlite.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SETTINGS_KEY, JSON.stringify(snapshot));
  } catch (error) {
    logger.warn(`model-health snapshot persist failed: ${(error as Error).message}`);
  }
}

function stateFor(model: string): ModelState {
  loadSnapshot();
  let state = states.get(model);
  if (!state) {
    state = { events: [], consecutiveBad: 0 };
    states.set(model, state);
  }
  return state;
}

function isBadEvidence(ok: boolean, firstTokenMs?: number): boolean {
  if (!ok) return true;
  return firstTokenMs !== undefined && firstTokenMs > SLOW_FIRST_TOKEN_MS;
}

/** 每轮 trace 写入后的反馈入口：成败 + 首字延迟。 */
export function recordModelFeedback(model: string | undefined, input: { ok: boolean; firstTokenMs?: number }): void {
  if (!model) return;
  const state = stateFor(model);
  const now = nowFn();
  state.events.push({ at: now, ok: input.ok, ...(input.firstTokenMs !== undefined ? { firstTokenMs: Math.round(input.firstTokenMs) } : {}) });
  if (state.events.length > MAX_EVENTS_PER_MODEL) state.events.splice(0, state.events.length - MAX_EVENTS_PER_MODEL);
  if (isBadEvidence(input.ok, input.firstTokenMs)) {
    state.consecutiveBad += 1;
    if (state.consecutiveBad >= DEGRADE_EVIDENCES && state.degradedAt === undefined) {
      state.degradedAt = now;
      logger.info(`模型降级 model=${model} consecutiveBad=${state.consecutiveBad}（冷却 ${Math.round(RECOVERY_COOLDOWN_MS / 60000)} 分钟后乐观重试）`);
    }
  } else {
    state.consecutiveBad = 0;
    if (state.probation !== undefined) {
      state.probation += 1;
      if (state.probation >= PROBATION_GOOD_EVIDENCES) {
        delete state.probation;
        logger.info(`模型恢复 model=${model}（缓刑期内连续 ${PROBATION_GOOD_EVIDENCES} 次好证据）`);
      }
    }
  }
  persistSnapshot();
}

export interface ModelHealthView {
  model: string;
  healthy: boolean;
  inChain: boolean;
  reason: "no-data" | "degraded" | "probation" | "cooldown-retry" | "window-ok" | "window-bad";
  recentCalls: number;
  errorRate: number;
  p50FirstTokenMs: number | null;
  degradedAgoMs: number | null;
}

export function getModelHealth(model: string): ModelHealthView {
  const state = stateFor(model);
  const now = nowFn();
  const cutoff = now - WINDOW_MS;
  const events = state.events.filter((event) => event.at >= cutoff);
  const inChain = AUTO_MODEL_CHAIN.some((entry) => entry.model === model);
  const base = {
    model,
    inChain,
    recentCalls: events.length,
    degradedAgoMs: state.degradedAt !== undefined ? now - state.degradedAt : null,
  };
  if (state.degradedAt !== undefined) {
    if (now - state.degradedAt >= RECOVERY_COOLDOWN_MS) {
      // 冷却期满进入缓刑：不再计时降级，但需要连续 2 次好证据（探针或真实调用）才恢复。
      state.degradedAt = undefined;
      state.probation = state.probation ?? 0;
      persistSnapshot();
    } else {
      return { ...base, healthy: false, reason: "degraded", errorRate: events.length ? events.filter((event) => !event.ok).length / events.length : 0, p50FirstTokenMs: p50(events) };
    }
  }
  if (state.probation !== undefined) {
    if (state.probation >= PROBATION_GOOD_EVIDENCES) {
      delete state.probation;
      state.consecutiveBad = 0;
      persistSnapshot();
    } else {
      return { ...base, healthy: false, reason: "probation", errorRate: events.length ? events.filter((event) => !event.ok).length / events.length : 0, p50FirstTokenMs: p50(events) };
    }
  }
  if (events.length === 0) return { ...base, healthy: true, reason: "no-data", errorRate: 0, p50FirstTokenMs: null };
  // 健康判定只由降级状态（连续坏证据 + 防抖）决定；窗口统计仅供展示与诊断，
  // 不绕过防抖单独立判——否则单次慢调用就会触发降级抖动。
  const errorRate = events.filter((event) => !event.ok).length / events.length;
  return { ...base, healthy: true, reason: "window-ok", errorRate, p50FirstTokenMs: p50(events) };
}

function p50(events: FeedbackEvent[]): number | null {
  const values = events.map((event) => event.firstTokenMs).filter((value): value is number => typeof value === "number");
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export interface AutoRouteResult {
  model: string;
  skipped: Array<{ model: string; reason: ModelHealthView["reason"] }>;
}

/** 候选链解析：图片轮兜底走豆包，纯文本轮兜底走 DeepSeek Flash。 */
export function resolveAutoModel(input: { hasImage: boolean; exclude?: string[] }): AutoRouteResult {
  // 图片轮：GPT 三档 + 豆包（去掉 flash）；纯文本轮：GPT 三档 + pro（去掉豆包）。
  const excluded = new Set(input.exclude ?? []);
  const usable = AUTO_MODEL_CHAIN
    .filter((entry) => (input.hasImage ? entry.textOnly !== true : entry.imageTier !== true))
    .filter((entry) => !excluded.has(entry.model));
  const skipped: AutoRouteResult["skipped"] = [];
  for (const entry of usable) {
    const health = getModelHealth(entry.model);
    if (health.healthy) return { model: entry.model, skipped };
    skipped.push({ model: entry.model, reason: health.reason });
  }
  return { model: usable[0]?.model ?? AUTO_MODEL_CHAIN[0].model, skipped };
}

/** W1-P2 小时探针：对候选链模型发最小补全，测响应时延（近似首字）。
 *  结果走同一反馈通道；为降级后没有流量的模型提供恢复依据。 */
export async function runModelProbes(env: NodeJS.ProcessEnv = process.env): Promise<Array<{ model: string; ok: boolean; latencyMs?: number }>> {
  const baseUrl = (env.MASTRA_GATEWAY_BASE_URL ?? env.GATEWAY_BASE_URL ?? env.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
  const apiKey = env.MASTRA_GATEWAY_API_KEY ?? env.GATEWAY_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const results: Array<{ model: string; ok: boolean; latencyMs?: number }> = [];
  if (!baseUrl || !apiKey) {
    logger.warn("模型探针未运行：网关地址或密钥未配置");
    return results;
  }
  for (const entry of AUTO_MODEL_CHAIN) {
    const startedAt = Date.now();
    let ok = false;
    let latencyMs: number | undefined;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: entry.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      latencyMs = Date.now() - startedAt;
      ok = response.ok;
      if (!ok) logger.warn(`模型探针失败 model=${entry.model} status=${response.status}`);
    } catch (error) {
      logger.warn(`模型探针异常 model=${entry.model}: ${(error as Error).message}`);
    }
    recordModelFeedback(entry.model, { ok, ...(latencyMs !== undefined ? { firstTokenMs: latencyMs } : {}) });
    results.push({ model: entry.model, ok, ...(latencyMs !== undefined ? { latencyMs } : {}) });
  }
  return results;
}

/** models.state 展示视图（connector 命令 / 平台管理端用）。 */
export function modelRoutingSnapshot() {
  return {
    chain: AUTO_MODEL_CHAIN.map((entry) => ({ ...entry, health: getModelHealth(entry.model) })),
    descriptions: MODEL_DESCRIPTIONS,
    thresholds: {
      slowFirstTokenMs: SLOW_FIRST_TOKEN_MS,
      windowMs: WINDOW_MS,
      maxErrorRate: MAX_ERROR_RATE,
      degradeEvidences: DEGRADE_EVIDENCES,
      recoveryCooldownMs: RECOVERY_COOLDOWN_MS,
    },
  };
}
