import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildInvestAgentMcpServers } from "../src/acp/stdio-agent.js";

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
      INVEST_AGENT_SANDBOX_SECRET: secret,
      INVEST_AGENT_SANDBOX_SECRET_FILE: "runtime/.sandbox-secret",
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
    INVEST_AGENT_SANDBOX_SECRET: secret,
    INVEST_AGENT_SANDBOX_SECRET_FILE: path.join(projectRoot, "runtime", ".sandbox-secret"),
  });
  assert.equal(JSON.stringify({ userId: "user-a", instanceId: "invest-agent-user-a" }).includes(secret), false);
});

test("non-Codex ACP backends do not receive the service MCP server", () => {
  assert.deepEqual(buildInvestAgentMcpServers("hermes", "/tmp/workspace"), []);
});
