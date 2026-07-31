import assert from "node:assert/strict";
import test from "node:test";
import { probeToolConflicts, shouldBlockSessionOnConflict, type ToolConflictReport } from "../src/acp/mcp-tool-conflict-probe.js";
import { checkToolConflictsBeforeSession, resetToolConflictCacheForTest } from "../src/acp/stdio-agent.js";
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
    makeFixtureServer("service-tools", ["shared.lookup", "portfolio.read"]),
    makeFixtureServer("external-mcp", ["shared.lookup", "research.search"]),
  ];
  const report = await probeToolConflicts(servers);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].toolName, "shared.lookup");
  assert.deepEqual(report.conflicts[0].servers.sort(), ["external-mcp", "service-tools"]);
});

test("shouldBlockSessionOnConflict blocks on any conflict (fail closed)", () => {
  const reportWithConflict: ToolConflictReport = {
    conflicts: [{ toolName: "shared.lookup", servers: ["a", "b"] }],
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

test("conflict probe does not inherit undeclared parent secrets", async () => {
  const previous = process.env.ACP_PROBE_PARENT_SECRET;
  process.env.ACP_PROBE_PARENT_SECRET = "must-not-leak";
  const script = `
    process.stdin.on('data', (chunk) => {
      for (const line of chunk.toString().split('\\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'env-probe', version: '1.0.0' }
          }}) + '\\n');
        } else if (msg.method === 'tools/list') {
          const name = process.env.ACP_PROBE_PARENT_SECRET ? 'secret_leaked' : 'env_isolated';
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name }] } }) + '\\n');
        }
      }
    });
  `;
  try {
    const report = await probeToolConflicts([{ name: "env-probe", command: process.execPath, args: ["-e", script], env: [] }]);
    assert.deepEqual(report.serverTools.get("env-probe"), ["env_isolated"]);
  } finally {
    if (previous === undefined) delete process.env.ACP_PROBE_PARENT_SECRET;
    else process.env.ACP_PROBE_PARENT_SECRET = previous;
  }
});

test("session assembly blocks when the service-tools probe fails", async () => {
  resetToolConflictCacheForTest();
  const failedService: AcpMcpServer = {
    name: "invest-agent-service-tools",
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    env: [],
  };
  await assert.rejects(
    () => checkToolConflictsBeforeSession("test", [failedService, makeFixtureServer("external", ["external.read"])]),
    /service-tools 工具冲突探针失败/,
  );
});

test("session assembly drops an external server when only its probe fails", async () => {
  resetToolConflictCacheForTest();
  const failedExternal: AcpMcpServer = {
    name: "external",
    command: process.execPath,
    args: ["-e", "process.exit(1)"],
    env: [],
  };
  const service = makeFixtureServer("invest-agent-service-tools", ["shared.lookup"]);
  const resolved = await checkToolConflictsBeforeSession("test", [service, failedExternal]);
  assert.deepEqual(resolved.map((server) => server.name), ["invest-agent-service-tools"]);
});

// ─── 三 server 回归 (service + 两个外部 stdio) ─────────────────────
//
// 探针本身已是通用逻辑;这里证明 service-owned + 两个 external-readonly stdio
// server 共存时,冲突策略保持不变,无需任何 server-specific 分支。

test("three assembled stdio servers with distinct tools all pass conflict probe", async () => {
  resetToolConflictCacheForTest();
  const service = makeFixtureServer("invest-agent-service-tools", ["portfolio.read", "watchlist.read"]);
  const extA = makeFixtureServer("market-data-tool", ["mdt.quote", "mdt.kline"]);
  const extB = makeFixtureServer("fixture-quant-tool", ["qst.screen", "qst.ranking"]);

  const report = await probeToolConflicts([service, extA, extB]);
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.serverTools.size, 3);
  assert.equal(report.failedServers.size, 0);
});

test("three-server external/external tool collision blocks session", async () => {
  resetToolConflictCacheForTest();
  // 两个外部 server 共享一个工具名 → 冲突,应阻断 (纯外部冲突也 fail closed)
  const service = makeFixtureServer("invest-agent-service-tools", ["portfolio.read"]);
  const extA = makeFixtureServer("market-data-tool", ["data.fetch", "mdt.quote"]);
  const extB = makeFixtureServer("fixture-quant-tool", ["data.fetch", "qst.screen"]);

  const report = await probeToolConflicts([service, extA, extB]);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].toolName, "data.fetch");
  assert.deepEqual(report.conflicts[0].servers.sort(), ["fixture-quant-tool", "market-data-tool"]);
  assert.equal(
    shouldBlockSessionOnConflict(report, "invest-agent-service-tools"),
    true,
  );
});

test("three-server external/service tool collision blocks session", async () => {
  resetToolConflictCacheForTest();
  // 外部 server 与 service server 冲突 → 阻断 (service 工具永不被外部遮蔽)
  const service = makeFixtureServer("invest-agent-service-tools", ["shared.lookup", "portfolio.read"]);
  const extA = makeFixtureServer("market-data-tool", ["mdt.quote"]);
  const extB = makeFixtureServer("fixture-quant-tool", ["shared.lookup", "qst.screen"]);

  const report = await probeToolConflicts([service, extA, extB]);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].toolName, "shared.lookup");
  assert.deepEqual(report.conflicts[0].servers.sort(), [
    "fixture-quant-tool",
    "invest-agent-service-tools",
  ]);
  assert.equal(
    shouldBlockSessionOnConflict(report, "invest-agent-service-tools"),
    true,
  );
});
