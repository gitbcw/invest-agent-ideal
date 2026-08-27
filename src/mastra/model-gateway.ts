/**
 * Configurable OpenAI-compatible model boundary.
 *
 * This module only resolves a Mastra model descriptor. It does not create a
 * provider client, read a credential file, or make a network request.
 */

export interface MastraModelConfig {
  /** Mastra provider/model id, for example `gateway/gpt-5.6-terra`. */
  id: string;
  /** OpenAI-compatible `/v1` base URL. */
  url: string;
  /** Kept as a string for Mastra's provider config; empty means unconfigured. */
  apiKey: string;
}

export interface ModelGatewayOptions {
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  provider?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MastraModelGateway {
  readonly defaultModel: string;
  resolve(model?: string): MastraModelConfig;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}

/** Build an injectable gateway resolver from explicit values or environment. */
export function createModelGateway(options: ModelGatewayOptions = {}): MastraModelGateway {
  const env = options.env ?? process.env;
  const baseUrl = firstNonEmpty(
    options.baseUrl,
    env.MASTRA_GATEWAY_BASE_URL,
    env.GATEWAY_BASE_URL,
    env.OPENAI_BASE_URL,
  ) ?? "";
  const apiKey = firstNonEmpty(
    options.apiKey,
    env.MASTRA_GATEWAY_API_KEY,
    env.GATEWAY_API_KEY,
    env.OPENAI_API_KEY,
  ) ?? "";
  const defaultModel = firstNonEmpty(
    options.defaultModel,
    env.MASTRA_DEFAULT_MODEL,
    env.LLM_DEFAULT_MODEL,
  ) ?? "gpt-5.6-terra";
  const provider = firstNonEmpty(
    options.provider,
    env.MASTRA_GATEWAY_PROVIDER,
  ) ?? "gateway";

  return {
    defaultModel,
    resolve(model = defaultModel): MastraModelConfig {
      const modelName = model.trim();
      if (!modelName) throw new Error("MASTRA_MODEL_CONFIG_INVALID: model must not be empty");
      return {
        id: `${provider}/${modelName}`,
        url: baseUrl,
        apiKey,
      };
    },
  };
}

/** Descriptive alias for callers that want to emphasize the boundary. */
export const resolveModelGateway = createModelGateway;

/** Resolve one model descriptor without creating a provider or agent. */
export function resolveModelConfig(
  modelOrOptions?: string | ModelGatewayOptions,
  env: NodeJS.ProcessEnv = process.env,
): MastraModelConfig {
  const options = typeof modelOrOptions === "string"
    ? { defaultModel: modelOrOptions, env }
    : { ...(modelOrOptions ?? {}), env: modelOrOptions?.env ?? env };
  return createModelGateway(options).resolve(options.defaultModel);
}

/** GPT 系列（gpt-* 前缀）判定，用于思考深度等家族级默认行为。 */
export function isGptSeriesModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("gpt-");
}

/**
 * GPT 系列默认思考深度（owner 2026-08-26）：默认 high，无 UI 入口；
 * 可用 MASTRA_GPT_REASONING_EFFORT 环境变量临时覆盖（none/minimal/low/medium/high/xhigh/max）。
 */
export function gptReasoningEffort(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MASTRA_GPT_REASONING_EFFORT?.trim();
  return raw || "high";
}

/** GLM-5.3 系列（glm-5.3* 前缀）判定。官方不支持关闭思考，只有档位可调。 */
export function isGlmSeriesModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("glm-5.3");
}

/**
 * GLM-5.3 系列默认思考档位（owner 2026-08-27）：官方档位 low/high/max，
 * glm-5.3 默认 max（深度推理，重负载下思考量约为输入的 1.5-2 倍，超出
 * 自动化单次尝试窗口）；owner 裁决统一调至 high（中等思考）。
 * 可用 MASTRA_GLM_REASONING_EFFORT 环境变量临时覆盖。
 */
export function glmReasoningEffort(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MASTRA_GLM_REASONING_EFFORT?.trim();
  return raw || "high";
}
