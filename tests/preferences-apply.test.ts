import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("preferences.apply updates confirmed schedule and notification settings", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-preferences-"));
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
    const { callServiceTool, __setServiceToolFailureInjection } = await import("../src/mcp/service-tools-core.js");
    const { findArtifactsForTurn } = await import("../src/services/conversation-artifacts.js");
    const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");

    const userId = "preferences-apply-user";
    const instanceId = "preferences-apply-instance";
    const conversationId = "preferences-apply-conversation";
    const revision = "2026-08-01T11:00:00.000Z";
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
    await store.writeSchedules({
      timezone: "Asia/Shanghai",
      daily_review: { default_time: "19:00", trading_days_only: true },
      market_watch: { default_windows: ["09:55", "11:20", "14:30"], only_push_on_exception: true },
      last_confirmed_at: revision,
    });
    await store.writeNotification({
      preference: { mode: "low_disturbance" },
      last_confirmed_at: revision,
    });
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      title: "Preferences apply contract",
      createdAt: revision,
      updatedAt: revision,
    });

    const payload = {
      expectedLastConfirmedAt: revision,
      reviewSchedule: { daily_review: { default_time: "20:00" } },
      marketWatchSchedule: { default_windows: ["10:00", "14:00"] },
      notificationPreference: { mode: "active_watch" },
    };
    const requested = await callServiceTool("confirmations.request", {
      operation: "preferences.apply",
      payload,
      summary: "请确认修改提醒设置",
    }, context) as { confirmationId: string; preview: { changedPaths: string[] } };
    assert.deepEqual(requested.preview.changedPaths.sort(), ["config/notification.yaml", "config/schedules.yaml"]);

    await db.insert(conversationMessages).values({
      messageId: "preferences-apply-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认修改",
      createdAt: new Date(Date.now() + 2_000).toISOString(),
    });

    const turnId = "preferences-apply-turn";
    markTurnStart({ userId, instanceId, conversationId, turnId });
    let result: { ok: boolean; changedPaths: string[]; artifacts?: Array<{ relativePath: string }> };
    try {
      result = await callServiceTool("preferences.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context) as typeof result;
    } finally {
      markTurnEnd({ userId, instanceId, conversationId, turnId });
    }
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedPaths.sort(), ["config/notification.yaml", "config/schedules.yaml"]);
    assert.equal((await store.readSchedules())?.daily_review?.default_time, "20:00");
    assert.deepEqual((await store.readSchedules())?.market_watch?.default_windows, ["10:00", "14:00"]);
    assert.equal((await store.readNotification())?.preference?.mode, "active_watch");
    assert.equal((await store.readSchedules())?.market_watch?.push_mode, "scheduled_intraday_brief");
    assert.deepEqual(result.artifacts?.map((artifact) => artifact.relativePath).sort(), ["config/notification.yaml", "config/schedules.yaml"]);

    const audits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "preferences.apply"),
      eq(sandboxAuditLogs.status, "success"),
    ));
    assert.equal(audits.length, 1);
    const artifacts = findArtifactsForTurn({ userId, instanceId, conversationId, turnId });
    assert.equal(artifacts.length, 2);
    await assert.rejects(
      () => callServiceTool("preferences.apply", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /pending confirmation is unavailable/
    );

    const recoveryRevision = (await store.readSchedules())?.last_confirmed_at ?? null;
    const recoveryPayload = {
      expectedLastConfirmedAt: recoveryRevision,
      reviewSchedule: { daily_review: { default_time: "21:00" } },
    };
    const recoveryRequest = await callServiceTool("confirmations.request", {
      operation: "preferences.apply",
      payload: recoveryPayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "preferences-apply-recovery-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认修改",
      createdAt: new Date(Date.now() + 3_000).toISOString(),
    });
    const originalAppendChangeLog = WorkspaceStore.prototype.appendChangeLog;
    let failChangeLogOnce = true;
    WorkspaceStore.prototype.appendChangeLog = async function (record: unknown) {
      if (failChangeLogOnce && (record as { type?: string }).type === "user_preferences_applied") {
        failChangeLogOnce = false;
        throw new Error("injected preference change log failure");
      }
      return originalAppendChangeLog.call(this, record);
    };
    try {
      await assert.rejects(
        () => callServiceTool("preferences.apply", {
          confirmedByUser: true,
          confirmationId: recoveryRequest.confirmationId,
          ...recoveryPayload,
        }, context),
        /injected preference change log failure/
      );
    } finally {
      WorkspaceStore.prototype.appendChangeLog = originalAppendChangeLog;
    }
    assert.equal((await store.readSchedules())?.daily_review?.default_time, "21:00");
    const [pendingRecovery] = await db.select().from(pendingSandboxConfirmations).where(
      eq(pendingSandboxConfirmations.id, recoveryRequest.confirmationId),
    );
    assert.equal(pendingRecovery?.status, "pending");
    const recoveryResult = await callServiceTool("preferences.apply", {
      confirmedByUser: true,
      confirmationId: recoveryRequest.confirmationId,
      ...recoveryPayload,
    }, context) as { ok: boolean; artifacts?: Array<{ relativePath: string }> };
    assert.equal(recoveryResult.ok, true);
    assert.deepEqual(recoveryResult.artifacts?.map((artifact) => artifact.relativePath), ["config/schedules.yaml"]);

    const artifactRevision = (await store.readSchedules())?.last_confirmed_at ?? null;
    const artifactPayload = {
      expectedLastConfirmedAt: artifactRevision,
      reviewSchedule: { daily_review: { default_time: "22:00" } },
    };
    const artifactRequest = await callServiceTool("confirmations.request", {
      operation: "preferences.apply",
      payload: artifactPayload,
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: "preferences-apply-artifact-confirmation-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认修改",
      createdAt: new Date(Date.now() + 4_000).toISOString(),
    });
    __setServiceToolFailureInjection({
      artifactPublish: (relativePath) => relativePath === "config/schedules.yaml"
        ? new Error("injected preference artifact failure")
        : undefined,
    });
    try {
      await assert.rejects(
        () => callServiceTool("preferences.apply", {
          confirmedByUser: true,
          confirmationId: artifactRequest.confirmationId,
          ...artifactPayload,
        }, context),
        /必须发布的工作空间文件未能全部发布/
      );
    } finally {
      __setServiceToolFailureInjection();
    }
    assert.equal((await store.readSchedules())?.daily_review?.default_time, "22:00");
    const artifactRecoveryResult = await callServiceTool("preferences.apply", {
      confirmedByUser: true,
      confirmationId: artifactRequest.confirmationId,
      ...artifactPayload,
    }, context) as { ok: boolean; artifacts?: Array<{ relativePath: string }> };
    assert.equal(artifactRecoveryResult.ok, true);
    assert.deepEqual(artifactRecoveryResult.artifacts?.map((artifact) => artifact.relativePath), ["config/schedules.yaml"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
