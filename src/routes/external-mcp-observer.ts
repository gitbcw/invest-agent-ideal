import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { serviceApiToken } from "../lib/service-auth.js";
import { logger } from "../lib/logger.js";
import {
  observedToolCallFromBody,
  recordObservedExternalToolCall,
  reserveExternalMcpToolCall,
  resolveExternalMcpToolCallBudget,
  resolveObservedExternalMcp,
  serializedSize,
  type ExternalMcpToolCallBudgetState,
  type ExternalMcpObserverScope,
} from "../services/external-mcp-observer.js";

const OBSERVER_PREFIX = "/api/internal/mcp-observer/";
const TURN_BUDGET_STATE_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_TURNS = 2_000;
const turnBudgetStates = new Map<string, { state: ExternalMcpToolCallBudgetState; expiresAt: number }>();

function turnBudgetKey(scope: ExternalMcpObserverScope): string | null {
  if (!scope.runId) return null;
  return [scope.userId, scope.projectId, scope.instanceId, scope.conversationId || "", scope.runId].join("\u0000");
}

function budgetStateForTurn(scope: ExternalMcpObserverScope, now = Date.now()): ExternalMcpToolCallBudgetState | null {
  const key = turnBudgetKey(scope);
  if (!key) return null;
  for (const [candidate, entry] of turnBudgetStates) {
    if (entry.expiresAt <= now) turnBudgetStates.delete(candidate);
  }
  if (turnBudgetStates.size >= MAX_TRACKED_TURNS) {
    const oldest = turnBudgetStates.keys().next().value;
    if (oldest) turnBudgetStates.delete(oldest);
  }
  const existing = turnBudgetStates.get(key);
  if (existing) {
    existing.expiresAt = now + TURN_BUDGET_STATE_TTL_MS;
    return existing.state;
  }
  const state: ExternalMcpToolCallBudgetState = { totalCalls: 0, identicalCallCounts: new Map() };
  turnBudgetStates.set(key, { state, expiresAt: now + TURN_BUDGET_STATE_TTL_MS });
  return state;
}

function budgetExceededResponse(input: { responseId?: string | number; reason: "total_calls" | "identical_calls"; budget: ReturnType<typeof resolveExternalMcpToolCallBudget> }) {
  const limit = input.reason === "total_calls" ? input.budget.maxCalls : input.budget.maxIdenticalCalls;
  const label = input.reason === "total_calls" ? "total external tool-call" : "identical invocation";
  return {
    jsonrpc: "2.0",
    id: input.responseId ?? null,
    error: {
      code: -32001,
      message: `External MCP ${label} budget (${limit}) is exhausted for this turn. Stop calling external tools and answer from the evidence already retrieved; state any remaining data gap explicitly.`,
    },
  };
}

function scopeFromHeaders(headers: Record<string, string | string[] | undefined>): ExternalMcpObserverScope | null {
  const value = (name: string) => Array.isArray(headers[name]) ? headers[name]?.[0] : headers[name];
  const userId = value("x-invest-agent-mcp-user-id");
  const projectId = value("x-invest-agent-mcp-project-id");
  const instanceId = value("x-invest-agent-mcp-instance-id");
  if (!userId || !projectId || !instanceId) return null;
  return {
    userId,
    projectId,
    instanceId,
    conversationId: value("x-invest-agent-mcp-conversation-id"),
    runId: value("x-invest-agent-mcp-run-id"),
  };
}

/** Transparent HTTP MCP relay. It records only tools/call metadata, never request or result bodies. */
export function registerExternalMcpObserverRoutes(app: FastifyInstance) {
  app.all(`${OBSERVER_PREFIX}:serverId`, async (request, reply) => {
    const token = request.headers["x-invest-agent-token"];
    const supplied = Array.isArray(token) ? token[0] : token;
    if (!serviceApiToken || supplied !== serviceApiToken) return reply.status(401).send({ error: "observer authorization required" });
    const scope = scopeFromHeaders(request.headers);
    if (!scope) return reply.status(400).send({ error: "observer scope headers required" });
    const serverId = String((request.params as { serverId?: string }).serverId || "");
    const target = resolveObservedExternalMcp(serverId);
    if (!target) return reply.status(404).send({ error: "external MCP observer target unavailable" });

    const startedAt = Date.now();
    const body = request.body;
    const toolCall = observedToolCallFromBody(body);
    if (toolCall) {
      const state = budgetStateForTurn(scope, startedAt);
      if (state) {
        const budget = resolveExternalMcpToolCallBudget();
        const decision = reserveExternalMcpToolCall({
          state,
          serverId,
          toolName: toolCall.toolName,
          arguments: toolCall.arguments,
          budget,
        });
        if (!decision.allowed) {
          await recordObservedExternalToolCall({
            scope,
            serverId,
            toolName: toolCall.toolName,
            requestId: toolCall.requestId,
            status: "failed",
            elapsedMs: Date.now() - startedAt,
            inputChars: serializedSize(body),
            errorClass: decision.reason === "total_calls" ? "MCP_TOOL_CALL_BUDGET_EXHAUSTED" : "MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED",
          });
          return reply.status(200).send(budgetExceededResponse({ responseId: toolCall.responseId, reason: decision.reason, budget }));
        }
      }
    }
    try {
      const response = await fetch(target.resolved.url, {
        method: request.method,
        headers: {
          ...Object.fromEntries(target.resolved.headers.map((header) => [header.name, header.value])),
          accept: String(request.headers.accept || "application/json, text/event-stream"),
          ...(request.method === "GET" || request.method === "DELETE" ? {} : { "content-type": "application/json" }),
          ...(request.headers["mcp-session-id"] ? { "mcp-session-id": String(request.headers["mcp-session-id"]) } : {}),
        },
        body: request.method === "GET" || request.method === "DELETE" || body === undefined ? undefined : JSON.stringify(body),
      });
      const responseHeaders = ["content-type", "mcp-session-id", "cache-control"] as const;
      for (const name of responseHeaders) {
        const value = response.headers.get(name);
        if (value) reply.header(name, value);
      }
      if (toolCall) {
        await recordObservedExternalToolCall({
          scope,
          serverId,
          toolName: toolCall.toolName,
          requestId: toolCall.requestId,
          status: response.ok ? "completed" : "failed",
          elapsedMs: Date.now() - startedAt,
          inputChars: serializedSize(body),
          errorClass: response.ok ? undefined : `HTTP_${response.status}`,
        });
      }
      if (!response.body) return reply.status(response.status).send();
      return reply.status(response.status).send(Readable.fromWeb(response.body as never));
    } catch (error) {
      if (toolCall) await recordObservedExternalToolCall({
        scope, serverId, toolName: toolCall.toolName, requestId: toolCall.requestId,
        status: "failed", elapsedMs: Date.now() - startedAt, inputChars: serializedSize(body),
        errorClass: error instanceof Error ? error.name : "UPSTREAM_ERROR",
      });
      logger.warn(`[MCP_OBSERVER] server=${serverId} upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply.status(502).send({ error: "external MCP upstream unavailable" });
    }
  });
}
