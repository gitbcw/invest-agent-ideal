#!/usr/bin/env node
/**
 * R5: 真实 ACP 外部工具调用证据。
 *
 * 证明 Agent 实际调用了 market-data-tool 并消费其返回，而不是只证明 ACP 能回复。
 *
 * 方法：要求 Agent 调用 market-data-tool 的 list_capabilities 工具（无副作用自描述），
 * 报告返回的工具数量。通过回答中包含的 sentinel（精确数字）证明：
 *   1. Agent 确实调用了工具（数字来自 tools/list，不是模型常识）
 *   2. 外部 MCP 被消费（列式 JSON 结果被解析）
 *
 * 禁用/破坏外部 MCP 时，Agent 无法获得正确的工具数量，probe 必须失败。
 *
 * 用法:
 *   MARKET_DATA_MCP_URL=http://127.0.0.1:8000/mcp \
 *     MARKET_DATA_MCP_TOKEN=... \
 *     INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true \
 *     node scripts/mcp-acp-tool-call-probe.mjs
 */

const { getCurrentAcpAgent, disposeAcpForWorkspace } = await import("../dist/acp/stdio-agent.js");

const probeStart = new Date().toISOString();
const MARKET_DATA_MCP_URL = process.env.MARKET_DATA_MCP_URL;
const MARKET_DATA_MCP_TOKEN = process.env.MARKET_DATA_MCP_TOKEN;

console.error(`[tool-call-probe] start=${probeStart}`);
console.error(`[tool-call-probe] endpoint configured=${Boolean(MARKET_DATA_MCP_URL)}`);

if (!MARKET_DATA_MCP_URL || !MARKET_DATA_MCP_TOKEN || process.env.INVEST_AGENT_MCP_MARKET_DATA_ENABLED !== "true") {
  console.error("[tool-call-probe] requires MARKET_DATA_MCP_URL, MARKET_DATA_MCP_TOKEN, and INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true");
  process.exit(1);
}

// list_capabilities 返回的工具数量（market-data-tool v1.29.0 是 15 个）
// Agent 必须调用工具才能知道这个数字
const EXPECTED_TOOL_COUNT = 15;

const workspacePath = process.cwd() + "/data/test-workspaces/r5-tool-call-probe";
const conversationId = "r5-tool-call-" + Date.now();

try {
  const agent = await getCurrentAcpAgent(workspacePath);
  console.error("[tool-call-probe] ACP agent ready, 发送要求工具调用的 prompt...");

  const result = await agent.chatWithUsage({
    conversationId,
    text: [
      "调用 market-data-tool 的 list_capabilities 工具。",
      "报告返回结果中有多少个工具（只回复一个数字，不要其他文字）。",
    ].join(""),
    cwd: workspacePath,
    timeoutMs: 120000,
  });

  const reply = result.text.trim();
  const replyNum = parseInt(reply, 10);

  // sentinel 断言：Agent 回复的数字必须等于实际工具数量
  const hasValidSentinel = replyNum === EXPECTED_TOOL_COUNT;

  const conclusion = {
    timestamp: new Date().toISOString(),
    environment: { endpointConfigured: Boolean(MARKET_DATA_MCP_URL), node: process.version },
    conversationId,
    replyRaw: reply.slice(0, 100),
    expectedToolCount: EXPECTED_TOOL_COUNT,
    detectedToolCount: replyNum,
    hasValidSentinel,
    proof: hasValidSentinel
      ? `Agent 回复 ${replyNum} = 实际工具数 ${EXPECTED_TOOL_COUNT}，证明调用了 market-data-tool`
      : `Agent 回复 "${reply}" 不匹配预期 ${EXPECTED_TOOL_COUNT}，可能未调用工具`,
  };

  console.log(JSON.stringify(conclusion, null, 2));

  if (hasValidSentinel) {
    console.error(`[tool-call-probe] PASSED: Agent called market-data-tool, reported ${replyNum} tools`);
    process.exit(0);
  } else {
    console.error(`[tool-call-probe] FAILED: sentinel mismatch (expected ${EXPECTED_TOOL_COUNT}, got "${reply}")`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[tool-call-probe] FAILED: ${err.message}`);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    environment: { endpointConfigured: Boolean(MARKET_DATA_MCP_URL) },
    error: err.message,
  }, null, 2));
  process.exit(1);
} finally {
  try { await disposeAcpForWorkspace(workspacePath); } catch {}
}
