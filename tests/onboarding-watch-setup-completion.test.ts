import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("onboarding watch setup completes without a redundant confirmation", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-onboarding-completion-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb } = await import("../src/db/index.js");
    const { alertRules, conversationMessages, conversationSessions, pendingSandboxConfirmations, sandboxAuditLogs } = await import("../src/db/schema.js");
    const { and, eq } = await import("drizzle-orm");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");

    initDb();

    async function setupUser(userId: string) {
      const instanceId = `invest-agent-${userId}`;
      const conversationId = `${userId}-conversation`;
      await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
      const now = new Date().toISOString();
      await db.insert(conversationSessions).values({
        conversationId,
        userId,
        projectId: "invest-agent",
        instanceId,
        assistantId: instanceId,
        channel: "weixin-mobile",
        title: "Onboarding watch setup completion",
        createdAt: now,
        updatedAt: now,
      });
      const store = new WorkspaceStore(userId);
      const doneAt = "2026-01-01T00:00:00.000Z";
      await store.writeOnboardingState({
        version: 1,
        status: "in_progress",
        current_step: "watch_rules",
        steps: {
          welcome: { done: true, completed_at: doneAt },
          portfolio: { done: true, completed_at: doneAt },
          style: { done: true, completed_at: doneAt },
          review_schedule: { done: true, completed_at: doneAt },
          market_watch_schedule: { done: true, completed_at: doneAt },
          notification: { done: true, completed_at: doneAt },
          watch_rules: { done: false, completed_at: null },
        },
        completed_at: null,
        updated_at: doneAt,
        notes: "",
      });
      return {
        userId,
        instanceId,
        conversationId,
        store,
        context: { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) },
      };
    }

    async function addUserMessage(scope: Awaited<ReturnType<typeof setupUser>>, content: string, offsetMs: number) {
      await db.insert(conversationMessages).values({
        messageId: `${scope.userId}-${offsetMs}`,
        conversationId: scope.conversationId,
        userId: scope.userId,
        projectId: "invest-agent",
        instanceId: scope.instanceId,
        assistantId: scope.instanceId,
        channel: "weixin-mobile",
        role: "user",
        content,
        createdAt: new Date(Date.now() + offsetMs).toISOString(),
      });
    }

    const skipped = await setupUser("onboarding-completion-skip");
    await addUserMessage(skipped, "好", 1_000);
    await assert.rejects(
      () => callServiceTool("onboarding.complete_watch_setup", { branch: "skip" }, skipped.context),
      /explicitly skip/
    );
    assert.equal((await skipped.store.readOnboardingState()).status, "in_progress");

    await addUserMessage(skipped, "暂不设置明确规则", 2_000);
    const skippedResult = await callServiceTool("onboarding.complete_watch_setup", {
      branch: "skip",
      summary: "用户选择暂不设置明确规则",
    }, skipped.context) as { state: { status: string; current_step: string } };
    assert.equal(skippedResult.state.status, "completed");
    assert.equal(skippedResult.state.current_step, "completed");

    const configured = await setupUser("onboarding-completion-configured");
    const rulePayload = {
      stockCode: "601058",
      stockName: "赛轮轮胎",
      ruleType: "price_cross",
      targetScope: "holding",
      params: { operator: ">=", value: 10 },
      cooldown: { mode: "cooldown", minutes: 240 },
      notification: { priority: "P0", push: true },
    };
    const requested = await callServiceTool("confirmations.request", {
      operation: "watch_rules.create",
      payload: rulePayload,
      summary: "确认创建价格上穿提醒",
    }, configured.context) as { confirmationId: string };
    await addUserMessage(configured, "确认", 3_000);
    const created = await callServiceTool("watch_rules.create", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...rulePayload,
    }, configured.context) as { rule: { id: number } };

    const redundantCompletion = await callServiceTool("confirmations.request", {
      operation: "onboarding.confirm_step",
      payload: { step: "watch_rules", summary: "旧流程要求确认完成" },
    }, configured.context) as { confirmationId: string };

    const configuredResult = await callServiceTool("onboarding.complete_watch_setup", {
      branch: "configured",
      ruleIds: [created.rule.id],
      summary: "明确规则已确认创建并核对",
    }, configured.context) as { state: { status: string; current_step: string }; ruleIds: number[] };
    assert.equal(configuredResult.state.status, "completed");
    assert.equal(configuredResult.state.current_step, "completed");
    assert.deepEqual(configuredResult.ruleIds, [created.rule.id]);

    const remainingPending = await db.select().from(pendingSandboxConfirmations).where(and(
      eq(pendingSandboxConfirmations.userId, configured.userId),
      eq(pendingSandboxConfirmations.instanceId, configured.instanceId),
      eq(pendingSandboxConfirmations.status, "pending")
    ));
    assert.equal(remainingPending.length, 0);
    const [superseded] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      redundantCompletion.confirmationId
    ));
    assert.equal(superseded?.status, "superseded");

    const [rule] = await db.select().from(alertRules).where(and(
      eq(alertRules.id, created.rule.id),
      eq(alertRules.userId, configured.userId),
      eq(alertRules.instanceId, configured.instanceId)
    ));
    assert.ok(rule);
    const completionAudits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, configured.userId),
      eq(sandboxAuditLogs.operation, "onboarding.complete_watch_setup"),
      eq(sandboxAuditLogs.status, "success")
    ));
    assert.equal(completionAudits.length, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
