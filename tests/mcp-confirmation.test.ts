import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("MCP durable writes consume an exact, later-turn confirmation once", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mcp-confirmation-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations, sandboxAuditLogs } = await import("../src/db/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");

    const userId = "mcp-confirmation-test";
    const instanceId = "invest-agent-mcp-confirmation-test";
    const conversationId = "mcp-confirmation-conversation";
    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      workspacePath: resolveWorkspacePath(userId),
    };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      title: "MCP confirmation contract",
      createdAt: now,
      updatedAt: now,
    });
    const store = new WorkspaceStore(userId);
    await store.writeOnboardingState({
      version: 1,
      status: "in_progress",
      current_step: "style",
      steps: {
        welcome: { done: true, completed_at: now },
        portfolio: { done: true, completed_at: now },
        style: { done: false, completed_at: null },
      },
      completed_at: null,
      updated_at: now,
      notes: "",
    });

    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "onboarding.confirm_step",
        payload: {
          step: "style",
          styleProfile: { basePositionPercent: 5 },
        },
      }, context),
      /策略摘要/
    );
    const invalidDrafts = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.userId, userId));
    assert.equal(invalidDrafts.length, 0, "invalid onboarding drafts must be rejected before creating a confirmation");

    const watchlistDraft = {
      name: "贵州茅台",
      code: "600519",
      reason: "用户主动要求加入自选股",
    };
    const watchlistConfirmation = await callServiceTool("confirmations.request", {
      operation: "watchlist.add",
      payload: watchlistDraft,
      summary: "请确认加入自选股",
    }, context) as { ok: boolean; confirmationId: string; operation: string };
    assert.equal(watchlistConfirmation.ok, true);
    assert.equal(watchlistConfirmation.operation, "watchlist.add");
    const [watchlistPending] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, watchlistConfirmation.confirmationId));
    assert.equal(watchlistPending?.operation, "watchlist.add");
    assert.equal(watchlistPending?.requestBody, JSON.stringify(watchlistDraft));
    const watchlistAudits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "confirmations.request")
    ));
    assert.ok(watchlistAudits.some((row) => row.resultSummary?.includes("watchlist.add")), "watchlist confirmation requests must be audited");

    const payload = {
      step: "style",
      summary: "保存趋势辅助型风格",
      styleProfile: {
        name: "基本面主导的中期趋势策略",
        strategySummary: "基本面为主，技术面辅助；保留5%底仓，每次加减仓5%，以收盘价确认。",
        holdingHorizon: "中期趋势",
        entryRules: [{ condition: "回踩5日线不破", action: "加仓5%" }],
        exitRules: [{ condition: "跌破10日线", action: "减仓5%" }],
        basePositionPercent: 5,
        positionStepPercent: 5,
        executionPrice: "收盘价确认",
      },
    };
    const requested = await callServiceTool("confirmations.request", {
      operation: "onboarding.confirm_step",
      payload,
      summary: "请确认保存风格",
    }, context) as { confirmationId: string };

    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", { confirmedByUser: true, ...payload }, context),
      /confirmationId is required/
    );

    const confirmedAt = new Date(Date.now() + 1_000).toISOString();
    await db.insert(conversationMessages).values({
      messageId: "mcp-confirmation-user-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      role: "user",
      content: "确认保存风格",
      createdAt: confirmedAt,
    });

    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, { ...context, instanceId: "invest-agent-other-instance" }),
      /pending confirmation is unavailable/
    );

    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
        summary: "被篡改的草案",
      }, context),
      /confirmation payload mismatch/
    );

    const saved = await callServiceTool("onboarding.confirm_step", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...payload,
    }, context) as { ok: boolean; state: { steps: Record<string, { done: boolean }> } };
    assert.equal(saved.ok, true);
    assert.equal(saved.state.steps.style.done, true);
    const strategy = await store.readStrategy();
    assert.equal(strategy?.profile?.style, "基本面主导的中期趋势策略");
    assert.equal(strategy?.profile?.investment_horizon, "中期趋势");
    assert.match(strategy?.notes ?? "", /保留5%底仓/);
    assert.deepEqual(strategy?.buy_rules, payload.styleProfile.entryRules);
    assert.deepEqual(strategy?.sell_rules, payload.styleProfile.exitRules);
    assert.ok(strategy?.last_confirmed_at);

    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /pending confirmation is unavailable/
    );

    const skippedPayload = {
      step: "market_watch_schedule",
      summary: "错误地跳过复盘时间",
      marketWatchSchedule: {
        default_windows: ["09:55", "11:20", "14:30"],
        push_mode: "exception_only",
      },
    };
    const skipped = await callServiceTool("confirmations.request", {
      operation: "onboarding.confirm_step",
      payload: skippedPayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "mcp-confirmation-skipped-step-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      role: "user",
      content: "确认",
      createdAt: new Date(Date.now() + 2_000).toISOString(),
    });
    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", {
        confirmedByUser: true,
        confirmationId: skipped.confirmationId,
        ...skippedPayload,
      }, context),
      /不能跳过 onboarding 前置步骤/
    );
    const [stillPending] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, skipped.confirmationId));
    assert.equal(stillPending?.status, "pending", "failed durable writes must not consume the confirmation");
    const failureAudits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "onboarding.confirm_step"),
      eq(sandboxAuditLogs.status, "error")
    ));
    assert.ok(failureAudits.some((row) => row.resultSummary?.includes("不能跳过 onboarding 前置步骤")), "failed confirmed writes must be audited");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
