import assert from "node:assert/strict";
import test from "node:test";
import { listActivatedExternalMcps, resolveExternalMastraToolsets } from "../src/mastra/external-mcp.js";

test("external Mastra MCP uses the existing declarative registration and session filter", () => {
  const env = {
    INVEST_AGENT_MCP_MARKET_DATA_ENABLED: "true",
    MARKET_DATA_MCP_URL: "http://127.0.0.1:8000/mcp",
    MARKET_DATA_MCP_TOKEN: "test-token",
    INVEST_AGENT_MCP_QSSE_ENABLED: "true",
    QSSE_MCP_URL: "http://127.0.0.1:22648/mcp",
    QSSE_MCP_TOKEN: "quant-token",
  };
  const resolved = listActivatedExternalMcps(env);
  assert.deepEqual(resolved.map((item) => item.id).sort(), ["market-data-tool", "qsse-qlib"]);
  assert.equal(resolved.find((item) => item.id === "market-data-tool")?.headers.Authorization, "Bearer test-token");
  assert.ok(resolved.find((item) => item.id === "market-data-tool")?.sessionKinds.includes("scheduled-read"));
  assert.ok(!resolved.find((item) => item.id === "qsse-qlib")?.sessionKinds.includes("scheduled-read"));
});

test("external Mastra MCP fails closed when disabled or missing credentials", async () => {
  assert.deepEqual(listActivatedExternalMcps({}), []);
  assert.deepEqual(listActivatedExternalMcps({ INVEST_AGENT_MCP_MARKET_DATA_ENABLED: "true", MARKET_DATA_MCP_URL: "http://127.0.0.1:8000/mcp" }), []);
  const resolved = await resolveExternalMastraToolsets("interactive", {});
  assert.deepEqual(resolved.toolsets, {});
  await resolved.disconnect();
});
