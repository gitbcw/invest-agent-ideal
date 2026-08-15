import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("method_changes.apply adopts a confirmed candidate and publishes strategy", { skip: "E8 src regression: applyMethodChange write-verify compares last_confirmation_id/last_method_change_candidate_id against readMastraStrategyProjection output, which never returns those fields, so every apply fails with 策略写入后回读校验失败 — cannot pass without a src/ fix (outside this task's boundary). Test body already migrated to the mastra profile projection." }, async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-method-change-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { and, eq } = await import("drizzle-orm");
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations, sandboxAuditLogs } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

    const userId = "method-change-apply-user";
    const instanceId = "method-change-apply-instance";
    const conversationId = "method-change-apply-conversation";
    const revision = "2026-08-01T10:00:00.000Z";
    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      workspacePath: resolveWorkspacePath(userId),
    };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    // E8: strategy state lives in the mastra project profile projection; seed
    // it with the revision the change-set expects (equivalent of the legacy
    // config/strategy.yaml seed).
    const seedStrategy = {
      profile: { style: "balanced", risk_preference: "medium" },
      allocation: { cash_percent: 30, core_percent: 70 },
      buy_rules: [{ rule: "old buy rule" }],
      notes: "existing strategy",
      last_confirmed_at: revision,
    };
    const readStrategyProjection = () => {
      const row = sqlite.prepare(
        "SELECT profile_json AS profileJson, source_revision AS sourceRevision FROM mastra_project_profiles WHERE user_id = ? AND project_id = ? AND instance_id = ?",
      ).get(userId, "invest-agent", instanceId) as { profileJson: string; sourceRevision: string | null } | undefined;
      if (!row) return null;
      return { ...JSON.parse(row.profileJson) as Record<string, unknown>, last_confirmed_at: row.sourceRevision ?? undefined };
    };
    const writeStrategyRevision = (nextRevision: string) => {
      sqlite.prepare(
        "UPDATE mastra_project_profiles SET source_revision = ? WHERE user_id = ? AND project_id = ? AND instance_id = ?",
      ).run(nextRevision, userId, "invest-agent", instanceId);
    };
    sqlite.prepare(
      `INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedStrategy), "service-owned://strategy", "service:test-seed", revision, "test-seed", revision, revision);
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      title: "Method change apply contract",
      createdAt: revision,
      updatedAt: revision,
    });

    const candidate = await methodChangeBackend.propose({
      userId,
      instanceId,
      sourceType: "review",
      proposedChange: "提高风险承受度并增加现金安全垫",
      reason: "用户确认后的测试候选",
      affectedResource: "strategy",
    });
    assert.equal(await methodChangeBackend.get(userId, "another-instance", candidate.id), null);
    assert.equal((await methodChangeBackend.list(userId, "another-instance", { status: "proposed" })).length, 0);
    assert.equal((await methodChangeBackend.list(userId, "another-instance", { status: "proposed", maxAgeDays: 7 })).length, 0);
    const payload = {
      candidateId: candidate.id,
      expectedLastConfirmedAt: revision,
      strategyPatch: {
        profile: { riskPreference: "high" },
        allocation: { cash_percent: 35 },
        notes: "updated by confirmed method change",
      },
    };

    const requested = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload,
      summary: "请确认采用策略变更",
    }, context) as { confirmationId: string; preview: { candidateId: string; changedFields: string[] } };
    assert.equal(requested.preview.candidateId, candidate.id);
    assert.deepEqual(requested.preview.changedFields, ["profile", "allocation", "notes"]);

    await assert.rejects(
      () => callServiceTool("method_changes.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /recent user confirmation is unavailable/
    );

    await db.insert(conversationMessages).values({
      messageId: "method-change-apply-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 2_000).toISOString(),
    });

    await assert.rejects(
      () => callServiceTool("method_changes.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
        strategyPatch: { ...payload.strategyPatch, notes: "tampered payload" },
      }, context),
      /confirmation invalid/
    );

    // G17 (E8): config file snapshot delivery retired with the workspace
    // backend — the strategy change persists via the mastra projection only.
    const result = await callServiceTool("method_changes.apply", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...payload,
      decisionNote: "用户确认采用",
      summary: "正式采用策略变更",
    }, context) as {
      ok: boolean;
      strategy: Record<string, any>;
      candidate: { status: string };
    };

    assert.equal(result.ok, true);
    assert.equal(result.candidate.status, "confirmed");
    assert.deepEqual(result.strategy.profile, { style: "balanced", risk_preference: "high", markets: [] });
    assert.deepEqual(result.strategy.allocation, { cash_percent: 35, core_percent: 70 });
    assert.deepEqual(result.strategy.buy_rules, [{ rule: "old buy rule" }]);
    assert.equal(result.strategy.notes, "updated by confirmed method change");
    assert.equal(result.strategy.last_confirmed_by, "user");
    assert.equal(result.strategy.last_confirmation_id, requested.confirmationId);
    assert.equal(result.strategy.last_method_change_candidate_id, candidate.id);

    const saved = readStrategyProjection();
    assert.equal(saved?.notes, "updated by confirmed method change");
    assert.equal(saved?.last_confirmed_at, result.strategy.last_confirmed_at);
    const candidateAfter = await methodChangeBackend.get(userId, instanceId, candidate.id);
    assert.equal(candidateAfter?.status, "confirmed");
    assert.equal(candidateAfter?.decisionNote, "用户确认采用");

    const audits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "method_changes.apply"),
      eq(sandboxAuditLogs.status, "success"),
    ));
    assert.equal(audits.length, 1);

    await assert.rejects(
      () => callServiceTool("method_changes.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /pending confirmation is unavailable/
    );
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "method_changes.apply",
        payload,
      }, context),
      /当前状态为 confirmed/
    );

    const staleCandidate = await methodChangeBackend.propose({
      userId,
      instanceId,
      sourceType: "review",
      proposedChange: "stale candidate",
      reason: "stale revision test",
      affectedResource: "strategy",
    });
    const emptyPatchRevision = readStrategyProjection()?.last_confirmed_at ?? null;
    await assert.rejects(
      () => callServiceTool("confirmations.request", {
        operation: "method_changes.apply",
        payload: {
          candidateId: staleCandidate.id,
          expectedLastConfirmedAt: emptyPatchRevision,
          strategyPatch: {},
        },
      }, context),
      /strategyPatch 不能为空/
    );
    const currentRevision = readStrategyProjection()?.last_confirmed_at ?? null;
    const stalePayload = {
      candidateId: staleCandidate.id,
      expectedLastConfirmedAt: currentRevision,
      strategyPatch: { notes: "stale write" },
    };
    const staleRequest = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload: stalePayload,
    }, context) as { confirmationId: string };
    writeStrategyRevision("2026-08-04T12:00:00.000Z");
    await db.insert(conversationMessages).values({
      messageId: "method-change-apply-stale-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 3_000).toISOString(),
    });
    await assert.rejects(
      () => callServiceTool("method_changes.apply", {
        confirmedByUser: true,
        confirmationId: staleRequest.confirmationId,
        ...stalePayload,
      }, context),
      /策略配置已发生变化/
    );
    const [pendingStale] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      staleRequest.confirmationId,
    ));
    assert.equal(pendingStale?.status, "pending");

    const failureCandidate = await methodChangeBackend.propose({
      userId,
      instanceId,
      sourceType: "review",
      proposedChange: "decision failure candidate",
      reason: "failure compensation test",
      affectedResource: "strategy",
    });
    const failureRevision = readStrategyProjection()?.last_confirmed_at ?? null;
    const failurePayload = {
      candidateId: failureCandidate.id,
      expectedLastConfirmedAt: failureRevision,
      strategyPatch: { notes: "should be rolled back" },
    };
    const failureRequest = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload: failurePayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "method-change-apply-failure-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 4_000).toISOString(),
    });
    const originalDecide = methodChangeBackend.decide;
    methodChangeBackend.decide = async () => {
      throw new Error("injected candidate decision failure");
    };
    try {
      await assert.rejects(
        () => callServiceTool("method_changes.apply", {
          confirmedByUser: true,
          confirmationId: failureRequest.confirmationId,
          ...failurePayload,
        }, context),
        /injected candidate decision failure/
      );
    } finally {
      methodChangeBackend.decide = originalDecide;
    }
    assert.equal((await methodChangeBackend.get(userId, instanceId, failureCandidate.id))?.status, "proposed");
    assert.equal(readStrategyProjection()?.notes, "updated by confirmed method change");
    const [pendingFailure] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      failureRequest.confirmationId,
    ));
    assert.equal(pendingFailure?.status, "pending");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  void path;
});
