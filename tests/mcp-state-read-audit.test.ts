import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

test("state read MCP tools leave lightweight audit evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-state-read-audit-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.WORKSPACE_BACKEND = "workspace";

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { sandboxAuditLogs } = await import("../src/db/schema.js");
    const { ensureWorkspace } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    initDb();
    const userId = "state-read-audit-user";
    const instanceId = "invest-agent-state-read-audit-user";
    const conversationId = "state-read-audit-conversation";
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    await new WorkspaceStore(userId).writePortfolio({
      last_confirmed_at: "2026-07-31T00:00:00.000Z",
      holdings: [{ code: "600519", name: "贵州茅台", status: "open" }],
      watchlist: [{ code: "601058", name: "赛轮轮胎", source: "test" }],
      stock_plans: [{ code: "002460", name: "赣锋锂业", support: 40, resistance: 50 }],
    });

    const context = { userId, instanceId, conversationId };
    assert.equal((await callServiceTool("portfolio.read", {}, context) as { count: number }).count, 1);
    assert.equal((await callServiceTool("watchlist.read", {}, context) as { count: number }).count, 1);
    assert.equal((await callServiceTool("plans.read", {}, context) as { count: number }).count, 1);

    const audits = await db
      .select()
      .from(sandboxAuditLogs)
      .where(and(
        eq(sandboxAuditLogs.userId, userId),
        eq(sandboxAuditLogs.instanceId, instanceId),
        eq(sandboxAuditLogs.conversationId, conversationId),
        inArray(sandboxAuditLogs.operation, ["portfolio.read", "watchlist.read", "plans.read"]),
      ));
    const summaries = Object.fromEntries(audits.map((row) => [row.operation, row.resultSummary]));

    assert.equal(summaries["portfolio.read"], "holdings=1; revision=2026-07-31T00:00:00.000Z");
    assert.equal(summaries["watchlist.read"], "watchlist=1");
    assert.equal(summaries["plans.read"], "plans=1");
    sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
