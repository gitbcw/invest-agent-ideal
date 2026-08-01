import { db } from "../db/index.js";
import { externalMcpToolCalls } from "../db/schema.js";
import { buildExternalRegistrations, isExternalRegistrationActivated } from "../acp/external-mcp-registrations.js";
import { resolveExternalHttpServer } from "../acp/mcp-registry.js";

export type ExternalMcpObserverScope = {
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId?: string;
  /** Per prompt/run correlation key; for ACP calls this equals codex_acp_traces.message_id. */
  runId?: string;
};

export type ExternalMcpToolCallBudget = {
  /** Maximum external `tools/call` requests for one ACP turn. */
  maxCalls: number;
  /** Maximum consecutive requests for exactly the same external tool. */
  maxConsecutiveCalls: number;
};

export type ExternalMcpToolCallBudgetState = {
  totalCalls: number;
  lastToolKey?: string;
  consecutiveCalls: number;
};

export type ExternalMcpToolCallBudgetDecision =
  | { allowed: true; totalCalls: number; consecutiveCalls: number }
  | {
      allowed: false;
      reason: "total_calls" | "consecutive_calls";
      totalCalls: number;
      consecutiveCalls: number;
    };

const DEFAULT_EXTERNAL_MCP_MAX_CALLS_PER_TURN = 12;
const DEFAULT_EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS = 4;
const MAX_BUDGET_VALUE = 100;

/**
 * Parse the service-owned guardrail. A non-positive value explicitly disables
 * the corresponding cap, which is useful for a controlled compatibility test.
 */
export function resolveExternalMcpToolCallBudget(env: NodeJS.ProcessEnv = process.env): ExternalMcpToolCallBudget {
  return {
    maxCalls: boundedBudget(env.EXTERNAL_MCP_MAX_CALLS_PER_TURN, DEFAULT_EXTERNAL_MCP_MAX_CALLS_PER_TURN),
    maxConsecutiveCalls: boundedBudget(
      env.EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS,
      DEFAULT_EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS,
    ),
  };
}

function boundedBudget(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), MAX_BUDGET_VALUE);
}

/**
 * Decide and reserve a call atomically in the caller's per-turn state. The
 * observer invokes this before forwarding, so concurrent requests cannot
 * overrun the budget merely because their upstream responses overlap.
 */
export function reserveExternalMcpToolCall(input: {
  state: ExternalMcpToolCallBudgetState;
  serverId: string;
  toolName: string;
  budget: ExternalMcpToolCallBudget;
}): ExternalMcpToolCallBudgetDecision {
  const toolKey = `${input.serverId}\u0000${input.toolName}`;
  const nextConsecutive = input.state.lastToolKey === toolKey
    ? input.state.consecutiveCalls + 1
    : 1;
  if (input.budget.maxCalls > 0 && input.state.totalCalls >= input.budget.maxCalls) {
    return {
      allowed: false,
      reason: "total_calls",
      totalCalls: input.state.totalCalls,
      consecutiveCalls: nextConsecutive,
    };
  }
  if (input.budget.maxConsecutiveCalls > 0 && nextConsecutive > input.budget.maxConsecutiveCalls) {
    return {
      allowed: false,
      reason: "consecutive_calls",
      totalCalls: input.state.totalCalls,
      consecutiveCalls: nextConsecutive,
    };
  }
  input.state.totalCalls += 1;
  input.state.lastToolKey = toolKey;
  input.state.consecutiveCalls = nextConsecutive;
  return { allowed: true, totalCalls: input.state.totalCalls, consecutiveCalls: nextConsecutive };
}

export function resolveObservedExternalMcp(serverId: string, env: NodeJS.ProcessEnv = process.env) {
  const registration = buildExternalRegistrations().find((item) => item.id === serverId);
  if (!registration || !isExternalRegistrationActivated(registration, env)) return null;
  const resolved = resolveExternalHttpServer(registration, env);
  return resolved ? { registration, resolved } : null;
}

export function observedToolCallFromBody(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; id?: unknown; params?: { name?: unknown } };
  if (rpc.method !== "tools/call" || typeof rpc.params?.name !== "string") return null;
  return {
    toolName: rpc.params.name,
    requestId: typeof rpc.id === "string" || typeof rpc.id === "number" ? String(rpc.id) : undefined,
  };
}

export async function recordObservedExternalToolCall(input: {
  scope: ExternalMcpObserverScope;
  serverId: string;
  toolName: string;
  requestId?: string;
  status: "completed" | "failed";
  elapsedMs: number;
  inputChars?: number;
  outputChars?: number;
  errorClass?: string;
}) {
  await db.insert(externalMcpToolCalls).values({
    userId: input.scope.userId,
    projectId: input.scope.projectId,
    instanceId: input.scope.instanceId,
    conversationId: input.scope.conversationId,
    runId: input.scope.runId,
    serverId: input.serverId,
    toolName: input.toolName,
    requestId: input.requestId,
    status: input.status,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    errorClass: input.errorClass,
    createdAt: new Date().toISOString(),
  });
}

export function serializedSize(value: unknown): number | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}
