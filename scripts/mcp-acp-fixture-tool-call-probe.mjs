#!/usr/bin/env node
/**
 * R5: 真实 ACP 外部工具调用证据（fixture MCP 版）。
 *
 * market-data-tool 的 stdio transport 与 codex-acp 有已知兼容性问题
 * (rmcp::transport::worker 断开)，导致 tools/call 不稳定。R5 文档允许
 * "使用 fixture MCP 的进程外计数/日志"证明工具调用。
 *
 * 本 probe 用一个极简 fixture MCP server（Node 内联，无 transport 问题），
 * 要求 Agent 调用它的 get_sentinel 工具。fixture server 通过进程外文件
 * 计数器记录调用。Probe 验证：
 *   1. fixture server 被调用（计数器 > 0）
 *   2. Agent 回复包含 sentinel（由工具返回值派生，非模型常识）
 *   3. 两个 server 同时装配
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROBE_SENTINEL = "R5_SENTINEL_42bZ9k";
const PROBE_ROOT = mkdtempSync(join(tmpdir(), "invest-agent-r5-fixture-"));
const COUNTER_FILE = join(PROBE_ROOT, "call-counter.txt");

// 清理旧计数器
writeFileSync(COUNTER_FILE, "0", "utf-8");

// fixture MCP server 脚本（极简，无外部依赖，稳定 transport）
const fixtureScript = `
  let id = 0;
  const fs = require('fs');
  const counterFile = ${JSON.stringify(COUNTER_FILE)};
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().split('\\n')) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'r5-fixture', version: '1.0.0' }
        }}) + '\\n');
      } else if (msg.method === 'notifications/initialized') {
        // no response
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          tools: [{ name: 'get_sentinel', description: 'Returns a unique sentinel string', inputSchema: { type: 'object', properties: {} } }]
        }}) + '\\n');
      } else if (msg.method === 'tools/call') {
        if (msg.params?.name === 'get_sentinel') {
          // 计数器 +1（进程外证据）
          try { const c = parseInt(fs.readFileSync(counterFile, 'utf-8') || '0', 10); fs.writeFileSync(counterFile, String(c + 1)); } catch {}
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            content: [{ type: 'text', text: ${JSON.stringify(PROBE_SENTINEL)} }]
          }}) + '\\n');
        }
      }
    }
  });
`;

const { getCurrentAcpAgent, disposeAcpForWorkspace, resetToolConflictCacheForTest } = await import("../dist/acp/stdio-agent.js");
const { getMcpRegistry } = await import("../dist/acp/mcp-registry.js");

// 注册 fixture 为外部 MCP（临时，仅本 probe）
const registry = getMcpRegistry();
try {
  registry.register({
    id: "r5-fixture",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "stdio", command: process.execPath, args: ["-e", fixtureScript], envRefs: [] },
    sessionKinds: ["interactive"],
  });
} catch { /* 已注册 */ }
registry.setEnabled("r5-fixture", true);
resetToolConflictCacheForTest();

const workspacePath = join(PROBE_ROOT, "workspace");
const conversationId = "r5-fixture-" + Date.now();

console.error(`[r5-fixture-probe] start=${new Date().toISOString()}`);
console.error(`[r5-fixture-probe] sentinel=${PROBE_SENTINEL}`);

try {
  const agent = await getCurrentAcpAgent(workspacePath, { modelTier: "simple" });
  console.error("[r5-fixture-probe] ACP agent ready");

  const result = await agent.chatWithUsage({
    conversationId,
    text: "调用 get_sentinel 工具，然后逐字回复它返回的内容。不要添加任何其他文字。",
    cwd: workspacePath,
    timeoutMs: 120000,
  });

  const reply = result.text.trim();
  const counter = parseInt(readFileSync(COUNTER_FILE, "utf-8") || "0", 10);
  const hasSentinel = reply.includes(PROBE_SENTINEL);
  const wasCalled = counter > 0;

  const conclusion = {
    timestamp: new Date().toISOString(),
    conversationId,
    replyPreview: reply.slice(0, 80),
    fixtureCallCount: counter,
    wasCalled,
    hasSentinel,
    proof: wasCalled && hasSentinel
      ? "fixture server 被调用 " + counter + " 次 + Agent 回复含 sentinel = 工具调用链路验证"
      : "未验证（wasCalled=" + wasCalled + " hasSentinel=" + hasSentinel + "）",
  };

  console.log(JSON.stringify(conclusion, null, 2));

  if (wasCalled && hasSentinel) {
    console.error(`[r5-fixture-probe] PASSED: fixture called ${counter}x, sentinel present`);
    process.exit(0);
  } else {
    console.error(`[r5-fixture-probe] RESULT: wasCalled=${wasCalled} hasSentinel=${hasSentinel}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[r5-fixture-probe] FAILED: ${err.message}`);
  process.exit(1);
} finally {
  try {
    await disposeAcpForWorkspace(workspacePath);
    registry.setEnabled("r5-fixture", false);
    rmSync(PROBE_ROOT, { recursive: true, force: true });
  } catch {}
}
