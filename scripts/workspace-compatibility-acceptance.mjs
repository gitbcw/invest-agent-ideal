#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const userId = process.argv[2]?.trim();
const instanceId = process.argv[3]?.trim();
if (!userId || !instanceId) {
  throw new Error("usage: workspace-compatibility-acceptance <userId> <instanceId>");
}

requireFlag("WORKSPACE_COMPATIBILITY_EVAL", "true");
requireFlag("WEIXIN_AUTO_START", "false");
requireFlag("PORTAL_CONNECTOR_AUTO_START", "false");
requireFlag("SCHEDULER_ENABLED", "false");
const workspaceRoot = requireIsolatedPath("WORKSPACE_ROOT");
requireIsolatedPath("DB_PATH");
requireIsolatedPath("RUNTIME_DATA_ROOT");
requireIsolatedPath("REVIEWS_ROOT");
requireIsolatedPath("INVEST_AGENT_WEIXIN_STATE_DIR");
const workspacePath = path.join(workspaceRoot, userId);
if (!existsSync(path.join(workspacePath, "AGENTS.md"))) {
  throw new Error(`isolated workspace is missing for ${userId}`);
}

const [dbModule, schemaModule, drizzleModule, workspaceModule, storeModule, toolsModule, acpModule] = await Promise.all([
  import("../dist/db/index.js"),
  import("../dist/db/schema.js"),
  import("drizzle-orm"),
  import("../dist/lib/workspace.js"),
  import("../dist/lib/workspace-store.js"),
  import("../dist/mcp/service-tools-core.js"),
  import("../dist/acp/stdio-agent.js"),
]);

const { db, initDb, sqlite } = dbModule;
const { marketWatchSnapshots } = schemaModule;
const { and, eq } = drizzleModule;
const { ensureWorkspace } = workspaceModule;
const { WorkspaceStore } = storeModule;
const { callServiceTool } = toolsModule;
const { disposeAllAcp, getCurrentAcpAgent } = acpModule;

initDb();
const conversationId = `compatibility-eval:${userId}:${instanceId}`;
const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath };
const windowKey = "compatibility-eval-window";
const now = new Date().toISOString();

try {
  await ensureWorkspace({ userId, tenantId: userId, projectId: instanceId });
  const expectedHoldings = await new WorkspaceStore(userId).listActiveHoldings();
  const portfolio = await callServiceTool("portfolio.read", {}, context);
  if (!portfolio || typeof portfolio !== "object" || portfolio.count !== expectedHoldings.length) {
    throw new Error("portfolio.read did not match the isolated Workspace");
  }

  await db.delete(marketWatchSnapshots).where(and(
    eq(marketWatchSnapshots.userId, userId),
    eq(marketWatchSnapshots.instanceId, instanceId),
  ));
  await db.insert(marketWatchSnapshots).values({
    id: randomUUID(),
    userId,
    projectId: "invest-agent",
    instanceId,
    tradingDate: now.slice(0, 10),
    windowKey,
    capturedAt: now,
    snapshotJson: JSON.stringify({
      updatedAt: now,
      holdings: [],
      watchlist: [],
      plans: [],
      indices: [],
      warnings: ["isolated compatibility fixture"],
    }),
    deltaJson: JSON.stringify({
      previousWindowKey: null,
      materiallyChanged: false,
      stockChanges: [],
      indexChanges: [],
      warningsChanged: false,
      summary: "isolated compatibility fixture",
    }),
    createdAt: now,
  });

  const snapshot = await callServiceTool("market_watch.snapshot", {}, context);
  if (!snapshot || typeof snapshot !== "object" || snapshot.result?.windowKey !== windowKey) {
    throw new Error("market_watch.snapshot did not return the isolated scoped fixture");
  }

  const userContext = {
    ...context,
    channel: "api",
    backend: "codex",
    mcpAllowedTools: ["portfolio.read", "market_watch.snapshot"],
  };
  const startedAt = Date.now();
  const result = await (await getCurrentAcpAgent(workspacePath, { modelTier: "complex" })).chatWithUsage({
    conversationId,
    messageId: randomUUID(),
    cwd: workspacePath,
    timeoutMs: 300_000,
    userContext,
    text: [
      "请做一次当前持仓数量与本轮盘中快照的核对。这是隔离 Workspace 内的授权单点验收，不会发送给真实用户。",
      "必须调用 portfolio.read 和 market_watch.snapshot；不要读取 Workspace 文件来代替工具调用。",
      "核对后只输出一行 JSON，不要照抄占位说明：compatibility 固定为 ok，holdings 使用 portfolio.read 的实际 count 数字，window 使用 market_watch.snapshot 的实际 windowKey。",
      "JSON 字段必须严格为 compatibility、holdings、window。",
      "持仓数量和隔离窗口标识是本次唯一允许输出的数据；不要输出持仓名称、代码、金额、策略或其他用户数据。",
    ].join("\n"),
  });
  const jsonMatch = /\{[^{}]*"compatibility"\s*:\s*"ok"[^{}]*\}/s.exec(result.text);
  let parsed = null;
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch {
    parsed = null;
  }
  const returnedHoldings = typeof parsed?.holdings === "number"
    ? parsed.holdings
    : parsed?.holdings?.count;
  const returnedWindow = typeof parsed?.window === "string"
    ? parsed.window
    : parsed?.window?.windowKey;
  if (!parsed || returnedHoldings !== expectedHoldings.length || returnedWindow !== windowKey) {
    throw new Error("ACP compatibility reply did not match the scoped service facts");
  }

  console.log(JSON.stringify({
    ok: true,
    userId,
    instanceId,
    holdingsCount: expectedHoldings.length,
    windowKey,
    elapsedMs: Date.now() - startedAt,
  }));
} finally {
  disposeAllAcp();
  sqlite.close();
  await rm(path.join(workspacePath, ".codex", "auth.json"), { force: true });
}

function requireFlag(name, expected) {
  if (process.env[name] !== expected) {
    throw new Error(`${name} must equal ${expected}`);
  }
}

function requireIsolatedPath(name) {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value) || !value.split(path.sep).includes("compatibility-evals")) {
    throw new Error(`${name} must be an absolute compatibility-evals path`);
  }
  return path.resolve(value);
}
