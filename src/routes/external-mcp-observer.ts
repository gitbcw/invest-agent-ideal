import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { serviceApiToken } from "../lib/service-auth.js";
import { logger } from "../lib/logger.js";
import {
  observedToolCallFromBody,
  recordObservedExternalToolCall,
  resolveObservedExternalMcp,
  serializedSize,
  type ExternalMcpObserverScope,
} from "../services/external-mcp-observer.js";

const OBSERVER_PREFIX = "/api/internal/mcp-observer/";

function scopeFromHeaders(headers: Record<string, string | string[] | undefined>): ExternalMcpObserverScope | null {
  const value = (name: string) => Array.isArray(headers[name]) ? headers[name]?.[0] : headers[name];
  const userId = value("x-invest-agent-mcp-user-id");
  const projectId = value("x-invest-agent-mcp-project-id");
  const instanceId = value("x-invest-agent-mcp-instance-id");
  if (!userId || !projectId || !instanceId) return null;
  return { userId, projectId, instanceId, conversationId: value("x-invest-agent-mcp-conversation-id") };
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
