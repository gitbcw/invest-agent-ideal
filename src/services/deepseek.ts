import { config, type LlmProvider } from "../lib/config.js";
import { logger } from "../lib/logger.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

type DeepSeekProfile = "light" | "deep";

interface LlmCallOptions {
  provider?: LlmProvider;
  profile?: DeepSeekProfile;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | "max";
  temperature?: number;
  maxTokens?: number;
}

interface LlmResponse {
  choices: Array<{
    message: { content?: string; reasoning_content?: string };
  }>;
}

// ─── Provider Config ───

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  flashModel: string;
  proModel: string;
}

function getProviderConfig(provider: LlmProvider): ProviderConfig {
  if (provider === "stepfun") {
    return {
      apiKey: config.stepfun.apiKey,
      baseUrl: config.stepfun.baseUrl,
      flashModel: config.stepfun.flashModel,
      proModel: config.stepfun.proModel,
    };
  }
  if (provider === "doubao") {
    return {
      apiKey: config.doubao.apiKey,
      baseUrl: config.doubao.baseUrl,
      flashModel: config.doubao.flashModel,
      proModel: config.doubao.proModel,
    };
  }
  return {
    apiKey: config.deepseek.apiKey,
    baseUrl: config.deepseek.baseUrl,
    flashModel: config.deepseek.flashModel,
    proModel: config.deepseek.proModel,
  };
}

// ─── Request Building ───

function resolveModel(provider: LlmProvider, profile: DeepSeekProfile, explicitModel?: string): string {
  if (explicitModel) return explicitModel;

  const cfg = getProviderConfig(provider);
  const model = profile === "deep" ? cfg.proModel : cfg.flashModel;

  // DeepSeek legacy model fallback
  if (provider === "deepseek") {
    const deprecated = new Set(["deepseek-chat", "deepseek-reasoner"]);
    if (deprecated.has(model)) {
      const fallback = profile === "deep" ? "deepseek-v4-pro" : "deepseek-v4-flash";
      logger.warn(`DeepSeek 模型 ${model} 即将废弃，已自动切换为 ${fallback}`);
      return fallback;
    }
  }

  return model;
}

function buildRequestBody(provider: LlmProvider, messages: ChatMessage[], options: LlmCallOptions = {}): Record<string, unknown> {
  const profile = options.profile ?? "light";
  const thinking = options.thinking ?? profile === "deep";
  const model = resolveModel(provider, profile, options.model);

  const maxTokens = options.maxTokens ?? (profile === "deep" ? 4000 : 2000);

  const body: Record<string, unknown> = {
    model,
    messages,
    // StepFun 默认启用推理，消耗额外 token，给一个余量
    max_tokens: provider === "stepfun" ? maxTokens + 2000 : maxTokens,
  };

  if (provider === "deepseek") {
    body.thinking = { type: thinking ? "enabled" : "disabled" };
    if (thinking) {
      body.reasoning_effort = options.reasoningEffort ?? "high";
    } else {
      body.temperature = options.temperature ?? 0.7;
    }
  } else if (provider === "stepfun") {
    if (thinking) {
      body.reasoning_effort = options.reasoningEffort ?? "high";
    } else {
      body.temperature = options.temperature ?? 0.7;
    }
  } else if (provider === "doubao") {
    // 豆包不支持 thinking/reasoning_effort，直接设置 temperature
    body.temperature = options.temperature ?? 0.7;
  }

  return body;
}

// ─── API Call ───

/** 调用 LLM API（支持 DeepSeek / StepFun 多 provider） */
export async function callDeepSeek(
  userMessage: string,
  systemPrompt?: string,
  history: ChatMessage[] = [],
  options: LlmCallOptions = {}
): Promise<string> {
  const provider = options.provider ?? config.llm.provider;
  const cfg = getProviderConfig(provider);

  if (!cfg.apiKey) {
    throw new Error(`${provider} API key 未配置，请检查 .env 文件`);
  }

  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push(...history);
  messages.push({ role: "user", content: userMessage });

  const url = provider === "doubao"
    ? `${cfg.baseUrl}/chat/completions`
    : `${cfg.baseUrl}/v1/chat/completions`;
  const requestBody = buildRequestBody(provider, messages, options);

  try {
    logger.debug(
      `LLM 调用: provider=${provider} model=${String(requestBody.model)} thinking=${options.thinking ?? options.profile === "deep"}`
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`${provider} API 错误: ${response.status} ${errorText}`);
      throw new Error(`${provider} API 调用失败: ${response.status}`);
    }

    const data = (await response.json()) as LlmResponse;
    const msg = data.choices[0]?.message;
    // StepFun 推理模式下可能 content 为空、实际内容在 reasoning 字段
    const reply = msg?.content || msg?.reasoning_content || (msg as Record<string, string>)?.reasoning;

    if (!reply) {
      throw new Error(`${provider} 返回空响应`);
    }

    return reply;
  } catch (error) {
    logger.error(`${provider} 调用异常:`, error);
    throw error;
  }
}
