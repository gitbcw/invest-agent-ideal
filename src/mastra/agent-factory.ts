import { getMastraBindings, resolveMastraBindings, type MastraBindingsProvider } from "./bindings.js";
import {
  createModelGateway,
  type MastraModelConfig,
  type MastraModelGateway,
  type ModelGatewayOptions,
} from "./model-gateway.js";
import type { MastraAgentLike } from "./types.js";

export interface MastraAgentFactoryOptions {
  bindings?: MastraBindingsProvider;
  gateway?: MastraModelGateway | ModelGatewayOptions;
  model?: string;
  agentId?: string;
  name?: string;
  instructions?: unknown;
  tools?: Record<string, unknown>;
  /** Optional, service-resolved Workspace. Never pass a user-provided path here. */
  workspace?: unknown;
  /** Tests or a later caller may provide an already resolved model descriptor. */
  modelConfig?: MastraModelConfig;
  /** Server-owned upper bound for tool/model iterations in one turn. */
  maxSteps?: number;
}

export type MastraAgentFactory = (
  options?: MastraAgentFactoryOptions,
) => MastraAgentLike | PromiseLike<MastraAgentLike>;

function isModelGateway(value: MastraModelGateway | ModelGatewayOptions): value is MastraModelGateway {
  return typeof (value as MastraModelGateway).resolve === "function";
}

function resolveGateway(value: MastraAgentFactoryOptions["gateway"]): MastraModelGateway {
  return value && isModelGateway(value) ? value : createModelGateway(value ?? {});
}

/**
 * Construct one Mastra Agent. The function is intentionally per-call and does
 * not retain a singleton, Memory instance, conversation history, or runtime
 * state. Stage 1 callers can inject fake bindings and never load Mastra.
 */
export async function createMastraAgent(options: MastraAgentFactoryOptions = {}): Promise<MastraAgentLike> {
  const bindings = await resolveMastraBindings(options.bindings);
  const gateway = resolveGateway(options.gateway);
  const model = options.model ?? gateway.defaultModel;
  const modelConfig = options.modelConfig ?? gateway.resolve(model);
  const agentOptions: Record<string, unknown> = {
    id: options.agentId ?? process.env.MASTRA_AGENT_ID ?? "invest-agent-mastra-stage1",
    name: options.name ?? process.env.MASTRA_AGENT_NAME ?? "Invest Agent (Mastra)",
    instructions: options.instructions ?? "You are an investment decision assistant.",
    model: modelConfig,
  };
  if (options.tools !== undefined) agentOptions.tools = options.tools;
  if (options.workspace !== undefined) agentOptions.workspace = options.workspace;
  if (options.maxSteps !== undefined) {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 20) {
      throw new Error(`MASTRA_MAX_STEPS_INVALID: ${options.maxSteps}`);
    }
    agentOptions.defaultOptions = { maxSteps: options.maxSteps };
  }
  return new bindings.Agent(agentOptions);
}

/** Create a reusable factory with fixed defaults but no long-lived Agent. */
export function createMastraAgentFactory(defaults: MastraAgentFactoryOptions = {}): MastraAgentFactory {
  return (overrides = {}) => createMastraAgent({ ...defaults, ...overrides });
}

/** Alias used by callers that prefer a shorter factory name. */
export const mastraAgentFactory = createMastraAgentFactory();

/** Explicit default factory for dependency injection in the turn adapter. */
export const defaultMastraAgentFactory: MastraAgentFactory = (options = {}) =>
  createMastraAgent(options);

/** Keep the default loader visible for source-level ESM isolation checks. */
export { getMastraBindings };
