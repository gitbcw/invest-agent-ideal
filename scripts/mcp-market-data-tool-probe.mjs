#!/usr/bin/env node
/**
 * market-data-tool MCP 合约 live probe (WP2)
 *
 * 验证外部只读 MCP 可被整服务器接入、动态发现工具、返回真实数据。
 * 这是显式 live probe,单独记录环境/时间/结果,不取代离线测试。
 *
 * 用法:
 *   MDT_PROJECT_DIR=/path/to/market-data-tool MDT_UV_BIN=$(which uv) \
 *     node scripts/mcp-market-data-tool-probe.mjs
 *
 * 探针内容: initialize → tools/list → tools/call(get_realtime_quote)
 * 传输: MCP stdio (与 ACP codex 接入方式一致)
 */

import { spawn } from "node:child_process";

const MDT_PROJECT_DIR = process.env.MDT_PROJECT_DIR;
const MDT_UV_BIN = process.env.MDT_UV_BIN || "uv";

if (!MDT_PROJECT_DIR) {
  console.error("[probe] MDT_PROJECT_DIR 未设置,跳过 live probe");
  process.exit(75);
}

const probeStart = new Date().toISOString();
console.error(`[probe] start=${probeStart} project=${MDT_PROJECT_DIR} uv=${MDT_UV_BIN}`);

// ─── 启动 market-data-tool stdio MCP server ────────────────────────
const child = spawn(MDT_UV_BIN, ["run", "--project", MDT_PROJECT_DIR, "mdt-mcp"], {
  stdio: ["pipe", "pipe", "inherit"],
});

let id = 0;
const pending = new Map();

function send(method, params) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msgId, method, params }) + "\n");
  });
}

child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

const results = { tools: [], quote: null, errors: [] };

try {
  // 1. initialize
  const initResult = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "invest-agent-wp2-probe", version: "1.0.0" },
  });
  console.error(`[probe] initialized: server=${initResult.serverInfo?.name} v${initResult.serverInfo?.version}`);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. tools/list — 动态发现
  const listResult = await send("tools/list", {});
  results.tools = listResult.tools.map((t) => t.name);
  console.error(`[probe] tools/list: ${results.tools.length} tools discovered`);
  console.error(`[probe] tool names: ${results.tools.join(", ")}`);

  // 3. tools/call — 真实行情
  const callResult = await send("tools/call", {
    name: "get_realtime_quote",
    arguments: { symbols: ["600519"] },
  });
  const content = callResult.content?.[0]?.text;
  if (content) {
    const data = JSON.parse(content);
    results.quote = {
      columns: data.columns,
      rowCount: data.rows?.length,
      firstRow: data.rows?.[0],
      source: data.meta?.source,
    };
    console.error(`[probe] get_realtime_quote: source=${data.meta?.source} rows=${data.rows?.length}`);
    console.error(`[probe] first row: ${JSON.stringify(data.rows?.[0])}`);
  }

  // 结论
  const conclusion = {
    timestamp: new Date().toISOString(),
    environment: { MDT_PROJECT_DIR, MDT_UV_BIN },
    serverVersion: initResult.serverInfo?.version,
    transport: "stdio",
    toolsDiscovered: results.tools.length,
    toolNames: results.tools,
    quoteReturned: Boolean(results.quote),
    quoteSource: results.quote?.source,
  };

  // 失败条件: 未发现工具 或 quote 无数据
  if (results.tools.length === 0) {
    results.errors.push("tools/list returned 0 tools");
  }
  if (!results.quote) {
    results.errors.push("get_realtime_quote returned no data");
  }

  // 输出机器可读结论到 stdout
  console.log(JSON.stringify(conclusion, null, 2));

  if (results.errors.length > 0) {
    console.error(`[probe] FAILED: ${results.errors.join("; ")}`);
    process.exit(1);
  }
  console.error(`[probe] PASSED: ${results.tools.length} tools, quote source=${results.quote?.source}`);
  process.exit(0);
} catch (err) {
  console.error(`[probe] FAILED: ${err.message}`);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    environment: { MDT_PROJECT_DIR, MDT_UV_BIN },
    error: err.message,
  }, null, 2));
  process.exit(1);
} finally {
  child.kill();
}
