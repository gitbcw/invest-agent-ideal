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
  readExternalMcpToolCallStats,
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

// ─── T-243 聚合 read API ──────────────────────────────────────────

test("readExternalMcpToolCallStats aggregates server+tool calls with success rate and p95", async () => {
  initDb();
  // 用一个隔离的 server/tool 注入样本数据,避免与其他测试数据耦合。
  const serverId = "stats-test-server";
  const toolName = "stats_test_tool";
  const baseTime = Date.now();
  // 清掉历史残留 (幂等)
  await db.delete(externalMcpToolCalls);
  const rows = [
    { status: "completed", elapsedMs: 100, errorClass: null, offsetSec: -60 },
    { status: "completed", elapsedMs: 200, errorClass: null, offsetSec: -50 },
    { status: "completed", elapsedMs: 300, errorClass: null, offsetSec: -40 },
    { status: "completed", elapsedMs: 400, errorClass: null, offsetSec: -30 },
    { status: "failed", elapsedMs: 500, errorClass: "HTTP_500", offsetSec: -20 },
  ];
  for (const row of rows) {
    await db.insert(externalMcpToolCalls).values({
      userId: "stats-user",
      projectId: "invest-agent",
      instanceId: "stats-instance",
      serverId,
      toolName,
      status: row.status,
      elapsedMs: row.elapsedMs,
      errorClass: row.errorClass,
      createdAt: new Date(baseTime + row.offsetSec * 1000).toISOString(),
    });
  }

  const summary = readExternalMcpToolCallStats({ days: 7 });
  const hit = summary.stats.find((s) => s.serverId === serverId && s.toolName === toolName);
  assert.ok(hit, "expected stat row for injected sample");
  assert.equal(hit.totalCalls, 5);
  assert.equal(hit.completed, 4);
  assert.equal(hit.failed, 1);
  assert.equal(hit.failureRate, 0.2);
  assert.equal(hit.lastErrorClass, "HTTP_500");
  // p95 over [100,200,300,400,500] → 第 95 百分位 ≈ 500
  assert.ok(hit.latencyP95Ms !== null && hit.latencyP95Ms >= 400, `p95 too low: ${hit.latencyP95Ms}`);
  // registrations 暴露已声明的注册项 (含激活状态)
  const ids = summary.registrations.map((r) => r.id);
  assert.ok(ids.includes("market-data-tool"));
  assert.ok(ids.includes("qsse-qlib"));

  await db.delete(externalMcpToolCalls);
});

test("readExternalMcpToolCallStats respects the days window", async () => {
  initDb();
  const serverId = "window-test-server";
  const toolName = "window_test_tool";
  await db.delete(externalMcpToolCalls);
  const now = Date.now();
  // 一条在窗口内 (10 分钟前),一条在窗口外 (30 天前)
  await db.insert(externalMcpToolCalls).values({
    userId: "window-user", projectId: "invest-agent", instanceId: "window-instance",
    serverId, toolName, status: "completed", elapsedMs: 100,
    createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
  });
  await db.insert(externalMcpToolCalls).values({
    userId: "window-user", projectId: "invest-agent", instanceId: "window-instance",
    serverId, toolName, status: "failed", elapsedMs: 100, errorClass: "OLD",
    createdAt: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const summary7d = readExternalMcpToolCallStats({ days: 7 });
  const hit7d = summary7d.stats.find((s) => s.serverId === serverId);
  assert.ok(hit7d);
  assert.equal(hit7d.totalCalls, 1, "only the in-window row should be counted");

  await db.delete(externalMcpToolCalls);
});
