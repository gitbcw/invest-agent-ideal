#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-mcp-smoke-"));
const reviewUserId = "mcp-smoke-user";
const reviewDate = "2026-07-16";
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(tempRoot, "projects");
process.env.REVIEWS_ROOT = path.join(tempRoot, "reviews");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "mcp-smoke-service-token-at-least-32-characters";

let sqlite;
try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  dbModule.initDb();
  const { callServiceTool, serviceToolContextFromEnv } = await import("../dist/mcp/service-tools-core.js");
  const { mastraWorkspaceRegistry } = await import("../dist/mastra/workspace-registry.js");
  const { dailyPlanBackend } = await import("../dist/lib/daily-plan-backend.js");
  const context = serviceToolContextFromEnv({
    ...process.env,
    INVEST_AGENT_MCP_USER_ID: reviewUserId,
    INVEST_AGENT_MCP_INSTANCE_ID: "invest-agent-mcp-smoke-user",
    INVEST_AGENT_MCP_CONVERSATION_ID: "mcp-smoke-conversation",
  });

  await mastraWorkspaceRegistry.bootstrap({
    userId: context.userId,
    projectId: context.projectId,
    instanceId: context.instanceId,
  });
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

  await assert.rejects(
    callServiceTool("reviews.save", { date: reviewDate, content: "manual without confirmation" }, context),
    /confirmedByUser=true/
  );
  const scheduledContext = {
    ...context,
    conversationId: `scheduler:daily-review:${context.userId}:${context.instanceId}`,
    expectedReviewKind: "daily",
    expectedReviewKey: reviewDate,
  };
  const fullReport = "# 日复盘\n\n这是 Agent 自主生成的完整报告。";
  const pushBrief = "今日复盘已完成：暂无需要立即确认的操作。";
  const published = await callServiceTool("reviews.save", {
    date: reviewDate,
    content: fullReport,
    pushBrief,
    decisionRecords: [{ id: "mcp-smoke-decision", decision_type: "no_action", view: "继续观察" }],
    sourceEvents: [{ id: "mcp-smoke-source", event: "missing", reason: "smoke fixture" }],
  }, scheduledContext);
  assert.equal(published.pushBrief, pushBrief);
  assert.equal(published.decisionRecordCount, 1);
  assert.equal(published.sourceEventCount, 1);
  const savedReview = await dailyPlanBackend.get(context.userId, context.instanceId, reviewDate);
  assert.equal(savedReview?.content, fullReport);
  assert.equal(savedReview?.summary, pushBrief);
  const memoryRows = sqlite.prepare(`
    SELECT payload_json AS payloadJson
    FROM mastra_review_memory_records
    WHERE user_id = ? AND instance_id = ?
  `).all(context.userId, context.instanceId);
  const memoryRecords = memoryRows.map((row) => JSON.parse(row.payloadJson));
  assert.equal(memoryRecords.some((item) => item.id === "mcp-smoke-decision"), true);
  assert.equal(memoryRecords.some((item) => item.id === "mcp-smoke-source"), true);

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
    const baseRequiredTools = [
      "confirmations.pending",
      "confirmations.request",
      "conversation.history",
      "research.news_search",
      "research.web_search",
      "research.web_read",
      "onboarding.confirm_portfolio",
      "onboarding.confirm_step",
      "onboarding.draft.get",
      "onboarding.draft.upsert_step",
      "onboarding.draft.request_confirmation",
      "onboarding.draft.accept_step",
      "onboarding.draft.enqueue_commit",
      "onboarding.draft.commit_status",
      "portfolio.apply_changes",
      "plans.set",
      "reviews.save",
      "watch_rules.create",
      "watchlist.add",
    ];
    const retiredMarketTools = toolNames.filter((name) => name.startsWith("market."));
    assert.deepEqual(baseRequiredTools.filter((name) => !toolNames.includes(name)), []);
    assert.deepEqual(retiredMarketTools, []);
    const portfolio = await client.callTool({ name: "portfolio.read", arguments: {} });
    assert.notEqual(portfolio.isError, true);
    const portfolioText = portfolio.content?.find((item) => item.type === "text")?.text;
    const portfolioResult = JSON.parse(portfolioText || "null");
    assert.equal(portfolioResult?.ok, true);
    assert.equal(portfolioResult?.userId, context.userId);
    assert.equal(portfolioResult?.instanceId, context.instanceId);
    assert.equal(typeof portfolioResult?.count, "number");
    // reviews.save reaches shared code that logs a successful publication.
    // Keeping this successful write on the stdio route proves those logs stay
    // on stderr and never corrupt stdout JSON-RPC framing.
    const savedViaStdio = await client.callTool({
      name: "reviews.save",
      arguments: {
        date: "2026-07-17",
        content: "# MCP stdio 日复盘\n\n验证成功保存时的日志不会污染协议输出。",
        pushBrief: "MCP stdio 日复盘保存验证完成。",
        confirmedByUser: true,
      },
    });
    assert.notEqual(savedViaStdio.isError, true);
    console.log(`[mcp-service-tools-smoke] ok tools=${toolNames.length}`);
  } finally {
    await client.close();
  }

  const restrictedClient = new Client({ name: "invest-agent-mcp-restricted-smoke", version: "1.0.0" });
  const restrictedTransport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/invest-agent-service-tools.js"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      INVEST_AGENT_MCP_USER_ID: context.userId,
      INVEST_AGENT_MCP_INSTANCE_ID: context.instanceId,
      INVEST_AGENT_MCP_CONVERSATION_ID: `scheduler:daily-review:publication-probe:${context.userId}:${context.instanceId}`,
      INVEST_AGENT_MCP_ALLOWED_TOOLS: "reviews.save",
      INVEST_AGENT_PROJECT_ROOT: process.cwd(),
    },
  });
  try {
    await restrictedClient.connect(restrictedTransport);
    const restrictedTools = await restrictedClient.listTools();
    assert.deepEqual(restrictedTools.tools.map((tool) => tool.name), ["reviews.save"]);
  } finally {
    await restrictedClient.close();
  }
} finally {
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
