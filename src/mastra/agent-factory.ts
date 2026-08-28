import { getMastraBindings, resolveMastraBindings, type MastraBindingsProvider } from "./bindings.js";
import {
  createModelGateway,
  type MastraModelConfig,
  type MastraModelGateway,
  type ModelGatewayOptions,
} from "./model-gateway.js";
import { createToolResultBudgetProcessor, toolResultBudgetChars } from "./tool-result-budget.js";
import type { MastraAgentLike } from "./types.js";

/** T-402 旧工具结果剔除：保留最近 N 个工具步，更早的 tool_use/tool_result 从
 * 模型输入移除（memory/审计不受影响——本架构无 Mastra Memory，历史由调用方
 * 每轮重传）。0 关闭。依据：42 步研究轮的结果滚入是 input 二次方增长主因。 */
export const DEFAULT_TOOL_HISTORY_STEPS = 6;

export function toolHistorySteps(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.TOOL_HISTORY_STEPS ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TOOL_HISTORY_STEPS;
}

/** 组装 input processors（T-402 context engineering 三层启用的第 1、2 层）。 */
async function assembleInputProcessors(bindings?: MastraBindingsProvider): Promise<unknown[]> {
  const processors: unknown[] = [];
  const budget = toolResultBudgetChars();
  if (budget > 0) processors.push(createToolResultBudgetProcessor());
  const resolved = await resolveMastraBindings(bindings);
  const steps = toolHistorySteps();
  if (steps > 0 && resolved.ToolCallFilter) {
    processors.push(new resolved.ToolCallFilter({ filterAfterToolSteps: steps }));
  }
  return processors;
}

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
  const inputProcessors = await assembleInputProcessors(options.bindings);
  if (inputProcessors.length > 0) agentOptions.inputProcessors = inputProcessors;
  if (options.maxSteps !== undefined) {
    // 2026-08-27：与 run-turn normalizeMaxSteps 同步放宽到 50（自动化预算 30）。
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 50) {
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
