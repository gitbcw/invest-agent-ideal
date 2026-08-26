/**
 * Configurable OpenAI-compatible model boundary.
 *
 * This module only resolves a Mastra model descriptor. It does not create a
 * provider client, read a credential file, or make a network request.
 */

export interface MastraModelConfig {
  /** Mastra provider/model id, for example `gateway/gpt-5.6-luna`. */
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
  ) ?? "gpt-5.6-luna";
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
