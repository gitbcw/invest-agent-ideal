import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";
import { desc, eq } from "drizzle-orm";
import { db, initDb } from "../src/db/index.js";
import { externalMcpToolCalls } from "../src/db/schema.js";
import { serviceApiToken } from "../src/lib/service-auth.js";
import { registerExternalMcpObserverRoutes } from "../src/routes/external-mcp-observer.js";
import {
  observedToolCallFromBody,
  reserveExternalMcpToolCall,
  resolveExternalMcpToolCallBudget,
} from "../src/services/external-mcp-observer.js";

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("recognizes only JSON-RPC tools/call requests", () => {
  assert.deepEqual(observedToolCallFromBody({ method: "tools/call", id: 7, params: { name: "get_realtime_quote" } }), {
    toolName: "get_realtime_quote",
    requestId: "7",
  });
  assert.equal(observedToolCallFromBody({ method: "tools/list", id: 8 }), null);
});

test("external MCP budget limits total calls and repeated identical tool calls per turn", () => {
  const state = { totalCalls: 0, consecutiveCalls: 0 };
  const budget = { maxCalls: 3, maxConsecutiveCalls: 2 };
  assert.equal(reserveExternalMcpToolCall({ state, serverId: "market", toolName: "quote", budget }).allowed, true);
  assert.equal(reserveExternalMcpToolCall({ state, serverId: "market", toolName: "quote", budget }).allowed, true);
  const repeated = reserveExternalMcpToolCall({ state, serverId: "market", toolName: "quote", budget });
  assert.deepEqual(repeated, { allowed: false, reason: "consecutive_calls", totalCalls: 2, consecutiveCalls: 3 });
  assert.equal(state.totalCalls, 2, "rejected calls must not consume total budget");
  assert.equal(reserveExternalMcpToolCall({ state, serverId: "market", toolName: "news", budget }).allowed, true);
  const exhausted = reserveExternalMcpToolCall({ state, serverId: "qsse", toolName: "industry", budget });
  assert.deepEqual(exhausted, { allowed: false, reason: "total_calls", totalCalls: 3, consecutiveCalls: 1 });
});

test("external MCP budget defaults safely and permits explicit controlled disable", () => {
  assert.deepEqual(resolveExternalMcpToolCallBudget({}), { maxCalls: 12, maxConsecutiveCalls: 4 });
  assert.deepEqual(resolveExternalMcpToolCallBudget({ EXTERNAL_MCP_MAX_CALLS_PER_TURN: "0", EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS: "0" }), {
    maxCalls: 0,
    maxConsecutiveCalls: 0,
  });
});

test("observer forwards tools/call and persists minimal external MCP evidence", async () => {
  initDb();
  const previous = {
    enabled: process.env.INVEST_AGENT_MCP_MARKET_DATA_ENABLED,
    url: process.env.MARKET_DATA_MCP_URL,
    token: process.env.MARKET_DATA_MCP_TOKEN,
  };
  const originalFetch = globalThis.fetch;
  process.env.INVEST_AGENT_MCP_MARKET_DATA_ENABLED = "true";
  process.env.MARKET_DATA_MCP_URL = "https://external.example.test/mcp";
  process.env.MARKET_DATA_MCP_TOKEN = "external-secret";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://external.example.test/mcp");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer external-secret");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { content: [] } }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
    });
  };
  const app = Fastify();
  registerExternalMcpObserverRoutes(app);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/mcp-observer/market-data-tool",
      headers: {
        "x-invest-agent-token": serviceApiToken,
        "x-invest-agent-mcp-user-id": "observer-user",
        "x-invest-agent-mcp-project-id": "invest-agent",
        "x-invest-agent-mcp-instance-id": "invest-agent-observer-user",
        "x-invest-agent-mcp-conversation-id": "observer-conversation",
        "x-invest-agent-mcp-run-id": "observer-message-1",
      },
      payload: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_realtime_quote", arguments: { symbols: ["600519"] } } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["mcp-session-id"], "upstream-session");
    const [row] = await db.select().from(externalMcpToolCalls)
      .where(eq(externalMcpToolCalls.userId, "observer-user"))
      .orderBy(desc(externalMcpToolCalls.id)).limit(1);
    assert.equal(row.serverId, "market-data-tool");
    assert.equal(row.toolName, "get_realtime_quote");
    assert.equal(row.status, "completed");
    assert.equal(row.runId, "observer-message-1");
    assert.ok((row.inputChars || 0) > 0);
    assert.equal(row.outputChars, null);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    restoreEnv("INVEST_AGENT_MCP_MARKET_DATA_ENABLED", previous.enabled);
    restoreEnv("MARKET_DATA_MCP_URL", previous.url);
    restoreEnv("MARKET_DATA_MCP_TOKEN", previous.token);
  }
});
