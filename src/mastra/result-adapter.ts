import type { MastraTurnResult } from "./types.js";

/** Application-facing shape used to compare ACP and Mastra fixture results. */
export interface ApplicationTurnResult {
  text: string;
  usage: MastraTurnResult["usage"];
  budget: MastraTurnResult["budget"];
  backendId: "mastra";
  model?: string;
  toolCalls?: MastraTurnResult["toolCalls"];
  toolPayloads?: MastraTurnResult["toolPayloads"];
}

export function adaptMastraResult(result: MastraTurnResult): ApplicationTurnResult {
  return {
    text: result.text,
    usage: result.usage,
    budget: result.budget,
    backendId: "mastra",
    ...(result.model ? { model: result.model } : {}),
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    ...(result.toolPayloads && result.toolPayloads.length > 0 ? { toolPayloads: result.toolPayloads } : {}),
  };
}

export function comparableTurnResult(result: ApplicationTurnResult | { text: string; usage: unknown; budget: unknown; toolCalls?: unknown }) {
  return {
    text: result.text,
    usage: result.usage,
    budget: result.budget,
    toolCalls: result.toolCalls ?? [],
  };
}
