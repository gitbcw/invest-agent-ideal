import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";
import { buildInvestAgentMcpServers, stripCodexMcpConfigForEvaluation } from "../src/acp/stdio-agent.js";

test("evaluation config preserves model routing but strips inherited MCP servers", () => {
  const filtered = stripCodexMcpConfigForEvaluation(`model = "gpt-5.6-sol"
[model_providers.codex-ai]
base_url = "http://provider.example.test/v1"
[mcp_servers.browser]
command = "browser-mcp"
[mcp_servers.browser.env]
TOKEN = "secret"
[features]
js_repl = false
`);

  assert.match(filtered, /model = "gpt-5\.6-sol"/);
  assert.match(filtered, /\[model_providers\.codex-ai\]/);
  assert.match(filtered, /\[features\]/);
  assert.doesNotMatch(filtered, /mcp_servers|browser-mcp|TOKEN/);
});

test("Codex MCP child receives the scoped service runtime locations", () => {
  const projectRoot = path.resolve("/tmp/invest-agent-mcp-env-test");
  const secret = "test-secret-that-must-not-be-rendered";
  const servers = buildInvestAgentMcpServers(
    "codex",
    path.join(projectRoot, "workspaces", "fallback"),
    {
      userId: "user-a",
      instanceId: "invest-agent-user-a",
      projectId: "invest-agent",
      conversationId: "conversation-a",
      workspacePath: path.join(projectRoot, "workspaces", "user-a"),
      channel: "api",
      backend: "codex",
      mcpAllowedTools: ["portfolio.read", "market_watch.snapshot"],
    },
    {
      INVEST_AGENT_PROJECT_ROOT: projectRoot,
      DB_PATH: "runtime/user-a.db",
      WORKSPACE_ROOT: "workspaces",
      WORKSPACE_TEMPLATE_PATH: "template",
      WORKSPACE_BACKEND: "workspace",
      RUNTIME_DATA_ROOT: "runtime/user-a",
      REVIEWS_ROOT: "reviews/user-a",
      INVEST_AGENT_SERVICE_MARKET_TOOLS_ENABLED: "false",
      INVEST_AGENT_SANDBOX_SECRET: secret,
      INVEST_AGENT_SANDBOX_SECRET_FILE: "runtime/.sandbox-secret",
      TUSHARE_TOKEN: "tushare-test-token",
      TDX_MCP_API_KEY: "tdx-test-key",
      TDX_MCP_URL: "https://mcp.example.test/mcp",
      TDX_MCP_FUNDAMENTALS_TOOL: "tdx_test_fundamentals",
    },
  );

  assert.equal(servers.length, 1);
  const values = Object.fromEntries(servers[0].env.map(({ name, value }) => [name, value]));
  assert.deepEqual(values, {
    INVEST_AGENT_MCP_USER_ID: "user-a",
    INVEST_AGENT_MCP_INSTANCE_ID: "invest-agent-user-a",
    INVEST_AGENT_MCP_WORKSPACE_PATH: path.join(projectRoot, "workspaces", "user-a"),
    INVEST_AGENT_MCP_CONVERSATION_ID: "conversation-a",
    INVEST_AGENT_MCP_ALLOWED_TOOLS: "portfolio.read,market_watch.snapshot",
    INVEST_AGENT_PROJECT_ROOT: projectRoot,
    DB_PATH: path.join(projectRoot, "runtime", "user-a.db"),
    WORKSPACE_ROOT: path.join(projectRoot, "workspaces"),
    WORKSPACE_TEMPLATE_PATH: path.join(projectRoot, "template"),
    WORKSPACE_BACKEND: "workspace",
    RUNTIME_DATA_ROOT: path.join(projectRoot, "runtime", "user-a"),
    REVIEWS_ROOT: path.join(projectRoot, "reviews", "user-a"),
    INVEST_AGENT_SERVICE_MARKET_TOOLS_ENABLED: "false",
    INVEST_AGENT_SANDBOX_SECRET: secret,
    INVEST_AGENT_SANDBOX_SECRET_FILE: path.join(projectRoot, "runtime", ".sandbox-secret"),
    TUSHARE_TOKEN: "tushare-test-token",
    TDX_MCP_API_KEY: "tdx-test-key",
    TDX_MCP_URL: "https://mcp.example.test/mcp",
    TDX_MCP_FUNDAMENTALS_TOOL: "tdx_test_fundamentals",
  });
  assert.equal(JSON.stringify({ userId: "user-a", instanceId: "invest-agent-user-a" }).includes(secret), false);
});

test("non-Codex ACP backends do not receive the service MCP server", () => {
  assert.deepEqual(buildInvestAgentMcpServers("hermes", "/tmp/workspace"), []);
});

test("explicit ACP network-only evaluation mode receives no service MCP server", () => {
  assert.deepEqual(buildInvestAgentMcpServers("codex", "/tmp/workspace", undefined, {
    ...process.env,
    ACP_EVAL_DISABLE_ALL_MCP: "true",
  }), []);
});

test("evaluation mode can expose only general web evidence tools", () => {
  const [server] = buildInvestAgentMcpServers("codex", "/tmp/workspace", undefined, {
    ...process.env,
    ACP_EVAL_MCP_ALLOWED_TOOLS: "research.web_search,research.web_read",
  });
  assert.equal(server?.env?.find((entry) => entry.name === "INVEST_AGENT_MCP_ALLOWED_TOOLS")?.value, "research.web_search,research.web_read");
});

test("service MCP can hide legacy market facade tools while keeping scheduler snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-service-mcp-tools-"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    INVEST_AGENT_PROJECT_ROOT: process.cwd(),
    DB_PATH: path.join(tempRoot, "runtime", "service-tools.db"),
    WORKSPACE_ROOT: path.join(tempRoot, "workspaces"),
    WORKSPACE_TEMPLATE_PATH: path.join(process.cwd(), "templates", "workspace"),
    WORKSPACE_BACKEND: "workspace",
    RUNTIME_DATA_ROOT: path.join(tempRoot, "runtime"),
    REVIEWS_ROOT: path.join(tempRoot, "reviews"),
    INVEST_AGENT_MCP_USER_ID: "service-market-flag-user",
    INVEST_AGENT_MCP_INSTANCE_ID: "invest-agent-service-market-flag-user",
    INVEST_AGENT_MCP_WORKSPACE_PATH: path.join(tempRoot, "workspaces", "service-market-flag-user"),
    INVEST_AGENT_MCP_CONVERSATION_ID: "service-market-flag-test",
    INVEST_AGENT_SERVICE_MARKET_TOOLS_ENABLED: "false",
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/invest-agent-service-tools.ts"],
    env,
  });
  const client = new Client({ name: "service-market-flag-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name);

    assert.equal(names.some((name) => name.startsWith("market.")), false);
    assert.ok(names.includes("market_watch.snapshot"));
    assert.ok(names.includes("research.web_search"));
  } finally {
    await client.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
