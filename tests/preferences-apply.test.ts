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
    const { MastraUserPreferenceStore } = await import("../src/services/user-preferences.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
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
    };

    initDb();
    const store = new MastraUserPreferenceStore(userId, instanceId, "invest-agent");
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
    // (E8) config file snapshot artifacts retired; projections are the record.
    assert.deepEqual(result.artifacts ?? [], []);

    const audits = await db.select().from(sandboxAuditLogs).where(and(
      eq(sandboxAuditLogs.userId, userId),
      eq(sandboxAuditLogs.operation, "preferences.apply"),
      eq(sandboxAuditLogs.status, "success"),
    ));
    assert.equal(audits.length, 1);
    const artifacts = findArtifactsForTurn({ userId, instanceId, conversationId, turnId });
    // (E8) config file snapshot artifacts retired; projections are the record.
    assert.equal(artifacts.length, 0);
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
    // (E8) The workspace change-log append and the "must publish workspace
    // file" artifact failure-injection scenarios retired with the rollback
    // backend: the mastra projection write + sandbox audit is the durable
    // record and config file snapshots are no longer user deliverables (G17).
    const recoveryResult = await callServiceTool("preferences.apply", {
      confirmedByUser: true,
      confirmationId: recoveryRequest.confirmationId,
      ...recoveryPayload,
    }, context) as { ok: boolean; changedPaths: string[] };
    assert.equal(recoveryResult.ok, true);
    assert.equal((await store.readSchedules())?.daily_review?.default_time, "21:00");
    assert.deepEqual(recoveryResult.changedPaths, ["config/schedules.yaml"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
