#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-mcp-smoke-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "mcp-smoke-service-token-at-least-32-characters";

let sqlite;
try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  dbModule.initDb();
  const { callServiceTool, serviceToolContextFromEnv } = await import("../dist/mcp/service-tools-core.js");
  const { ensureWorkspace } = await import("../dist/lib/workspace.js");
  const context = serviceToolContextFromEnv({
    ...process.env,
    INVEST_AGENT_MCP_USER_ID: "mcp-smoke-user",
    INVEST_AGENT_MCP_INSTANCE_ID: "invest-agent-mcp-smoke-user",
    INVEST_AGENT_MCP_CONVERSATION_ID: "mcp-smoke-conversation",
  });

  await ensureWorkspace({ userId: context.userId, projectId: "invest-agent" });
  for (const [name, input] of [
    ["portfolio.read", {}],
    ["watchlist.read", {}],
    ["plans.read", {}],
    ["conversation.history", {}],
    ["confirmations.pending", {}],
    ["watch_rules.catalog", {}],
    ["watch_rules.list", {}],
    ["watch_rules.validate", { stockCode: "601058", stockName: "赛轮轮胎", ruleType: "price_cross", targetScope: "holding", params: { operator: ">=", value: 13 } }],
  ]) {
    const result = await callServiceTool(name, input, context);
    assert.equal(typeof result, "object", `${name} must return structured data`);
  }

  const client = new Client({ name: "invest-agent-mcp-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/invest-agent-service-tools.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      INVEST_AGENT_MCP_USER_ID: context.userId,
      INVEST_AGENT_MCP_INSTANCE_ID: context.instanceId,
      INVEST_AGENT_MCP_CONVERSATION_ID: context.conversationId,
      INVEST_AGENT_PROJECT_ROOT: process.cwd(),
    },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((tool) => tool.name).sort();
    const requiredTools = [
      "confirmations.pending",
      "confirmations.request",
      "conversation.history",
      "onboarding.confirm_portfolio",
      "onboarding.confirm_step",
      "plans.set",
      "reviews.save",
      "watch_rules.create",
      "watchlist.add",
    ];
    assert.deepEqual(requiredTools.filter((name) => !toolNames.includes(name)), []);
    const portfolio = await client.callTool({ name: "portfolio.read", arguments: {} });
    assert.notEqual(portfolio.isError, true);
    console.log(`[mcp-service-tools-smoke] ok tools=${toolNames.length}`);
  } finally {
    await client.close();
  }
} finally {
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
