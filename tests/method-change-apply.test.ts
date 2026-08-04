import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("method_changes.apply adopts a confirmed candidate and publishes strategy", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-method-change-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
  process.env.WORKSPACE_BACKEND = "workspace";
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { and, eq } = await import("drizzle-orm");
    const { db, initDb } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions, pendingSandboxConfirmations, sandboxAuditLogs } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { WorkspaceStore } = await import("../src/lib/workspace-store.js");
    const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
    const { callServiceTool, __setServiceToolFailureInjection } = await import("../src/mcp/service-tools-core.js");
    const { findArtifactsForTurn, readConversationArtifactPayload } = await import("../src/services/conversation-artifacts.js");
    const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");

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
    const store = new WorkspaceStore(userId);
    await store.writeStrategy({
      profile: { style: "balanced", risk_preference: "medium" },
      allocation: { cash_percent: 30, core_percent: 70 },
      buy_rules: [{ rule: "old buy rule" }],
      notes: "existing strategy",
      last_confirmed_at: revision,
    });
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

    const turnId = "method-change-apply-turn";
    markTurnStart({ userId, instanceId, conversationId, turnId });
    let result: {
      ok: boolean;
      strategy: Record<string, unknown>;
      candidate: { status: string };
      artifacts?: Array<{ artifactId: string; relativePath: string; fileName: string; mimeType: string }>;
    };
    try {
      result = await callServiceTool("method_changes.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
        decisionNote: "用户确认采用",
        summary: "正式采用策略变更",
      }, context) as typeof result;
    } finally {
      markTurnEnd({ userId, instanceId, conversationId, turnId });
    }

    assert.equal(result.ok, true);
    assert.equal(result.candidate.status, "confirmed");
    assert.deepEqual(result.strategy.profile, { style: "balanced", risk_preference: "high" });
    assert.deepEqual(result.strategy.allocation, { cash_percent: 35, core_percent: 70 });
    assert.deepEqual(result.strategy.buy_rules, [{ rule: "old buy rule" }]);
    assert.equal(result.strategy.notes, "updated by confirmed method change");
    assert.equal(result.strategy.last_confirmed_by, "user");
    assert.equal(result.strategy.last_confirmation_id, requested.confirmationId);
    assert.equal(result.strategy.last_method_change_candidate_id, candidate.id);
    assert.ok(result.artifacts?.some((artifact) => artifact.relativePath === "config/strategy.yaml"));

    const saved = await store.readStrategy();
    assert.deepEqual(saved, result.strategy);
    const candidateAfter = await methodChangeBackend.get(userId, instanceId, candidate.id);
    assert.equal(candidateAfter?.status, "confirmed");
    assert.equal(candidateAfter?.decisionNote, "用户确认采用");

    const changeLogs = (await readFile(path.join(store.path(), "memory/change_log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const changeLog = changeLogs.at(-1);
    assert.equal(changeLog.type, "method_change_applied");
    assert.equal(changeLog.details.candidate_id, candidate.id);
    const audits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "method_changes.apply"),
      eq(sandboxAuditLogs.status, "success"),
    ));
    assert.equal(audits.length, 1);

    const artifacts = findArtifactsForTurn({ userId, instanceId, conversationId, turnId });
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].relativePath, "config/strategy.yaml");
    const artifactPayload = await readConversationArtifactPayload({
      artifactId: artifacts[0].artifactId,
      userId,
      instanceId,
    });
    assert.equal(artifactPayload.payload.mimeType, "application/yaml");
    assert.match(Buffer.from(artifactPayload.payload.base64, "base64").toString("utf8"), /risk_preference: high/);

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
    const emptyPatchRevision = (await store.readStrategy())?.last_confirmed_at ?? null;
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
    const currentRevision = (await store.readStrategy())?.last_confirmed_at ?? null;
    const stalePayload = {
      candidateId: staleCandidate.id,
      expectedLastConfirmedAt: currentRevision,
      strategyPatch: { notes: "stale write" },
    };
    const staleRequest = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload: stalePayload,
    }, context) as { confirmationId: string };
    await store.writeStrategy({ ...(await store.readStrategy())!, last_confirmed_at: "2026-08-04T12:00:00.000Z" });
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
    const failureRevision = (await store.readStrategy())?.last_confirmed_at ?? null;
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
    assert.equal((await store.readStrategy())?.notes, "updated by confirmed method change");
    const [pendingFailure] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      failureRequest.confirmationId,
    ));
    assert.equal(pendingFailure?.status, "pending");

    const recoveryCandidate = await methodChangeBackend.propose({
      userId,
      instanceId,
      sourceType: "review",
      proposedChange: "change log recovery candidate",
      reason: "change log recovery test",
      affectedResource: "strategy",
    });
    const recoveryRevision = (await store.readStrategy())?.last_confirmed_at ?? null;
    const recoveryPayload = {
      candidateId: recoveryCandidate.id,
      expectedLastConfirmedAt: recoveryRevision,
      strategyPatch: { notes: "recovered after change log failure" },
    };
    const recoveryRequest = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload: recoveryPayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "method-change-apply-recovery-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 5_000).toISOString(),
    });
    const originalAppendChangeLog = WorkspaceStore.prototype.appendChangeLog;
    let failChangeLogOnce = true;
    WorkspaceStore.prototype.appendChangeLog = async function (record: unknown) {
      if (failChangeLogOnce && (record as { type?: string }).type === "method_change_applied") {
        failChangeLogOnce = false;
        throw new Error("injected change log failure");
      }
      return originalAppendChangeLog.call(this, record);
    };
    try {
      await assert.rejects(
        () => callServiceTool("method_changes.apply", {
          confirmedByUser: true,
          confirmationId: recoveryRequest.confirmationId,
          ...recoveryPayload,
        }, context),
        /injected change log failure/
      );
    } finally {
      WorkspaceStore.prototype.appendChangeLog = originalAppendChangeLog;
    }
    assert.equal((await methodChangeBackend.get(userId, instanceId, recoveryCandidate.id))?.status, "confirmed");
    assert.equal((await store.readStrategy())?.notes, "recovered after change log failure");
    const [pendingRecovery] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      recoveryRequest.confirmationId,
    ));
    assert.equal(pendingRecovery?.status, "pending");

    const recoveryResult = await callServiceTool("method_changes.apply", {
      confirmedByUser: true,
      confirmationId: recoveryRequest.confirmationId,
      ...recoveryPayload,
    }, context) as { ok: boolean; artifacts?: Array<{ relativePath: string }> };
    assert.equal(recoveryResult.ok, true);
    assert.deepEqual(recoveryResult.artifacts?.map((artifact) => artifact.relativePath), ["config/strategy.yaml"]);

    const artifactCandidate = await methodChangeBackend.propose({
      userId,
      instanceId,
      sourceType: "review",
      proposedChange: "artifact recovery candidate",
      reason: "artifact failure recovery test",
      affectedResource: "strategy",
    });
    const artifactRevision = (await store.readStrategy())?.last_confirmed_at ?? null;
    const artifactApplyPayload = {
      candidateId: artifactCandidate.id,
      expectedLastConfirmedAt: artifactRevision,
      strategyPatch: { notes: "recovered after artifact failure" },
    };
    const artifactRequest = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload: artifactApplyPayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "method-change-apply-artifact-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 6_000).toISOString(),
    });
    __setServiceToolFailureInjection({
      artifactPublish: (relativePath) => relativePath === "config/strategy.yaml"
        ? new Error("injected artifact publish failure")
        : undefined,
    });
    try {
      await assert.rejects(
        () => callServiceTool("method_changes.apply", {
          confirmedByUser: true,
          confirmationId: artifactRequest.confirmationId,
          ...artifactApplyPayload,
        }, context),
        /必须发布的工作空间文件未能全部发布/
      );
    } finally {
      __setServiceToolFailureInjection();
    }
    assert.equal((await methodChangeBackend.get(userId, instanceId, artifactCandidate.id))?.status, "confirmed");
    const [pendingArtifact] = await db.select().from(pendingSandboxConfirmations).where(eq(
      pendingSandboxConfirmations.id,
      artifactRequest.confirmationId,
    ));
    assert.equal(pendingArtifact?.status, "pending");
    const artifactRecoveryResult = await callServiceTool("method_changes.apply", {
      confirmedByUser: true,
      confirmationId: artifactRequest.confirmationId,
      ...artifactApplyPayload,
    }, context) as { ok: boolean; artifacts?: Array<{ relativePath: string }> };
    assert.equal(artifactRecoveryResult.ok, true);
    assert.deepEqual(artifactRecoveryResult.artifacts?.map((artifact) => artifact.relativePath), ["config/strategy.yaml"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
