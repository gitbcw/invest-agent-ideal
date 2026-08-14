import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("onboarding confirm writes land in service-owned mastra projections", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-onboarding-confirm-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    initDb();

    const userId = "mastra-onboarding-confirm";
    const instanceId = "invest-agent-mastra-onboarding-confirm";
    const conversationId = "mastra-onboarding-confirm-conversation";
    const projectId = "invest-agent";
    const context = { userId, instanceId, projectId, conversationId };

    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId,
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      title: "Mastra onboarding confirm writes",
      createdAt: now,
      updatedAt: now,
    });

    async function addUserMessage(content: string, offsetMs: number) {
      await db.insert(conversationMessages).values({
        messageId: `${userId}-${offsetMs}`,
        conversationId,
        userId,
        projectId,
        instanceId,
        assistantId: instanceId,
        channel: "weixin-mobile",
        role: "user",
        content,
        createdAt: new Date(Date.now() + offsetMs).toISOString(),
      });
    }

    const readProjection = (table: string, column: string): Record<string, any> | undefined => {
      const row = sqlite.prepare(`SELECT ${column} AS value FROM ${table} WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1`)
        .get(userId, projectId, instanceId) as { value?: string } | undefined;
      return row ? JSON.parse(row.value!) : undefined;
    };

    // Flow A: brand-new user (no mastra projection rows) confirms portfolio.
    const portfolioPayload = {
      holdings: [{ name: "贵州茅台", code: "600519" }],
      watchlist: [{ name: "宁德时代", code: "300750" }],
    };
    const portfolioRequest = await callServiceTool("confirmations.request", {
      operation: "onboarding.confirm_portfolio",
      payload: portfolioPayload,
      summary: "请确认初始持仓和观察仓",
    }, context) as { ok: boolean; confirmationId: string };
    assert.equal(portfolioRequest.ok, true);
    await addUserMessage("确认", 1_000);

    const savedPortfolio = await callServiceTool("onboarding.confirm_portfolio", {
      confirmedByUser: true,
      confirmationId: portfolioRequest.confirmationId,
      ...portfolioPayload,
    }, context) as { ok: boolean; state: { current_step: string; steps: Record<string, { done: boolean }> } };
    assert.equal(savedPortfolio.ok, true);
    assert.equal(savedPortfolio.state.current_step, "style");
    assert.equal(savedPortfolio.state.steps.portfolio.done, true);

    const storedPortfolio = readProjection("mastra_portfolio_states", "portfolio_json");
    assert.ok(storedPortfolio, "portfolio projection row must be created for a new user");
    assert.ok(storedPortfolio!.holdings.some((item: any) => item.code === "600519"));
    assert.ok(storedPortfolio!.watchlist.some((item: any) => item.code === "300750"));
    assert.equal(storedPortfolio!.last_confirmed_by, "user");

    let preferences = readProjection("mastra_runtime_preferences", "preferences_json");
    assert.ok(preferences, "runtime preferences row must be created for a new user");
    assert.equal(preferences!.onboardingState.current_step, "style");
    assert.equal(preferences!.onboardingState.steps.welcome.done, true);
    assert.equal(preferences!.onboardingState.steps.portfolio.done, true);

    // New onboarding completion semantics: the default usage mode applies
    // typed tasks (idempotent) instead of step-confirm tools.
    const { ensureDefaultUsageMode } = await import("../src/services/presets.js");
    const usage = await ensureDefaultUsageMode({ userId, projectId, instanceId });
    assert.ok(usage, "first call applies the default preset");
    assert.equal(usage.created.length, 4);
    const again = await ensureDefaultUsageMode({ userId, projectId, instanceId });
    assert.equal(again, null, "second call keeps existing configuration");
    const taskTypes = sqlite.prepare("SELECT task_type AS t, status FROM automation_tasks WHERE user_id=?").all(userId).map((r) => `${r.t}:${r.status}`);
    assert.equal(taskTypes.filter((entry) => entry.endsWith(":active")).length, 4);
    const prefs = readProjection("mastra_runtime_preferences", "preferences_json");
    assert.equal(prefs.schedulerActivation, "enabled");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("fresh mastra users read empty data and lazily create rows on write, matching workspace semantics", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-fresh-read-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    initDb();

    const userId = "mastra-fresh-read";
    const instanceId = "invest-agent-mastra-fresh-read";
    const conversationId = "mastra-fresh-read-conversation";
    const projectId = "invest-agent";
    const context = { userId, instanceId, projectId, conversationId };

    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId,
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      title: "Mastra fresh-user read parity",
      createdAt: now,
      updatedAt: now,
    });

    // Reads before any row exists must return empty results, not throw.
    const portfolio = await callServiceTool("portfolio.read", {}, context) as { ok: boolean; count: number; items: unknown[] };
    assert.equal(portfolio.ok, true);
    assert.equal(portfolio.count, 0);
    assert.deepEqual(portfolio.items, []);

    const watchlist = await callServiceTool("watchlist.read", {}, context) as { ok: boolean; count?: number; items: unknown[] };
    assert.equal(watchlist.ok, true);

    // The first write lazily creates the projection row.
    const request = await callServiceTool("confirmations.request", {
      operation: "watchlist.add",
      payload: { name: "贵州茅台", code: "600519", reason: "用户主动要求加入自选股" },
      summary: "请确认加入自选股",
    }, context) as { ok: boolean; confirmationId: string };
    assert.equal(request.ok, true);
    await db.insert(conversationMessages).values({
      messageId: "mastra-fresh-read-user",
      conversationId,
      userId,
      projectId,
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      role: "user",
      content: "确认",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const added = await callServiceTool("watchlist.add", {
      confirmedByUser: true,
      confirmationId: request.confirmationId,
      name: "贵州茅台",
      code: "600519",
      reason: "用户主动要求加入自选股",
    }, context) as { ok: boolean };
    assert.equal(added.ok, true);

    const row = sqlite.prepare("SELECT portfolio_json AS value FROM mastra_portfolio_states WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
      .get(userId, projectId, instanceId) as { value?: string } | undefined;
    assert.ok(row, "first watchlist write must lazily create the projection row");
    const stored = JSON.parse(row.value!);
    assert.ok(stored.watchlist.some((item: any) => item.code === "600519"));

    const watchlistAfter = await callServiceTool("watchlist.read", {}, context) as { items: Array<{ stockCode?: string }> };
    assert.ok(watchlistAfter.items.some((item) => item.stockCode === "600519"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
