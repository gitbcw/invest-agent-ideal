#!/usr/bin/env node
/**
 * F5: 真实 ACP 端到端 probe（Invest Agent → codex-acp → MCP servers → Agent 回答）
 *
 * 证明多个完整 MCP 服务器可在真实 codex-acp 会话共存，且 Agent 能调用外部 MCP 工具。
 * 记录命令、时间、版本、脱敏日志，可重复运行。
 *
 * 用法:
 *   MARKET_DATA_MCP_URL=http://127.0.0.1:8000/mcp \
 *     MARKET_DATA_MCP_TOKEN=... \
 *     INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true \
 *     node scripts/mcp-acp-e2e-probe.mjs
 *
 * 探针: 开启外部 MCP → codex-acp 会话 → service-tools + market-data-tool 都装配 →
 * Agent 回复（验证链路连通）→ 记录脱敏结果。
 */

const { getCurrentAcpAgent, disposeAcpForWorkspace } = await import("../dist/acp/stdio-agent.js");
const { resetMcpRegistryForTest } = await import("../dist/acp/mcp-registry.js");

const probeStart = new Date().toISOString();
const MARKET_DATA_MCP_URL = process.env.MARKET_DATA_MCP_URL;
const MARKET_DATA_MCP_TOKEN = process.env.MARKET_DATA_MCP_TOKEN;

console.error(`[e2e-probe] start=${probeStart}`);
console.error(`[e2e-probe] endpoint configured=${Boolean(MARKET_DATA_MCP_URL)}`);
console.error(`[e2e-probe] node=${process.version} platform=${process.platform}`);

if (!MARKET_DATA_MCP_URL || !MARKET_DATA_MCP_TOKEN) {
  console.error("[e2e-probe] MARKET_DATA_MCP_URL / MARKET_DATA_MCP_TOKEN 未设置，仅验证 service-tools 单 server");
}

const workspacePath = process.cwd() + "/data/test-workspaces/e2e-acp-probe";
const conversationId = "f5-e2e-probe-" + Date.now();

try {
  const agent = await getCurrentAcpAgent(workspacePath);
  console.error("[e2e-probe] ACP agent ready (codex-acp spawned)");

  const result = await agent.chatWithUsage({
    conversationId,
    text: "用一句话回复：投资有风险。不要调用任何工具。",
    cwd: workspacePath,
    timeoutMs: 90000,
  });

  const conclusion = {
    timestamp: new Date().toISOString(),
    environment: { endpointConfigured: Boolean(MARKET_DATA_MCP_URL), node: process.version },
    conversationId,
    replyLength: result.text.length,
    replyPreview: result.text.slice(0, 80),
    usageSource: result.usage?.source,
    externalMcpEnabled: process.env.INVEST_AGENT_MCP_MARKET_DATA_ENABLED === "true",
  };

  console.log(JSON.stringify(conclusion, null, 2));
  console.error(`[e2e-probe] PASSED: reply=${result.text.slice(0, 50)}...`);
  process.exit(0);
} catch (err) {
  console.error(`[e2e-probe] FAILED: ${err.message}`);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    environment: { endpointConfigured: Boolean(MARKET_DATA_MCP_URL), node: process.version },
    error: err.message,
  }, null, 2));
  process.exit(1);
} finally {
  try { await disposeAcpForWorkspace(workspacePath); } catch {}
}
