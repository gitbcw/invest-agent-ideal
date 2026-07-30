import assert from "node:assert/strict";
import test from "node:test";
import { probeToolConflicts, shouldBlockSessionOnConflict, type ToolConflictReport } from "../src/acp/mcp-tool-conflict-probe.js";
import type { AcpMcpServer } from "../src/acp/mcp-session-manifest.js";

/**
 * F5: 工具名冲突检测测试。
 *
 * codex-acp 是平面命名空间，不自动 namespace。本探针连接各 server 枚举 tools/list，
 * 对跨 server 重名 fail closed。
 */

// 用两个简单的 Node 脚本作为 fixture MCP server（stdio，响应 initialize + tools/list）

function makeFixtureServer(name: string, toolNames: string[]): AcpMcpServer {
  const script = `
    let id = 0;
    process.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().split('\\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: '${name}', version: '1.0.0' }
          }}) + '\\n');
        } else if (msg.method === 'notifications/initialized') {
          // no response
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            tools: ${JSON.stringify(toolNames)}.map(n => ({ name: n }))
          }}) + '\\n');
        }
      }
    });
  `;
  return {
    name,
    command: process.execPath,
    args: ["-e", script],
    env: [],
  };
}

test("no conflict when servers have distinct tool names", async () => {
  const servers = [
    makeFixtureServer("server-a", ["tool_a", "tool_b"]),
    makeFixtureServer("server-b", ["tool_c", "tool_d"]),
  ];
  const report = await probeToolConflicts(servers);
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.serverTools.size, 2);
  assert.equal(report.failedServers.size, 0);
});

test("conflict detected when two servers share a tool name", async () => {
  const servers = [
    makeFixtureServer("service-tools", ["market.quote", "portfolio.read"]),
    makeFixtureServer("external-mcp", ["market.quote", "research.search"]),
  ];
  const report = await probeToolConflicts(servers);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].toolName, "market.quote");
  assert.deepEqual(report.conflicts[0].servers.sort(), ["external-mcp", "service-tools"]);
});

test("shouldBlockSessionOnConflict blocks on any conflict (fail closed)", () => {
  const reportWithConflict: ToolConflictReport = {
    conflicts: [{ toolName: "market.quote", servers: ["a", "b"] }],
    serverTools: new Map(),
    failedServers: new Map(),
  };
  assert.equal(shouldBlockSessionOnConflict(reportWithConflict, "service-tools"), true);

  const reportClean: ToolConflictReport = {
    conflicts: [],
    serverTools: new Map(),
    failedServers: new Map(),
  };
  assert.equal(shouldBlockSessionOnConflict(reportClean, "service-tools"), false);
});

test("failed server probe recorded in failedServers, does not block others", async () => {
  const goodServer = makeFixtureServer("good", ["tool_x"]);
  const badServer: AcpMcpServer = {
    name: "bad",
    command: process.execPath,
    args: ["-e", "process.exit(1)"], // 立即退出
    env: [],
  };
  const report = await probeToolConflicts([goodServer, badServer]);
  assert.equal(report.conflicts.length, 0);
  assert.ok(report.failedServers.has("bad"), "bad server recorded as failed");
  assert.ok(report.serverTools.has("good"), "good server still probed");
});
