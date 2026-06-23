/**
 * LLM provider 互备层。
 *
 * 提供 callLlmWithFallback,按 deepseek → doubao → stepfun 顺序尝试,
 * 任一成功即返回,全失败返回 null。供 triage 等需要轻量 LLM 调用
 * 的链路使用,避免单点不稳定。
 *
 * 设计取舍:
 *   - systemPrompt 作为参数传入,保持通用性(triage 用 TRIAGE_SYSTEM_PROMPT,
 *     未来 chat-handler / polite-reject 等可复用)
 *   - 不在这里做意图解析/JSON 校验,只负责"调用 provider 拿到 reply"
 *   - 默认 profile="light" + temperature=0.3 + maxTokens=400,与原 triage
 *     行为一致;调用方可通过 options 覆盖
 */

import { config, type LlmProvider } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { callDeepSeek } from "./deepseek.js";

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRouterOptions {
  profile?: "light" | "deep";
  temperature?: number;
  maxTokens?: number;
}

export interface LlmRouterResult {
  reply: string;
  provider: LlmProvider;
}

const DEFAULT_PROVIDER_CHAIN: LlmProvider[] = ["deepseek"];

function buildProviderChain(): LlmProvider[] {
  return [
    ...DEFAULT_PROVIDER_CHAIN,
    ...(config.doubao.apiKey ? (["doubao"] as LlmProvider[]) : []),
    ...(config.stepfun.apiKey ? (["stepfun"] as LlmProvider[]) : []),
  ];
}

function getApiKey(provider: LlmProvider): string {
  return provider === "deepseek"
    ? config.deepseek.apiKey
    : provider === "doubao"
    ? config.doubao.apiKey
    : config.stepfun.apiKey;
}

export async function callLlmWithFallback(
  userText: string,
  systemPrompt: string,
  history: ChatTurn[],
  options: LlmRouterOptions = {}
): Promise<LlmRouterResult | null> {
  const chain = buildProviderChain();

  for (const provider of chain) {
    if (!getApiKey(provider)) continue;

    try {
      const reply = await callDeepSeek(userText, systemPrompt, history, {
        provider,
        profile: options.profile ?? "light",
        temperature: options.temperature ?? 0.3,
        maxTokens: options.maxTokens ?? 400,
      });
      return { reply, provider };
    } catch (error) {
      logger.warn(
        `llm-router provider=${provider} 调用失败,尝试下一个:${(error as Error).message}`
      );
    }
  }
  return null;
}
