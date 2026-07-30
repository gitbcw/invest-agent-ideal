import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuiltinServiceToolsRegistration,
  createMcpRegistry,
  validateRegistration,
  resolveExternalServer,
  isExternalStdioHealthy,
  isForbiddenExternalRef,
  type McpServerRegistration,
} from "../src/acp/mcp-registry.js";
import {
  buildMarketDataToolRegistration,
  buildExternalRegistrations,
} from "../src/acp/external-mcp-registrations.js";
import { resolveSessionMcpServers } from "../src/acp/mcp-session-manifest.js";

// ─── 注册项校验 ──────────────────────────────────────────────────

test("market-data-tool registration is external-readonly with safe envRefs", () => {
  const reg = buildMarketDataToolRegistration();
  assert.equal(validateRegistration(reg), null);
  assert.equal(reg.trustClass, "external-readonly");
  assert.equal(reg.owner, "external");
  assert.equal(reg.enabled, false); // 默认关闭
  assert.equal(reg.transport.kind, "stdio");

  // 不含 evaluation (eval 隔离会话不接入外部 MCP)
  assert.deepEqual(reg.sessionKinds, ["interactive", "scheduled-read"]);

  // envRefs 不含任何 service scope 引用
  for (const ref of reg.transport.envRefs || []) {
    assert.equal(isForbiddenExternalRef(ref), false, `forbidden ref leaked: ${ref}`);
  }
  // 明确不含 DB_PATH / sandbox secret
  assert.ok(!(reg.transport.envRefs || []).includes("DB_PATH"));
  assert.ok(!(reg.transport.envRefs || []).includes("INVEST_AGENT_SANDBOX_SECRET"));
});

test("buildExternalRegistrations returns market-data-tool only", () => {
  const regs = buildExternalRegistrations();
  assert.equal(regs.length, 1);
  assert.equal(regs[0].id, "market-data-tool");
});

// ─── 默认禁用 (零行为回归) ────────────────────────────────────────

test("default registry (no env switch) contains only service-tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const ids = registry.listRegistrations().map((r) => r.id);
  assert.deepEqual(ids, ["invest-agent-service-tools"]);
  assert.ok(!ids.includes("market-data-tool"));
});

// ─── 开启后会话装配两个 server ────────────────────────────────────

const HEALTHY_ENV = {
  INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
  DB_PATH: "a.db",
  WORKSPACE_ROOT: "w",
  MDT_UV_BIN: "/usr/local/bin/uv",
  MDT_PROJECT_DIR: "/path/to/market-data-tool",
  MDT_SEARCH_PROVIDER: "doubao",
  MDT_SEARCH_API_KEY: "search-secret",
};

test("enabled market-data-tool is assembled alongside service-tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  // 显式注册并启用外部 MCP (模拟 INVEST_AGENT_MCP_EXTERNAL_ENABLED=true)
  const mdt = buildMarketDataToolRegistration();
  registry.register(mdt);
  registry.setEnabled("market-data-tool", true);

  const { servers, manifest } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a", conversationId: "c1" },
    env: HEALTHY_ENV,
    taskType: "interactive",
    sessionId: "c1",
    registry,
  });

  assert.equal(servers.length, 2);
  const ids = servers.map((s) => s.name);
  assert.ok(ids.includes("invest-agent-service-tools"));
  assert.ok(ids.includes("market-data-tool"));

  // market-data-tool 的 command 是 uv,args 是 run --project ... mdt-mcp
  const mdtServer = servers.find((s) => s.name === "market-data-tool")!;
  assert.equal(mdtServer.command, "/usr/local/bin/uv");
  assert.deepEqual(mdtServer.args, ["run", "--project", "/path/to/market-data-tool", "mdt-mcp"]);

  // manifest 记录两个 server
  assert.equal(manifest.servers.length, 2);
  assert.ok(manifest.servers.some((s) => s.id === "market-data-tool"));
});

test("external server env does NOT contain service scope (DB_PATH etc)", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: HEALTHY_ENV,
    taskType: "interactive",
    sessionId: "c1",
    registry,
  });

  const mdtServer = servers.find((s) => s.name === "market-data-tool")!;
  const envNames = mdtServer.env.map((e) => e.name);
  // 外部 MCP 绝不收到 service scope
  assert.ok(!envNames.includes("DB_PATH"));
  assert.ok(!envNames.includes("INVEST_AGENT_SANDBOX_SECRET"));
  assert.ok(!envNames.includes("WORKSPACE_ROOT"));
  assert.ok(!envNames.includes("INVEST_AGENT_MCP_USER_ID"));
  // 只含它自己声明的、存在的引用
  assert.ok(envNames.includes("MDT_UV_BIN"));
  assert.ok(envNames.includes("MDT_PROJECT_DIR"));
  assert.ok(envNames.includes("MDT_SEARCH_API_KEY"));
});

// ─── fail closed: 缺必需 env 时 skip ──────────────────────────────

test("missing MDT_PROJECT_DIR skips market-data-tool but keeps service-tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: {
      INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
      DB_PATH: "a.db",
      MDT_UV_BIN: "/usr/local/bin/uv",
      // 缺 MDT_PROJECT_DIR
    },
    taskType: "interactive",
    sessionId: "c1",
    registry,
  });

  // 外部 MCP skip,会话只剩 service-tools (不阻断)
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "invest-agent-service-tools");
});

test("isExternalStdioHealthy returns false without required env", () => {
  const mdt = buildMarketDataToolRegistration();
  assert.equal(isExternalStdioHealthy(mdt, {}), false);
  assert.equal(isExternalStdioHealthy(mdt, { MDT_UV_BIN: "uv" }), false);
  assert.equal(isExternalStdioHealthy(mdt, { MDT_UV_BIN: "uv", MDT_PROJECT_DIR: "/x" }), true);
});

test("resolveExternalServer returns null when unhealthy", () => {
  const mdt = buildMarketDataToolRegistration();
  assert.equal(resolveExternalServer(mdt, {}), null);
});

// ─── sessionKind 过滤: external 不进 evaluation ───────────────────

test("market-data-tool does not enter evaluation sessions", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: { ...HEALTHY_ENV, ACP_EVAL_MCP_ALLOWED_TOOLS: "research.web_search" },
    taskType: "evaluation",
    sessionId: "eval-1",
    registry,
  });

  const ids = servers.map((s) => s.name);
  // evaluation 不含 market-data-tool (sessionKinds 不含 evaluation)
  assert.ok(!ids.includes("market-data-tool"));
});

// ─── 动态发现证明: 无逐工具映射 ────────────────────────────────────

test("no per-tool mapping exists in invest-agent for market-data-tool tools", () => {
  // market-data-tool 的 15 个工具名,invest-agent 代码里不应有逐工具适配器。
  // 如果未来新增第 16 个工具,invest-agent 无需改代码即可发现。
  const mdt = buildMarketDataToolRegistration();
  // 注册项 transport 只描述"如何启动 server",不含任何工具名映射
  const transportJson = JSON.stringify(mdt.transport);
  const knownTools = [
    "get_realtime_quote", "get_hist_kline", "search_securities",
    "get_fund_flow", "get_financial_report", "get_stock_profile",
  ];
  for (const tool of knownTools) {
    // 工具清单由 server 握手 tools/list 决定,不写死在注册项里
    assert.equal(transportJson.includes(tool), false, `tool name leaked into registration: ${tool}`);
  }
});

test("external registration rejects forbidden ref at validation time", () => {
  const leaking: McpServerRegistration = {
    id: "bad-external",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "stdio", command: "x", args: [], envRefs: ["DB_PATH"] },
    sessionKinds: ["interactive"],
  };
  const err = validateRegistration(leaking);
  assert.ok(err);
  assert.match(err!, /must not reference service scope env/);
});

test("duplicate external server id is rejected", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  // 再次注册同名 → fail closed
  assert.throws(
    () => registry.register(buildMarketDataToolRegistration()),
    /duplicate server id/,
  );
});
