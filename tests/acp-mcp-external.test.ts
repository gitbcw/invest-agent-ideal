import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuiltinServiceToolsRegistration,
  createMcpRegistry,
  registerExternalMcpServers,
  validateRegistration,
  resolveExternalServer,
  resolveExternalHttpServer,
  checkExternalStdioReadiness,
  isForbiddenExternalRef,
  type McpServerRegistration,
  type ExternalStdioReadiness,
} from "../src/acp/mcp-registry.js";
import {
  buildMarketDataToolRegistration,
  buildQsseQlibRegistration,
  buildExternalRegistrations,
} from "../src/acp/external-mcp-registrations.js";
import { resolveSessionMcpServers } from "../src/acp/mcp-session-manifest.js";

// ─── 注册项校验 (冻结当前 market-data-tool 契约) ───────────────────

test("market-data-tool registration is external-readonly with safe HTTP credential refs", () => {
  const reg = buildMarketDataToolRegistration();
  assert.equal(validateRegistration(reg), null);
  assert.equal(reg.trustClass, "external-readonly");
  assert.equal(reg.owner, "external");
  assert.equal(reg.enabled, false); // 默认关闭
  assert.equal(reg.transport.kind, "http");

  // 不含 evaluation (eval 隔离会话不接入外部 MCP)
  assert.deepEqual(reg.sessionKinds, ["interactive", "scheduled-read"]);

  // HTTP header 引用不含任何 service scope 引用
  for (const ref of reg.transport.headers || []) {
    assert.equal(isForbiddenExternalRef(ref.envRef), false, `forbidden ref leaked: ${ref.envRef}`);
  }
  assert.ok(!(reg.transport.headers || []).some((header) => header.envRef === "DB_PATH"));
  assert.ok(!(reg.transport.headers || []).some((header) => header.envRef === "INVEST_AGENT_SANDBOX_SECRET"));
});

test("market-data-tool declares a remote HTTP endpoint and Bearer credential", () => {
  const reg = buildMarketDataToolRegistration();
  if (reg.transport.kind !== "http") throw new Error("expected http");

  assert.equal(reg.transport.url, "<env:MARKET_DATA_MCP_URL>");
  assert.deepEqual(reg.transport.requiredEnvRefs, ["MARKET_DATA_MCP_URL", "MARKET_DATA_MCP_TOKEN"]);
  assert.deepEqual(reg.transport.headers, [
    { name: "Authorization", envRef: "MARKET_DATA_MCP_TOKEN", prefix: "Bearer " },
  ]);
});

test("buildExternalRegistrations declares market-data-tool and qsse-qlib", () => {
  const regs = buildExternalRegistrations();
  assert.deepEqual(regs.map((reg) => reg.id), ["market-data-tool", "qsse-qlib"]);
});

// ─── 默认禁用 (零行为回归) ────────────────────────────────────────

test("default registry (no env switch) contains only service-tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(registry, {});
  const ids = registry.listRegistrations().map((r) => r.id);
  assert.deepEqual(ids, ["invest-agent-service-tools"]);
  assert.ok(!ids.includes("market-data-tool"));
});

test("dedicated market-data activation flag registers and enables market-data-tool", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(registry, { INVEST_AGENT_MCP_MARKET_DATA_ENABLED: "true" });

  const registration = registry.getRegistration("market-data-tool");
  assert.ok(registration);
  assert.equal(registration.enabled, true);
});

test("legacy external activation flag remains a market-data-tool compatibility alias", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(registry, { INVEST_AGENT_MCP_EXTERNAL_ENABLED: "true" });

  const registration = registry.getRegistration("market-data-tool");
  assert.ok(registration);
  assert.equal(registration.enabled, true);
});

test("activation flags require the exact true value", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(registry, {
    INVEST_AGENT_MCP_MARKET_DATA_ENABLED: "false",
    INVEST_AGENT_MCP_EXTERNAL_ENABLED: "TRUE",
  });

  assert.equal(registry.getRegistration("market-data-tool"), undefined);
});

test("qsse-qlib has an independent exact-true activation flag", () => {
  const disabled = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(disabled, { INVEST_AGENT_MCP_QSSE_ENABLED: "TRUE" });
  assert.equal(disabled.getRegistration("qsse-qlib"), undefined);

  const enabled = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(enabled, { INVEST_AGENT_MCP_QSSE_ENABLED: "true" });
  assert.equal(enabled.getRegistration("qsse-qlib")?.enabled, true);
  assert.equal(enabled.getRegistration("market-data-tool"), undefined);
});

// ─── qsse-qlib 生产注册契约 ───────────────────────────────────────

const QSSE_HEALTHY_ENV = {
  INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
  DB_PATH: "a.db",
  WORKSPACE_ROOT: "w",
  QSSE_MCP_URL: "http://118.145.115.197:22648/mcp",
  QSSE_MCP_TOKEN: "secret-token",
};

test("qsse-qlib registration is external-readonly, interactive-only, and valid", () => {
  const reg = buildQsseQlibRegistration();
  assert.equal(validateRegistration(reg), null);
  assert.equal(reg.id, "qsse-qlib");
  assert.equal(reg.owner, "external");
  assert.equal(reg.trustClass, "external-readonly");
  assert.equal(reg.enabled, false);
  assert.deepEqual(reg.sessionKinds, ["interactive"]);
  if (reg.transport.kind !== "http") throw new Error("expected http");
  assert.equal(reg.transport.url, "<env:QSSE_MCP_URL>");
  assert.deepEqual(reg.transport.requiredEnvRefs, ["QSSE_MCP_URL", "QSSE_MCP_TOKEN"]);
  assert.deepEqual(reg.transport.headers, [
    { name: "Authorization", envRef: "QSSE_MCP_TOKEN", prefix: "Bearer " },
  ]);
});

test("qsse-qlib resolves remote URL and bearer header without exposing the token", () => {
  const resolved = resolveExternalHttpServer(buildQsseQlibRegistration(), QSSE_HEALTHY_ENV);
  assert.ok(resolved);
  assert.equal(resolved.url, "http://118.145.115.197:22648/mcp");
  assert.deepEqual(resolved.headers, [
    { name: "Authorization", value: "Bearer secret-token" },
  ]);
});

test("qsse-qlib assembles beside service tools without receiving service scope", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registerExternalMcpServers(registry, {
    ...QSSE_HEALTHY_ENV,
    INVEST_AGENT_MCP_QSSE_ENABLED: "true",
  });

  const { servers, manifest } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/unrelated-user-workspace",
    userContext: { userId: "user-a", conversationId: "c1" },
    env: QSSE_HEALTHY_ENV,
    taskType: "interactive",
    sessionId: "c1",
    registry,
    mcpCapabilities: { http: true },
  });

  assert.deepEqual(servers.map((server) => server.name), ["invest-agent-service-tools", "qsse-qlib"]);
  const qsse = servers.find((server) => server.name === "qsse-qlib")!;
  assert.equal(qsse.type, "http");
  if (qsse.type !== "http") throw new Error("expected http server");
  assert.equal(qsse.url, QSSE_HEALTHY_ENV.QSSE_MCP_URL);
  assert.deepEqual(qsse.headers, [{ name: "Authorization", value: "Bearer secret-token" }]);
  assert.ok(!JSON.stringify(manifest).includes("secret-token"));
  assert.ok(manifest.servers.some((server) => server.id === "qsse-qlib"));
});

test("missing qsse launch configuration skips only qsse-qlib", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildQsseQlibRegistration());
  registry.setEnabled("qsse-qlib", true);

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: {
      INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
      DB_PATH: "a.db",
      QSSE_MCP_URL: "http://example.test/mcp",
      // 缺 QSSE_MCP_TOKEN
    },
    taskType: "interactive",
    sessionId: "c1",
    registry,
  });

  assert.deepEqual(servers.map((server) => server.name), ["invest-agent-service-tools"]);
});

test("qsse-qlib is excluded from scheduled and evaluation sessions", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildQsseQlibRegistration());
  registry.setEnabled("qsse-qlib", true);

  for (const [taskType, sessionId] of [["scheduled-market-watch", "s1"], ["evaluation", "e1"]]) {
    const { servers } = resolveSessionMcpServers({
      backendId: "codex",
      cwd: "/tmp/ws",
    env: QSSE_HEALTHY_ENV,
    taskType,
    sessionId,
    registry,
    mcpCapabilities: { http: true },
    });
    assert.ok(!servers.some((server) => server.name === "qsse-qlib"));
  }
});

// ─── 开启后会话装配两个 server ────────────────────────────────────

const HEALTHY_ENV = {
  INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
  DB_PATH: "a.db",
  WORKSPACE_ROOT: "w",
  MARKET_DATA_MCP_URL: "http://127.0.0.1:8000/mcp",
  MARKET_DATA_MCP_TOKEN: "market-data-secret",
};

test("enabled market-data-tool is assembled alongside service-tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  // 显式注册并启用外部 MCP (模拟 dedicated activation flag)
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
    mcpCapabilities: { http: true },
  });

  assert.equal(servers.length, 2);
  const ids = servers.map((s) => s.name);
  assert.ok(ids.includes("invest-agent-service-tools"));
  assert.ok(ids.includes("market-data-tool"));

  const mdtServer = servers.find((s) => s.name === "market-data-tool")!;
  assert.equal(mdtServer.type, "http");
  if (mdtServer.type !== "http") throw new Error("expected http server");
  assert.equal(mdtServer.url, HEALTHY_ENV.MARKET_DATA_MCP_URL);
  assert.deepEqual(mdtServer.headers, [{ name: "Authorization", value: "Bearer market-data-secret" }]);

  // manifest 记录两个 server
  assert.equal(manifest.servers.length, 2);
  assert.ok(manifest.servers.some((s) => s.id === "market-data-tool"));
});

test("market-data HTTP credentials do not enter the manifest", () => {
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
    mcpCapabilities: { http: true },
  });

  assert.ok(servers.some((server) => server.name === "market-data-tool"));
  assert.equal(JSON.stringify(servers.map((server) => ({ name: server.name, type: server.type }))).includes("market-data-secret"), false);
});

// ─── fail closed: 缺必需 env 时 skip (结构化诊断) ─────────────────

test("missing market-data HTTP token skips the server but keeps service-tools", () => {
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
      MARKET_DATA_MCP_URL: "http://127.0.0.1:8000/mcp",
      // 缺 MARKET_DATA_MCP_TOKEN
    },
    taskType: "interactive",
    sessionId: "c1",
    registry,
    mcpCapabilities: { http: true },
  });

  // 外部 MCP skip,会话只剩 service-tools (不阻断)
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "invest-agent-service-tools");
});

test("market-data HTTP resolve requires URL and token", () => {
  const mdt = buildMarketDataToolRegistration();
  assert.equal(resolveExternalHttpServer(mdt, {}), null);
  assert.equal(resolveExternalHttpServer(mdt, { MARKET_DATA_MCP_URL: "http://x/mcp" }), null);
  assert.deepEqual(resolveExternalHttpServer(mdt, HEALTHY_ENV), {
    url: HEALTHY_ENV.MARKET_DATA_MCP_URL,
    headers: [{ name: "Authorization", value: "Bearer market-data-secret" }],
  });
});

test("checkExternalStdioReadiness accepts literal commands without required refs", () => {
  const literal: McpServerRegistration = {
    id: "literal-cmd",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "stdio", command: "/usr/bin/python3", args: ["-m", "server"] },
    sessionKinds: ["interactive"],
  };
  assert.deepEqual(checkExternalStdioReadiness(literal, {}), { ok: true });
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

test("external HTTP registration rejects service scope in headers and required refs", () => {
  const leaking: McpServerRegistration = {
    id: "bad-http-external",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "http",
      url: "<env:EXTERNAL_MCP_URL>",
      headers: [{ name: "X-Service-Scope", envRef: "DB_PATH" }],
      requiredEnvRefs: ["EXTERNAL_MCP_URL", "DB_PATH"],
    },
    sessionKinds: ["interactive"],
  };

  const err = validateRegistration(leaking);
  assert.ok(err);
  assert.match(err, /must not reference service scope env.*DB_PATH/);
  assert.equal(
    resolveExternalHttpServer(leaking, { EXTERNAL_MCP_URL: "http://example.test/mcp", DB_PATH: "secret.db" }),
    null,
  );
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

// ─── 凭据/密钥隔离: 不进 manifest/指纹/日志 ─────────────────────────

test("credential value is absent from the manifest and HTTP conflict-cache fingerprint", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);

  const SECRET = "super-secret-api-key-DO-NOT-LEAK";
  const { manifest, servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: { ...HEALTHY_ENV, MARKET_DATA_MCP_TOKEN: SECRET },
    taskType: "interactive",
    sessionId: "c1",
    registry,
    mcpCapabilities: { http: true },
  });

  const manifestJson = JSON.stringify(manifest);
  assert.equal(manifestJson.includes(SECRET), false, "secret leaked into manifest");
  const http = servers.find((server) => server.type === "http");
  assert.ok(http && http.type === "http");
  assert.equal(http.configFingerprint.includes(SECRET), false, "secret leaked into HTTP cache fingerprint");
});

// ─── 第二个外部注册项 (fixture-quant-tool) 证明无需核心改动 ──────────
//
// 不进入生产注册表;仅证明通用解析对一个不相关的外部 server 同样成立。

function buildFixtureQuantRegistration(): McpServerRegistration {
  return {
    id: "fixture-quant-tool",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:QST_PYTHON>",
      args: ["-m", "quant_server", "--data-dir", "<env:QST_PROJECT_DIR>"],
      requiredEnvRefs: ["QST_PYTHON", "QST_PROJECT_DIR"],
      envRefs: ["QST_PYTHON", "QST_PROJECT_DIR", "QST_API_KEY"],
    },
    versionPolicy: { expected: "0.1.0", allowedRange: "^0" },
    sessionKinds: ["interactive"],
  };
}

const QST_HEALTHY_ENV = {
  QST_PYTHON: "/usr/bin/python3",
  QST_PROJECT_DIR: "/srv/quant",
  QST_API_KEY: "qst-secret-token",
};

test("fixture quant tool resolves its own command and args", () => {
  const resolved = resolveExternalServer(buildFixtureQuantRegistration(), QST_HEALTHY_ENV);
  assert.ok(resolved);
  assert.equal(resolved.command, "/usr/bin/python3");
  assert.deepEqual(resolved.args, ["-m", "quant_server", "--data-dir", "/srv/quant"]);
});

test("fixture quant tool coexists with market-data-tool and service tools", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);
  registry.register(buildFixtureQuantRegistration());

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: { ...HEALTHY_ENV, ...QST_HEALTHY_ENV },
    taskType: "interactive",
    sessionId: "c1",
    registry,
    mcpCapabilities: { http: true },
  });

  const ids = servers.map((s) => s.name).sort();
  assert.deepEqual(ids, ["fixture-quant-tool", "invest-agent-service-tools", "market-data-tool"]);
});

test("missing QST_PROJECT_DIR skips only fixture quant server", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildMarketDataToolRegistration());
  registry.setEnabled("market-data-tool", true);
  registry.register(buildFixtureQuantRegistration());

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: {
      ...HEALTHY_ENV,
      QST_PYTHON: "/usr/bin/python3",
      // 缺 QST_PROJECT_DIR
    },
    taskType: "interactive",
    sessionId: "c1",
    registry,
    mcpCapabilities: { http: true },
  });

  const ids = servers.map((s) => s.name);
  // fixture 被跳过,其余两个保留
  assert.ok(!ids.includes("fixture-quant-tool"));
  assert.ok(ids.includes("invest-agent-service-tools"));
  assert.ok(ids.includes("market-data-tool"));
});

test("fixture quant tool credentials reach only its child environment", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildFixtureQuantRegistration());

  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: { ...HEALTHY_ENV, ...QST_HEALTHY_ENV },
    taskType: "interactive",
    sessionId: "c1",
    registry,
  });

  const qst = servers.find((s) => s.name === "fixture-quant-tool")!;
  const qstEnvNames = qst.env.map((e) => e.name);
  assert.ok(qstEnvNames.includes("QST_API_KEY"));
  // 绝不出现 service scope 或 market-data 的引用
  assert.ok(!qstEnvNames.includes("DB_PATH"));
  assert.ok(!qstEnvNames.includes("MARKET_DATA_MCP_TOKEN"));
});

test("fixture quant tool cannot declare forbidden service scope refs", () => {
  const leaking: McpServerRegistration = {
    id: "fixture-quant-leaky",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:QST_PYTHON>",
      args: [],
      requiredEnvRefs: ["QST_PYTHON", "DB_PATH"],
      envRefs: ["QST_PYTHON", "DB_PATH"],
    },
    sessionKinds: ["interactive"],
  };
  const err = validateRegistration(leaking);
  assert.ok(err);
  assert.match(err!, /must not reference service scope env/);
});

test("fixture quant tool excluded from scheduled-read and evaluation sessions", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register(buildFixtureQuantRegistration());

  // scheduled-read: fixture quant 只声明 interactive,不应出现
  const { servers: scheduled } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: { ...HEALTHY_ENV, ...QST_HEALTHY_ENV },
    taskType: "scheduled-daily",
    sessionId: "s1",
    registry,
  });
  assert.ok(!scheduled.map((s) => s.name).includes("fixture-quant-tool"));

  // evaluation: 同样不应出现
  const { servers: evald } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "user-a" },
    env: { ...HEALTHY_ENV, ...QST_HEALTHY_ENV, ACP_EVAL_MCP_ALLOWED_TOOLS: "x" },
    taskType: "evaluation",
    sessionId: "e1",
    registry,
  });
  assert.ok(!evald.map((s) => s.name).includes("fixture-quant-tool"));
});

// ─── 通用校验: 模板/字面量/无效 token ───────────────────────────────

test("invalid <env:NAME> token in command is reported as invalid_template", () => {
  const reg: McpServerRegistration = {
    id: "bad-token",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:not a valid name>",
      args: [],
      requiredEnvRefs: [],
    },
    sessionKinds: ["interactive"],
  };
  // 校验阶段就该拒绝无效 token 名
  assert.match(validateRegistration(reg)!, /invalid.*token|invalid.*env/i);
});

test("unresolved env token (missing required ref) makes server unavailable", () => {
  const reg: McpServerRegistration = {
    id: "unresolved-token",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:SOME_BIN>",
      args: [],
      requiredEnvRefs: ["SOME_BIN"],
    },
    sessionKinds: ["interactive"],
  };
  // 缺 SOME_BIN → readiness 报 missing_required_env
  const r = checkExternalStdioReadiness(reg, {}) as Extract<ExternalStdioReadiness, { ok: false }>;
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing_required_env");
  assert.deepEqual(r.missingRefs, ["SOME_BIN"]);
  // resolve 也返回 null (server unavailable)
  assert.equal(resolveExternalServer(reg, {}), null);
});

test("every referenced template variable must appear in requiredEnvRefs", () => {
  // command 引用 <env:FORGOTTEN>,但 requiredEnvRefs 没声明 → 校验失败
  const reg: McpServerRegistration = {
    id: "forgotten-ref",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:FORGOTTEN_BIN>",
      args: [],
      requiredEnvRefs: [],
    },
    sessionKinds: ["interactive"],
  };
  assert.match(validateRegistration(reg)!, /requiredEnvRefs|missing.*reference/i);
});

test("generic stdio registration remains usable without optional credentials", () => {
  const mdt: McpServerRegistration = {
    id: "minimal-stdio",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "stdio",
      command: "<env:MDT_UV_BIN>",
      args: ["--project", "<env:MDT_PROJECT_DIR>"],
      requiredEnvRefs: ["MDT_UV_BIN", "MDT_PROJECT_DIR"],
      envRefs: ["MDT_UV_BIN", "MDT_PROJECT_DIR", "MDT_SEARCH_API_KEY"],
    },
    sessionKinds: ["interactive"],
  };
  const minimalEnv = {
    MDT_UV_BIN: "/uv",
    MDT_PROJECT_DIR: "/p",
  };
  assert.deepEqual(checkExternalStdioReadiness(mdt, minimalEnv), { ok: true });
  const resolved = resolveExternalServer(mdt, minimalEnv);
  assert.ok(resolved);
  // 可选凭据缺失时不注入
  assert.ok(!resolved.env.map((e) => e.name).includes("MDT_SEARCH_API_KEY"));
});

// ─── HTTP 外部注册项保持 fail closed ─────────────────────────────────

test("HTTP external registration remains fail closed without ACP capability", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register({
    id: "external-http",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "http", url: "http://localhost:9999/mcp" },
    sessionKinds: ["interactive"],
  });
  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: { INVEST_AGENT_PROJECT_ROOT: "/tmp/proj", DB_PATH: "a.db" },
    taskType: "interactive",
    sessionId: "x",
    registry,
  });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "invest-agent-service-tools");
});

test("HTTP external registration assembles when ACP advertises HTTP capability", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register({
    id: "external-http",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: {
      kind: "http",
      url: "<env:EXTERNAL_MCP_URL>",
      headers: [{ name: "Authorization", envRef: "EXTERNAL_MCP_TOKEN", prefix: "Bearer " }],
      requiredEnvRefs: ["EXTERNAL_MCP_URL", "EXTERNAL_MCP_TOKEN"],
    },
    sessionKinds: ["interactive"],
  });
  const { servers, manifest } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: {
      INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
      DB_PATH: "a.db",
      EXTERNAL_MCP_URL: "http://localhost:9999/mcp",
      EXTERNAL_MCP_TOKEN: "do-not-log",
    },
    taskType: "interactive",
    sessionId: "x",
    registry,
    mcpCapabilities: { http: true },
  });
  const external = servers.find((server) => server.name === "external-http");
  assert.ok(external);
  assert.equal(external.type, "http");
  assert.equal(JSON.stringify(manifest).includes("do-not-log"), false);
});
