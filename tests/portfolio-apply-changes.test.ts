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
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

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
    await store.writePortfolio({
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
    });
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

    const result = await callServiceTool("portfolio.apply_changes", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...payload,
      summary: "移除赛轮轮胎，新增宁德时代10%仓位",
    }, context) as {
      ok: boolean;
      revision: string;
      holdings: Array<{ code: string; weight?: number }>;
      watchlist: Array<{ code: string }>;
      cash: { ratio_percent: number };
    };
    assert.equal(result.ok, true);
    assert.equal(result.holdings.some((item) => item.code === "601058"), false);
    assert.equal(result.holdings.find((item) => item.code === "300750")?.weight, 10);
    assert.equal(result.watchlist.some((item) => item.code === "300750"), false);
    assert.equal(result.cash.ratio_percent, 55);
    assert.equal((result.cash as { notes?: string }).notes, "现金仓位约 55%", "cash display note must not retain the old ratio");
    assert.notEqual(result.revision, revision);

    const saved = await store.readPortfolio();
    assert.equal(saved?.last_confirmation_id, requested.confirmationId);
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
    await store.writePortfolio({ ...(await store.readPortfolio())!, last_confirmed_at: "2026-07-26T12:00:00.000Z" });
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
