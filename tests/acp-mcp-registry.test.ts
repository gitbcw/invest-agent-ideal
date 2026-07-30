import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBuiltinServiceToolsRegistration,
  createMcpRegistry,
  validateRegistration,
  isForbiddenExternalRef,
  type McpServerRegistration,
} from "../src/acp/mcp-registry.js";
import { resolveSessionMcpServers } from "../src/acp/mcp-session-manifest.js";

// ─── 注册模型校验 ──────────────────────────────────────────────────

test("builtin service-tools registration is valid and service-scoped", () => {
  const reg = buildBuiltinServiceToolsRegistration();
  assert.equal(validateRegistration(reg), null);
  assert.equal(reg.trustClass, "service-scoped");
  assert.equal(reg.owner, "invest-agent");
  assert.equal(reg.transport.kind, "stdio");
  assert.deepEqual(reg.sessionKinds, ["interactive", "scheduled-read", "evaluation"]);
});

test("service-scoped registration must be owned by invest-agent", () => {
  const bad: McpServerRegistration = {
    id: "rogue",
    owner: "external",
    enabled: true,
    trustClass: "service-scoped",
    transport: { kind: "stdio", command: "x", args: [] },
    sessionKinds: ["interactive"],
  };
  assert.match(validateRegistration(bad)!, /service-scoped server must be owned by invest-agent/);
});

test("external-readonly registration must not reference service scope env", () => {
  const leaking: McpServerRegistration = {
    id: "leaky-external",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "stdio", command: "mcp", args: [], envRefs: ["DB_PATH", "TUSHARE_TOKEN"] },
    sessionKinds: ["interactive"],
  };
  const err = validateRegistration(leaking);
  assert.ok(err);
  assert.match(err!, /must not reference service scope env/);
  assert.match(err!, /DB_PATH/);
});

test("valid external-readonly registration passes", () => {
  const ok: McpServerRegistration = {
    id: "market-data-tool",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "http", url: "http://localhost:8080/mcp", headerRefs: ["MARKET_DATA_API_KEY"] },
    sessionKinds: ["interactive", "scheduled-read"],
  };
  assert.equal(validateRegistration(ok), null);
  // MARKET_DATA_API_KEY 不是 forbidden ref
  assert.equal(isForbiddenExternalRef("MARKET_DATA_API_KEY"), false);
  assert.equal(isForbiddenExternalRef("DB_PATH"), true);
});

test("duplicate server id is rejected (fail closed)", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const dup: McpServerRegistration = {
    id: "invest-agent-service-tools",
    owner: "invest-agent",
    enabled: true,
    trustClass: "service-scoped",
    transport: { kind: "stdio", command: "x", args: [] },
    sessionKinds: ["interactive"],
  };
  assert.throws(() => registry.register(dup), /duplicate server id/);
});

test("enabled flag controls whether a registration is assembled", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  assert.equal(registry.listEnabledRegistrations().length, 1);
  registry.setEnabled("invest-agent-service-tools", false);
  assert.equal(registry.listEnabledRegistrations().length, 0);
  registry.setEnabled("invest-agent-service-tools", true);
  assert.equal(registry.listEnabledRegistrations().length, 1);
});

// ─── sessionKind 过滤 ──────────────────────────────────────────────

test("sessionKind filtering excludes servers not declared for the session kind", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  // builtin 支持 all three
  assert.equal(registry.listEnabledRegistrations("interactive").length, 1);
  assert.equal(registry.listEnabledRegistrations("scheduled-read").length, 1);
  assert.equal(registry.listEnabledRegistrations("evaluation").length, 1);

  // 注册一个只限 interactive 的外部 server
  registry.register({
    id: "interactive-only",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "http", url: "http://x/mcp" },
    sessionKinds: ["interactive"],
  });
  assert.equal(registry.listEnabledRegistrations("interactive").length, 2);
  assert.equal(registry.listEnabledRegistrations("scheduled-read").length, 1);
});

// ─── manifest 解析与脱敏 ───────────────────────────────────────────

test("resolveSessionMcpServers produces service-scoped stdio server with full env", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const { manifest, servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: {
      userId: "user-a",
      instanceId: "invest-agent-user-a",
      conversationId: "conversation-a",
      workspacePath: "/tmp/ws/user-a",
      mcpAllowedTools: ["portfolio.read"],
    },
    env: {
      INVEST_AGENT_PROJECT_ROOT: "/tmp/proj",
      DB_PATH: "runtime/a.db",
      WORKSPACE_ROOT: "workspaces",
      WORKSPACE_TEMPLATE_PATH: "template",
      RUNTIME_DATA_ROOT: "runtime/a",
      REVIEWS_ROOT: "reviews/a",
      TUSHARE_TOKEN: "secret-must-not-leak",
    },
    taskType: "interactive",
    sessionId: "conversation-a",
    registry,
  });

  // 装配了唯一 service-scoped server
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "invest-agent-service-tools");
  assert.equal(servers[0].command, process.execPath);
  assert.ok(servers[0].args[0].endsWith("dist/mcp/invest-agent-service-tools.js"));

  // service scope env 完整
  const envMap = Object.fromEntries(servers[0].env.map((e) => [e.name, e.value]));
  assert.equal(envMap.INVEST_AGENT_MCP_USER_ID, "user-a");
  assert.equal(envMap.TUSHARE_TOKEN, "secret-must-not-leak");
  assert.equal(envMap.INVEST_AGENT_MCP_ALLOWED_TOOLS, "portfolio.read");

  // manifest 脱敏:不含 secret,但含配置指纹
  assert.equal(manifest.servers.length, 1);
  assert.equal(manifest.servers[0].id, "invest-agent-service-tools");
  assert.equal(manifest.servers[0].transportKind, "stdio");
  assert.ok(manifest.servers[0].configFingerprint.length === 12);
  const manifestJson = JSON.stringify(manifest);
  assert.equal(manifestJson.includes("secret-must-not-leak"), false);
  assert.equal(manifestJson.includes("TUSHARE_TOKEN"), false);
});

test("configFingerprint is stable for identical identity, differs across users", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const base = {
    backendId: "codex" as const,
    cwd: "/tmp/ws",
    env: { INVEST_AGENT_PROJECT_ROOT: "/tmp/proj", DB_PATH: "a.db", WORKSPACE_ROOT: "w" },
    registry,
  };
  const a1 = resolveSessionMcpServers({
    ...base,
    userContext: { userId: "user-a", conversationId: "c1" },
    taskType: "interactive",
    sessionId: "c1",
  });
  const a2 = resolveSessionMcpServers({
    ...base,
    userContext: { userId: "user-a", conversationId: "c2" },
    taskType: "interactive",
    sessionId: "c2",
  });
  // 同一用户不同会话:指纹一致 (基于 scope 身份,不含 sessionId)
  assert.equal(a1.manifest.servers[0].configFingerprint, a2.manifest.servers[0].configFingerprint);

  const b = resolveSessionMcpServers({
    ...base,
    userContext: { userId: "user-b", conversationId: "c3" },
    taskType: "interactive",
    sessionId: "c3",
  });
  // 不同用户:指纹不同
  assert.notEqual(a1.manifest.servers[0].configFingerprint, b.manifest.servers[0].configFingerprint);
});

// ─── fail closed ──────────────────────────────────────────────────

test("non-codex backend assembles no servers", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const { servers } = resolveSessionMcpServers({
    backendId: "hermes",
    cwd: "/tmp/ws",
    env: {},
    taskType: "interactive",
    sessionId: "x",
    registry,
  });
  assert.deepEqual(servers, []);
});

test("ACP_EVAL_DISABLE_ALL_MCP produces empty servers", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: { ACP_EVAL_DISABLE_ALL_MCP: "true" },
    taskType: "evaluation",
    sessionId: "x",
    registry,
  });
  assert.deepEqual(servers, []);
});

test("http transport is typed-ready but skipped while ACP capability is unprobed", () => {
  const registry = createMcpRegistry([buildBuiltinServiceToolsRegistration()]);
  registry.register({
    id: "external-http",
    owner: "external",
    enabled: true,
    trustClass: "external-readonly",
    transport: { kind: "http", url: "http://localhost:9999/mcp" },
    sessionKinds: ["interactive"],
  });
  const { servers, manifest } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    env: { INVEST_AGENT_PROJECT_ROOT: "/tmp/proj", DB_PATH: "a.db" },
    taskType: "interactive",
    sessionId: "x",
    registry,
  });
  // http server 被跳过 (fail closed),只剩 service-scoped stdio server
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "invest-agent-service-tools");
  assert.equal(manifest.servers.length, 1);
  assert.equal(manifest.servers[0].id, "invest-agent-service-tools");
});
