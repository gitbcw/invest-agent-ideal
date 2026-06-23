/**
 * 路由层 / 意图分流(triage)。
 *
 * 位置:微信/HTTP 消息进入 AcpAgent.handleMessage 后,Codex ACP 之前。
 *
 * 三种出口:
 *   - direct_reply:轻量问题 LLM 已给出答案,直接回复
 *   - fallback_codex:复杂问题或分类不确定,交给 Codex ACP
 *   - reject:投资无关话题,LLM 生成礼貌拒绝
 *
 * Provider fallback 链由 src/services/llm-router.ts 承载
 * (DeepSeek → Doubao → StepFun → 全失败时直接 fallback_codex)。
 * System prompt 见 src/prompts/triage.ts。
 * 边界控制由 LLM 自己判断,见 prompt。
 *
 * 配置来源(2026-06-21 WP3b):
 *   - 默认:本文件 DEFAULT_CONFIG 三个常量
 *   - 可选:`USE_YAML_CONFIG=true` 时读 `data/workspaces/<userId>/config/triage.yaml`
 *   - yaml 缺失或字段类型错误:fallback 到默认值,不阻塞主链路
 */

import { randomUUID } from "node:crypto";
import { DEFAULT_USER_ID } from "../lib/user-context.js";
import { type LlmProvider } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { ensureWorkspace } from "../lib/workspace.js";
import { WorkspaceStore } from "../lib/workspace-store.js";
import { TRIAGE_SYSTEM_PROMPT } from "../prompts/triage.js";
import { callLlmWithFallback, type ChatTurn } from "../services/llm-router.js";
import { isDailyReviewRequest } from "./agent.js";

export type TriageKind = "direct_reply" | "fallback_codex" | "reject";

export interface TriageResult {
  kind: TriageKind;
  text?: string;
  reason?: string;
  confidence: number;
  provider?: LlmProvider;
  topic?: string;
  elapsedMs: number;
}

interface TriageDecisionRaw {
  kind?: string;
  text?: string;
  reason?: string;
  confidence?: number;
  topic?: string;
}

interface TriageConfig {
  confidenceThreshold: number;
  rejectThreshold: number;
  maxShortCircuitLen: number;
}

const DEFAULT_CONFIG: TriageConfig = {
  confidenceThreshold: 0.6,
  rejectThreshold: 0.7,
  maxShortCircuitLen: 200,
};

let cachedConfig: TriageConfig | null = null;
let workspaceInitialized = false;

async function loadTriageConfig(): Promise<TriageConfig> {
  if (cachedConfig) return cachedConfig;

  if (process.env.USE_YAML_CONFIG !== "true") {
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }

  try {
    if (!workspaceInitialized) {
      await ensureWorkspace({ userId: DEFAULT_USER_ID });
      workspaceInitialized = true;
    }
    const store = new WorkspaceStore(DEFAULT_USER_ID);
    const yaml = await store.readTriageConfig();
    if (!yaml) {
      logger.warn("triage USE_YAML_CONFIG=true 但 config/triage.yaml 不存在,使用默认值");
      cachedConfig = DEFAULT_CONFIG;
      return cachedConfig;
    }
    cachedConfig = {
      confidenceThreshold: typeof yaml.confidence_threshold === "number"
        ? yaml.confidence_threshold
        : DEFAULT_CONFIG.confidenceThreshold,
      rejectThreshold: typeof yaml.reject_threshold === "number"
        ? yaml.reject_threshold
        : DEFAULT_CONFIG.rejectThreshold,
      maxShortCircuitLen: typeof yaml.max_short_circuit_len === "number"
        ? yaml.max_short_circuit_len
        : DEFAULT_CONFIG.maxShortCircuitLen,
    };
    logger.info(
      `triage 配置从 yaml 加载: confidence<${cachedConfig.confidenceThreshold} reject<${cachedConfig.rejectThreshold} shortCircuit<${cachedConfig.maxShortCircuitLen}`
    );
    return cachedConfig;
  } catch (error) {
    logger.warn(`triage 配置读取失败,使用默认值: ${(error as Error).message}`);
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }
}

function shortCircuit(text: string, config: TriageConfig): TriageResult | null {
  const trimmed = text.trim();
  if (trimmed.length > config.maxShortCircuitLen) {
    return null;
  }
  if (isDailyReviewRequest(trimmed)) {
    return {
      kind: "fallback_codex",
      reason: "日复盘请求,需要 Codex 调度",
      confidence: 1.0,
      elapsedMs: 0,
    };
  }
  return null;
}

function parseDecision(raw: string): TriageDecisionRaw {
  const trimmed = raw.trim();
  // 剥离可能的 markdown 代码块包裹
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned) as TriageDecisionRaw;
  } catch {
    // LLM 没按要求输出 JSON,提取首个 {...} 块
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as TriageDecisionRaw;
      } catch {
        return {};
      }
    }
    return {};
  }
}

function normalizeKind(value: unknown): TriageKind {
  if (value === "direct_reply" || value === "fallback_codex" || value === "reject") {
    return value;
  }
  return "fallback_codex";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function interpretDecision(
  raw: TriageDecisionRaw,
  provider: LlmProvider,
  elapsedMs: number,
  config: TriageConfig
): TriageResult {
  const kind = normalizeKind(raw.kind);
  const confidence = clampConfidence(raw.confidence);

  if (kind === "direct_reply") {
    if (confidence < config.confidenceThreshold || !raw.text) {
      return {
        kind: "fallback_codex",
        reason: `triage 判定 direct_reply 但置信度 ${confidence.toFixed(2)} 不足或无 text`,
        confidence,
        provider,
        topic: raw.topic,
        elapsedMs,
      };
    }
    return {
      kind: "direct_reply",
      text: raw.text,
      confidence,
      provider,
      topic: raw.topic,
      elapsedMs,
    };
  }

  if (kind === "reject") {
    if (confidence < config.rejectThreshold || !raw.text) {
      return {
        kind: "fallback_codex",
        reason: `triage 判定 reject 但置信度 ${confidence.toFixed(2)} 未达 ${config.rejectThreshold} 阈值或无 text`,
        confidence,
        provider,
        topic: raw.topic,
        elapsedMs,
      };
    }
    return {
      kind: "reject",
      text: raw.text,
      confidence,
      provider,
      topic: raw.topic,
      elapsedMs,
    };
  }

  return {
    kind: "fallback_codex",
    reason: raw.reason || "triage 判定 fallback_codex",
    confidence,
    provider,
    topic: raw.topic,
    elapsedMs,
  };
}

export async function triage(
  text: string,
  options: { conversationId?: string } = {}
): Promise<TriageResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      kind: "fallback_codex",
      reason: "空消息",
      confidence: 1.0,
      elapsedMs: 0,
    };
  }

  const config = await loadTriageConfig();

  const shortCircuited = shortCircuit(trimmed, config);
  if (shortCircuited) {
    return shortCircuited;
  }

  const startedAt = Date.now();
  const history: ChatTurn[] = [];
  const llmResult = await callLlmWithFallback(trimmed, TRIAGE_SYSTEM_PROMPT, history);

  if (!llmResult) {
    return {
      kind: "fallback_codex",
      reason: "triage 所有 provider 失败,直接 fallback Codex",
      confidence: 0.0,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const raw = parseDecision(llmResult.reply);
  const result = interpretDecision(raw, llmResult.provider, Date.now() - startedAt, config);
  logger.info(
    `triage result kind=${result.kind} confidence=${result.confidence.toFixed(2)} provider=${result.provider ?? "-"} topic=${result.topic ?? "-"} elapsedMs=${result.elapsedMs}`
  );
  return result;
}

export function triageRequestId(): string {
  return `triage-${randomUUID()}`;
}
