#!/usr/bin/env node
/**
 * market-data-tool HTTP MCP live probe.
 *
 * Usage:
 *   MARKET_DATA_MCP_URL=http://127.0.0.1:8000/mcp \
 *   MARKET_DATA_MCP_TOKEN=... \
 *   npm run probe:market-data-tool
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MARKET_DATA_MCP_URL;
const token = process.env.MARKET_DATA_MCP_TOKEN;

if (!url || !token) {
  console.error("[market-data-probe] requires MARKET_DATA_MCP_URL and MARKET_DATA_MCP_TOKEN");
  process.exit(1);
}

const client = new Client({ name: "invest-agent-market-data-probe", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const capabilities = await client.callTool({ name: "list_capabilities", arguments: {} });
  const quote = await client.callTool({
    name: "get_realtime_quote",
    arguments: { symbols: ["600519"] },
  });
  const parse = (result) => JSON.parse(result.content?.find((item) => item.type === "text")?.text || "{}");
  const capabilityData = parse(capabilities);
  const quoteData = parse(quote);
  const conclusion = {
    timestamp: new Date().toISOString(),
    transport: "http",
    endpointConfigured: true,
    toolsDiscovered: listed.tools?.length || 0,
    toolNames: (listed.tools || []).map((tool) => tool.name).sort(),
    capabilitiesReturned: Boolean(capabilityData),
    quoteReturned: Array.isArray(quoteData.rows) && quoteData.rows.length > 0,
    quoteSource: quoteData.meta?.source,
  };
  console.log(JSON.stringify(conclusion, null, 2));
  if (!conclusion.toolsDiscovered || !conclusion.quoteReturned) {
    throw new Error("tool discovery or realtime quote returned no data");
  }
  console.error(`[market-data-probe] PASSED tools=${conclusion.toolsDiscovered} source=${conclusion.quoteSource}`);
} catch (error) {
  console.error(`[market-data-probe] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
