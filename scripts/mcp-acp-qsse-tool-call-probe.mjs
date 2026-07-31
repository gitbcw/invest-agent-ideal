#!/usr/bin/env node
/**
 * qsse-qlib 真实 ACP 工具调用探针。
 *
 * 先通过原始 MCP 调用 quant_capabilities 获取动态 data_as_of，再让 Codex ACP
 * 调用同一工具并只回复该日期。两者一致才通过，避免用固定 sentinel 伪证工具调用。
 *
 * 在已配置 QSSE HTTP MCP 的 Invest Agent 运行时执行：
 *   INVEST_AGENT_MCP_QSSE_ENABLED=true \
 *   QSSE_MCP_URL=http://118.145.115.197:22648/mcp \
 *   QSSE_MCP_TOKEN=... \
 *   npm run probe:mcp-qsse-tool-call
 */

import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const QSSE_MCP_URL = process.env.QSSE_MCP_URL || "http://118.145.115.197:22648/mcp";
const QSSE_MCP_TOKEN = process.env.QSSE_MCP_TOKEN;

if (
  process.env.INVEST_AGENT_MCP_QSSE_ENABLED !== "true" ||
  !QSSE_MCP_TOKEN
) {
  console.error(
    "[qsse-acp-probe] requires INVEST_AGENT_MCP_QSSE_ENABLED=true, " +
      "and QSSE_MCP_TOKEN",
  );
  process.exit(1);
}

async function readLiveCapabilities() {
  const client = new Client({ name: "invest-agent-qsse-probe", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(QSSE_MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${QSSE_MCP_TOKEN}` } },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = (listed.tools || []).map((tool) => tool.name).sort();
    const expectedTools = [
      "quant_capabilities",
      "quant_screen_stocks",
      "quant_validate_expression",
    ];
    if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
      throw new Error(`unexpected qsse tools: ${toolNames.join(",")}`);
    }

    const called = await client.callTool({ name: "quant_capabilities", arguments: {} });
    const text = called.content?.find((item) => item.type === "text")?.text;
    if (!text) throw new Error("quant_capabilities returned no text content");
    const capabilities = JSON.parse(text);
    if (!capabilities.ok || !/^\d{4}-\d{2}-\d{2}$/.test(capabilities.data_as_of || "")) {
      throw new Error(`quant_capabilities not ready: ${text.slice(0, 300)}`);
    }
    return {
      toolNames,
      dataAsOf: capabilities.data_as_of,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

const { getCurrentAcpAgent, disposeAcpForWorkspace } = await import("../dist/acp/stdio-agent.js");
const live = await readLiveCapabilities();
const workspacePath = path.join(process.cwd(), "data/test-workspaces/qsse-acp-tool-call-probe");
const conversationId = `qsse-acp-tool-call-${Date.now()}`;

try {
  const agent = await getCurrentAcpAgent(workspacePath);
  const result = await agent.chatWithUsage({
    conversationId,
    text: [
      "必须调用 quant_capabilities 工具读取量化选股数据状态。",
      "只回复工具结果里的 data_as_of，格式必须是 YYYY-MM-DD，不要其他文字。",
    ].join(""),
    cwd: workspacePath,
    timeoutMs: 120000,
  });
  const reply = result.text.trim();
  const detectedDate = reply.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const passed = detectedDate === live.dataAsOf;
  const conclusion = {
    timestamp: new Date().toISOString(),
    conversationId,
    toolsDiscovered: live.toolNames,
    expectedDataAsOf: live.dataAsOf,
    detectedDataAsOf: detectedDate,
    passed,
  };
  console.log(JSON.stringify(conclusion, null, 2));
  if (!passed) {
    throw new Error(`ACP sentinel mismatch expected=${live.dataAsOf} reply=${JSON.stringify(reply)}`);
  }
  console.error(`[qsse-acp-probe] PASSED data_as_of=${live.dataAsOf}`);
} catch (error) {
  console.error(`[qsse-acp-probe] FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  try {
    await disposeAcpForWorkspace(workspacePath);
  } catch {}
}
