import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("portfolio.apply_changes applies one confirmed, revision-bound portfolio transition", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portfolio-change-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { and, eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const {
      conversationMessages,
      conversationSessions,
      pendingSandboxConfirmations,
      sandboxAuditLogs,
    } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");
    const { readMastraPortfolioProjection, replaceMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");

    const userId = "portfolio-change-user";
    const instanceId = "invest-agent-portfolio-change-user";
    const conversationId = "portfolio-change-conversation";
    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      workspacePath: resolveWorkspacePath(userId),
    };
    const revision = "2026-07-22T13:55:09.470Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const store = new WorkspaceStore(userId);
    // E8: the mastra projection is the only portfolio state; seed it with the
    // revision the change-set expects (equivalent of the legacy YAML seed).
    const seedPortfolio = {
      cash: { ratio_percent: 35, notes: "现金仓位约 35%" },
      holdings: [
        { code: "601058", name: "赛轮轮胎", weight: 30, notes: "仓位30%" },
        { code: "002460", name: "赣锋锂业", weight: 25, notes: "仓位25%" },
        { code: "002240", name: "盛新锂能", weight: 10, notes: "仓位10%" },
      ],
      watchlist: [
        { code: "300750", name: "宁德时代" },
        { code: "300274", name: "阳光电源" },
      ],
      accounts: [],
      last_confirmed_at: revision,
      last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "service:test-seed", revision, "test-seed", revision, revision);
    await store.writeOnboardingState({
      version: 1,
      status: "completed",
      current_step: "completed",
      steps: {
        welcome: { done: true, completed_at: revision },
        portfolio: { done: true, completed_at: revision },
      },
      completed_at: revision,
      updated_at: revision,
      notes: "",
    });
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      title: "Portfolio change contract",
      createdAt: revision,
      updatedAt: revision,
    });

    const basePayload = {
      expectedLastConfirmedAt: revision,
      removeHoldingCodes: ["601058"],
      upsertHoldings: [{ code: "300750", name: "宁德时代", weight: 10, notes: "仓位10%" }],
      summary: "移除赛轮轮胎，新增宁德时代10%仓位",
    };

    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "portfolio.apply_changes",
        payload: { ...basePayload, cashRatioPercent: 55 },
      }, context),
      /watchlist action is required/
    );
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "portfolio.apply_changes",
        payload: {
          ...basePayload,
          watchlistActions: [{ code: "300750", action: "remove" }],
        },
      }, context),
      /portfolio allocation must total 100%/
    );

    const payload = {
      ...basePayload,
      watchlistActions: [{ code: "300750", action: "remove" }],
      cashRatioPercent: 55,
    };
    const requested = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload,
      summary: "请确认组合变更",
    }, context) as {
      confirmationId: string;
      preview: { allocation: { totalPercent: number }; removedHoldings: Array<{ code: string }> };
    };
    assert.equal(requested.preview.allocation.totalPercent, 100);
    assert.deepEqual(requested.preview.removedHoldings.map((item) => item.code), ["601058"]);

    await assert.rejects(
      () => callServiceTool("portfolio.apply_changes", { confirmedByUser: true, ...payload }, context),
      /confirmationId is required/
    );
    await db.insert(conversationMessages).values({
      messageId: "portfolio-change-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认按这个组合更新",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const turnId = "portfolio-change-turn";
    markTurnStart({ userId, instanceId, conversationId, turnId });
    let result: {
      ok: boolean;
      revision: string;
      holdings: Array<{ code: string; weight?: number }>;
      watchlist: Array<{ code: string }>;
      cash: { ratio_percent: number };
      artifact?: { artifactId: string; fileName: string; mimeType: string; relativePath?: string };
    };
    try {
      result = await callServiceTool("portfolio.apply_changes", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
        summary: "移除赛轮轮胎，新增宁德时代10%仓位",
      }, context) as typeof result;
    } finally {
      markTurnEnd({ userId, instanceId, conversationId, turnId });
    }
    assert.equal(result.ok, true);
    assert.equal(result.holdings.some((item) => item.code === "601058"), false);
    assert.equal(result.holdings.find((item) => item.code === "300750")?.weight, 10);
    assert.equal(result.watchlist.some((item) => item.code === "300750"), false);
    assert.equal(result.cash.ratio_percent, 55);
    assert.equal((result.cash as { notes?: string }).notes, "现金仓位约 55%", "cash display note must not retain the old ratio");
    assert.notEqual(result.revision, revision);
    // G17 (E8): the portfolio.yaml snapshot artifact delivery retired with the
    // workspace backend — result.artifact is intentionally undefined now.

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      last_confirmation_id?: string;
    };
    assert.equal(saved.last_confirmation_id, requested.confirmationId);
    assert.equal((await store.readOnboardingState())?.status, "completed", "portfolio maintenance must not reopen onboarding");
    const successAudits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "portfolio.apply_changes"),
      eq(sandboxAuditLogs.status, "success")
    ));
    assert.equal(successAudits.length, 1);
    await assert.rejects(
      () => callServiceTool("portfolio.apply_changes", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /pending confirmation is unavailable/
    );

    const stalePayload = {
      expectedLastConfirmedAt: result.revision,
      upsertHoldings: [{ code: "300750", name: "宁德时代", weight: 15 }],
      cashRatioPercent: 50,
      summary: "把宁德时代调整为15%",
    };
    const staleRequest = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: stalePayload,
    }, context) as { confirmationId: string };
    replaceMastraPortfolioProjection(userId, instanceId, {
      ...readMastraPortfolioProjection(userId, instanceId),
      last_confirmed_at: "2026-07-26T12:00:00.000Z",
    }, result.revision);
    await db.insert(conversationMessages).values({
      messageId: "portfolio-change-stale-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认调整",
      createdAt: new Date(Date.now() + 2_000).toISOString(),
    });
    await assert.rejects(
      () => callServiceTool("portfolio.apply_changes", {
        confirmedByUser: true,
        confirmationId: staleRequest.confirmationId,
        ...stalePayload,
      }, context),
      /portfolio state changed/
    );
    const [stillPending] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      staleRequest.confirmationId
    ));
    assert.equal(stillPending?.status, "pending");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("concurrent confirmed applies serialize on the resource lock; the stale revision loser is rejected", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portfolio-race-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { and, eq, ne } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const {
      conversationMessages,
      conversationSessions,
      pendingSandboxConfirmations,
      sandboxAuditLogs,
    } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { withResourceMutationLock } = await import("../src/services/resource-mutation-lock.js");

    const userId = "portfolio-race-user";
    const instanceId = "invest-agent-portfolio-race-user";
    const conversationId = "portfolio-race-conversation";
    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      workspacePath: resolveWorkspacePath(userId),
    };
    const revision = "2026-07-27T09:30:00.000Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const store = new WorkspaceStore(userId);
    // E8: seed the mastra projection as the current portfolio state.
    const seedPortfolio = {
      cash: { ratio_percent: 35, notes: "现金仓位约 35%" },
      holdings: [
        { code: "601058", name: "赛轮轮胎", weight: 30, notes: "仓位30%" },
        { code: "002460", name: "赣锋锂业", weight: 25, notes: "仓位25%" },
        { code: "002240", name: "盛新锂能", weight: 10, notes: "仓位10%" },
      ],
      watchlist: [
        { code: "300750", name: "宁德时代" },
        { code: "300274", name: "阳光电源" },
      ],
      accounts: [],
      last_confirmed_at: revision,
      last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "service:test-seed", revision, "test-seed", revision, revision);
    await store.writeOnboardingState({
      version: 1,
      status: "completed",
      current_step: "completed",
      steps: {
        welcome: { done: true, completed_at: revision },
        portfolio: { done: true, completed_at: revision },
      },
      completed_at: revision,
      updated_at: revision,
      notes: "",
    });
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      title: "Portfolio race contract",
      createdAt: revision,
      updatedAt: revision,
    });

    // Two confirmations drafted against the same revision, as two concurrent
    // Portal conversations would produce.
    const payload = {
      expectedLastConfirmedAt: revision,
      upsertHoldings: [{ code: "300750", name: "宁德时代", weight: 10, notes: "仓位10%" }],
      watchlistActions: [{ code: "300750", action: "remove" }],
      cashRatioPercent: 25,
      summary: "新增宁德时代10%仓位",
    };
    const requestA = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload,
    }, context) as { confirmationId: string };
    const requestB = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "portfolio-race-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "两个对话都确认",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    // Pre-hold the portfolio lock so both applies are genuinely queued on it
    // before either can run, then release to let them race for acquisition.
    let holderEntered!: () => void;
    let holderRelease!: () => void;
    const entered = new Promise<void>((resolve) => { holderEntered = resolve; });
    const gate = new Promise<void>((resolve) => { holderRelease = resolve; });
    const holder = withResourceMutationLock({ userId, instanceId }, "portfolio", async () => {
      holderEntered();
      await gate;
    });
    await entered;

    const attempt = (confirmationId: string) =>
      callServiceTool("portfolio.apply_changes", { confirmedByUser: true, confirmationId, ...payload }, context)
        .then((result) => ({ status: "fulfilled" as const, result }))
        .catch((error: unknown) => ({ status: "rejected" as const, error: error as Error }));

    const raceA = attempt(requestA.confirmationId);
    const raceB = attempt(requestB.confirmationId);
    let outcomes: Awaited<typeof raceA>[];
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      holderRelease();
      outcomes = await Promise.all([raceA, raceB]);
    } finally {
      holderRelease();
    }
    await holder;

    const byConfirmation = [
      { confirmationId: requestA.confirmationId, outcome: outcomes[0] },
      { confirmationId: requestB.confirmationId, outcome: outcomes[1] },
    ];
    const winners = byConfirmation.filter((entry) => entry.outcome.status === "fulfilled");
    const losers = byConfirmation.filter((entry) => entry.outcome.status === "rejected");
    assert.equal(winners.length, 1, "exactly one concurrent apply may win the resource lock and write");
    assert.equal(losers.length, 1, "the second apply must re-validate revision inside the lock and fail");
    assert.match(
      (losers[0].outcome as { status: "rejected"; error: Error }).error.message,
      /portfolio state changed/,
      "stale concurrent write must be rejected instead of silently overwriting",
    );

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      last_confirmed_at?: string;
      last_confirmation_id?: string;
      holdings?: Array<{ code: string; weight?: number }>;
      cash?: { ratio_percent?: number };
    };
    assert.notEqual(saved.last_confirmed_at, revision);
    assert.equal(saved.last_confirmation_id, winners[0].confirmationId);
    assert.equal(saved.holdings?.find((item) => item.code === "300750")?.weight, 10);
    assert.equal(saved.cash?.ratio_percent, 25);

    const confirmations = await db.select().from(pendingSandboxConfirmations).where(and(
      eq(pendingSandboxConfirmations.userId, userId),
      eq(pendingSandboxConfirmations.operation, "portfolio.apply_changes"),
    ));
    const byId = new Map(confirmations.map((row) => [row.id, row.status]));
    assert.equal(byId.get(winners[0].confirmationId), "confirmed");
    assert.equal(byId.get(losers[0].confirmationId), "pending", "failed confirmation must not be consumed");

    const errorAudits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "portfolio.apply_changes"),
      ne(sandboxAuditLogs.status, "success"),
    ));
    assert.equal(errorAudits.length, 1, "the rejected stale write must leave an error audit");
    assert.equal(errorAudits[0].status, "error");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("portfolio.apply_changes confirmation survives schema-noise between draft and apply (weixin regression 2026-08-16)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portfolio-noise-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { readMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "portfolio-noise-user";
    const instanceId = "invest-agent-portfolio-noise-user";
    const conversationId = "portfolio-noise-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
    const revision = "2026-08-10T22:27:18.271Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    // 与 2026-08-16 微信复现场景一致的种子：赣锋 25% / 盛新 10% / 现金 65%。
    const seedPortfolio = {
      cash: { ratio_percent: 65, notes: "现金仓位约 65%" },
      holdings: [
        { code: "002460", name: "赣锋锂业", weight: 25, notes: "仓位25%" },
        { code: "002240", name: "盛新锂能", weight: 10, notes: "仓位10%" },
      ],
      watchlist: [],
      accounts: [],
      last_confirmed_at: revision,
      last_confirmed_by: "user",
    };
    (await import("../src/db/index.js")).sqlite.prepare(
      `INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedPortfolio), "service-owned://portfolio", "service:test-seed", revision, "test-seed", revision, revision);
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Noise regression", createdAt: now, updatedAt: now,
    });

    // 模型起草时带了 schema 外的 expectedRevision、显式空 watchlistActions。
    const requested = await callServiceTool("confirmations.request", {
      operation: "portfolio.apply_changes",
      payload: {
        expectedRevision: revision,
        expectedLastConfirmedAt: revision,
        removeHoldingCodes: [],
        upsertHoldings: [
          { code: "002240", name: "盛新锂能", shares: null, cost: null, weight: 21, notes: "持仓占比调整为 21%" },
          { code: "002460", name: "赣锋锂业", shares: null, cost: null, weight: 18, notes: "持仓占比调整为 18%" },
        ],
        cashRatioPercent: 61,
        watchlistActions: [],
      },
      summary: "请确认调整持仓比例",
    }, context) as { confirmationId: string };

    await db.insert(conversationMessages).values({
      messageId: "portfolio-noise-confirmation-message",
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", role: "user", content: "确认",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });

    // 执行轮经 zod schema 过滤后的干净参数：无 expectedRevision、省略空的可选字段。
    const applied = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      expectedLastConfirmedAt: revision,
      upsertHoldings: [
        { code: "002240", name: "盛新锂能", weight: 21, notes: "持仓占比调整为 21%" },
        { code: "002460", name: "赣锋锂业", weight: 18, notes: "持仓占比调整为 18%" },
      ],
      cashRatioPercent: 61,
    }, context) as { ok: boolean };
    assert.equal(applied.ok, true, "apply must succeed despite schema noise between draft and apply payloads");

    const saved = readMastraPortfolioProjection(userId, instanceId) as {
      holdings?: Array<{ code: string; weight?: number }>;
      cash?: { ratio_percent?: number };
    };
    assert.equal(saved.holdings?.find((item) => item.code === "002240")?.weight, 21);
    assert.equal(saved.holdings?.find((item) => item.code === "002460")?.weight, 18);
    assert.equal(saved.cash?.ratio_percent, 61);
    const [confirmation] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, requested.confirmationId));
    assert.equal(confirmation?.status, "confirmed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
