import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * WP3 运行诊断链样例（契约：docs/run-diagnostic-view-contract.md）：
 * 1. Portal 对话链：确认写（method_changes.apply）→ audit 带 trace_id → trace → 会话 → artifact；
 * 2. scheduler/push 链：scheduled run ↔ trace(runId) ↔ push(originRunId) ↔ delivery；
 * 全程显式 ID 关联断言 + n.a. 语义 + 缺失关联计数。
 */

test("run diagnostic chain resolves portal conversation and scheduler/push chains by explicit ids", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-run-diagnostic-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { eq } = await import("drizzle-orm");
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { recordSandboxAudit } = await import("../src/lib/sandbox-audit.js");
    const { buildRunDiagnostic } = await import("../src/services/run-diagnostic.js");

    const userId = "run-diagnostic-user";
    const instanceId = "run-diagnostic-instance";
    const conversationId = "run-diagnostic-conversation";
    const traceId = "run-diagnostic-message-0001";
    const revision = "2026-08-24T08:00:00.000Z";

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });

    // ── 样例链 1：Portal 对话 + 确认写 + audit(trace_id) + trace + artifact ──
    const seedStrategy = {
      profile: { style: "balanced", risk_preference: "medium" },
      allocation: { cash_percent: 30 },
      notes: "diagnostic seed",
      last_confirmed_at: revision,
    };
    sqlite.prepare(
      `INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(userId, "invest-agent", instanceId, JSON.stringify(seedStrategy), "service-owned://strategy", "service:test-seed", revision, "test-seed", revision, revision);
    await db.insert(conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "web", title: "Run diagnostic chain", createdAt: revision, updatedAt: revision,
    });
    await db.insert(conversationMessages).values({
      messageId: `${traceId}-user`, conversationId, userId, projectId: "invest-agent", instanceId,
      assistantId: instanceId, channel: "web", role: "user", content: "确认采用策略变更", createdAt: revision,
    });

    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      traceId,
      workspacePath: resolveWorkspacePath(userId),
    };
    const candidate = await methodChangeBackend.propose({
      userId, instanceId, sourceType: "review",
      proposedChange: "提高现金比例", reason: "诊断链样例", affectedResource: "strategy",
    });
    const payload = {
      candidateId: candidate.id,
      expectedLastConfirmedAt: revision,
      strategyPatch: { notes: "diagnostic applied" },
    };
    const requested = await callServiceTool("confirmations.request", {
      operation: "method_changes.apply",
      payload,
      summary: "请确认采用策略变更",
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({
      messageId: `${traceId}-confirm`, conversationId, userId, projectId: "invest-agent", instanceId,
      assistantId: instanceId, channel: "web", role: "user", content: "确认",
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const applied = await callServiceTool("method_changes.apply", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...payload,
    }, context) as { ok: boolean };
    assert.equal(applied.ok, true);

    // 真实穿线断言：apply 的 audit 行带 trace_id（WP3 显式关联）。
    const applyAudit = sqlite.prepare(
      "SELECT id, trace_id AS traceId FROM sandbox_audit_logs WHERE operation = 'method_changes.apply' AND user_id = ? ORDER BY id DESC LIMIT 1",
    ).get(userId) as { id: number; traceId: string | null };
    assert.ok(applyAudit, "method_changes.apply audit row exists");
    assert.equal(applyAudit.traceId, traceId);

    // Agent trace + artifact（模拟回合落库与产物交付）。
    await db.insert((await import("../src/db/schema.js")).agentTraces).values({
      traceId, conversationId, messageId: traceId, channel: "web", userText: "调整策略",
      mode: "chat", status: "success", agentBackend: "mastra", agentModel: "test-model",
      createdAt: revision,
    });
    await db.insert((await import("../src/db/schema.js")).conversationArtifacts).values({
      artifactId: "run-diagnostic-artifact-1", userId, instanceId, projectId: "invest-agent",
      assistantId: instanceId, conversationId, messageId: traceId, source: "agent", kind: "markdown",
      previewMode: "text", title: "策略变更说明", fileName: "strategy.md", mimeType: "text/markdown",
      relativePath: "artifacts/strategy.md", sizeBytes: 32, checksum: "deadbeef", createdAt: revision, updatedAt: revision,
    });

    const portalDiagnostic = await buildRunDiagnostic("traceId", traceId);
    assert.equal(portalDiagnostic.entry.resolved, true);
    assert.equal(portalDiagnostic.nodes.traces.length, 1);
    assert.equal(portalDiagnostic.nodes.conversation.session?.conversationId, conversationId);
    assert.ok(portalDiagnostic.nodes.conversation.messages.length >= 2);
    assert.ok(portalDiagnostic.nodes.audits.some((row) => row.operation === "method_changes.apply" && row.correlation === "trace"));
    assert.equal(portalDiagnostic.nodes.artifacts.length, 1);
    // n.a. 语义：Portal 对话链不适用 scheduler/automation/push 节点。
    assert.equal(portalDiagnostic.applicable.scheduler, false);
    assert.equal(portalDiagnostic.applicable.push, false);
    assert.equal(portalDiagnostic.nodes.pushJobs.length, 0);
    assert.equal(portalDiagnostic.missingLinks.auditsWithoutTraceId, 0);
    assert.equal(portalDiagnostic.missingLinks.scheduledRunsWithoutTraceLink, 0);

    // 反向入口：conversationId → 同一条链。
    const byConversation = await buildRunDiagnostic("conversationId", conversationId);
    assert.equal(byConversation.entry.resolved, true);
    assert.equal(byConversation.nodes.traces.length, 1);
    assert.ok(byConversation.nodes.audits.length >= 1);

    // ── 样例链 2：scheduler run ↔ trace(runId) ↔ push(originRunId) ↔ delivery ──
    const taskKey = "2026-08-24:market-watch:run-diagnostic-user:run-diagnostic-instance:10:00";
    const pushJobId = "run-diagnostic-push-1";
    const schedulerTraceId = "run-diagnostic-scheduler-message-0001";
    const schedulerConversation = `scheduler:market-watch:${userId}:${instanceId}`;
    await db.insert((await import("../src/db/schema.js")).scheduledTaskRuns).values({
      taskKey, taskType: "market-watch", userId, projectId: "invest-agent", instanceId,
      scheduledFor: "2026-08-24:1000", status: "success",
      claimedAt: revision, finishedAt: revision, pushJobId, createdAt: revision, updatedAt: revision,
    });
    await db.insert((await import("../src/db/schema.js")).agentTraces).values({
      traceId: schedulerTraceId, runId: taskKey, conversationId: schedulerConversation,
      messageId: schedulerTraceId, channel: "scheduler", userText: "盘中简报", mode: "scheduled-market-watch",
      status: "success", agentBackend: "mastra", agentModel: "test-model", createdAt: revision,
    });
    await db.insert((await import("../src/db/schema.js")).pushJobs).values({
      id: pushJobId, userId, projectId: "invest-agent", instanceId, channel: "weixin-mobile",
      backend: "hermes", source: "scheduler", originRunId: taskKey, originTaskKey: taskKey,
      messageKind: "market_watch", message: "盘中简报正文", status: "sent", attempts: 1,
      maxAttempts: 3, nextRetryAt: revision, sentAt: revision, createdAt: revision, updatedAt: revision,
    });
    await db.insert((await import("../src/db/schema.js")).weixinDeliveryAttempts).values({
      userId, instanceId, pushJobId, source: "hermes", result: "ok", reason: "delivered",
      createdAt: revision,
    });
    // 调度链内的受控写 audit（如 reviews.save）带 trace_id。
    await recordSandboxAudit({
      context: {
        userId, projectId: "invest-agent", instanceId, role: "user", channel: "scheduler",
        backend: "mastra", conversationId: schedulerConversation, permissions: ["review:self"],
      },
      operation: "reviews.save", resourceType: "review", resourceId: "2026-08-24",
      resultSummary: "saved", status: "success", traceId: schedulerTraceId,
    });
    // 一条旧数据 audit（无 trace_id）：只按 conversation 级关联，并计入缺失。
    await recordSandboxAudit({
      context: {
        userId, projectId: "invest-agent", instanceId, role: "user", channel: "scheduler",
        backend: "mastra", conversationId: schedulerConversation, permissions: ["review:self"],
      },
      operation: "legacy.read", resourceType: "review", resultSummary: "legacy row",
      status: "success",
    });

    const schedulerDiagnostic = await buildRunDiagnostic("runId", taskKey);
    assert.equal(schedulerDiagnostic.entry.resolved, true);
    assert.equal(schedulerDiagnostic.nodes.traces.length, 1);
    assert.equal(schedulerDiagnostic.nodes.traces[0].runId, taskKey);
    assert.equal(schedulerDiagnostic.nodes.scheduledRuns.length, 1);
    assert.equal(schedulerDiagnostic.nodes.scheduledRuns[0].taskKey, taskKey);
    assert.equal(schedulerDiagnostic.nodes.pushJobs.length, 1);
    assert.equal(schedulerDiagnostic.nodes.pushJobs[0].id, pushJobId);
    assert.equal(schedulerDiagnostic.nodes.deliveries.length, 1);
    assert.ok(schedulerDiagnostic.nodes.audits.some((row) => row.operation === "reviews.save" && row.correlation === "trace"));
    // 旧数据 audit 只能会话级关联，且计入缺失，不冒充 trace 级证据。
    assert.ok(schedulerDiagnostic.nodes.audits.some((row) => row.operation === "legacy.read" && row.correlation === "conversation"));
    assert.equal(schedulerDiagnostic.missingLinks.auditsWithoutTraceId, 1);
    // n.a. 语义：scheduler 链不适用 Portal artifact 节点。
    assert.equal(schedulerDiagnostic.applicable.scheduler, true);
    assert.equal(schedulerDiagnostic.applicable.push, true);
    assert.equal(schedulerDiagnostic.nodes.artifacts.length, 0);

    // 反向入口：deliveryId（push job id）→ 整条 scheduler 链。
    const byDelivery = await buildRunDiagnostic("deliveryId", pushJobId);
    assert.equal(byDelivery.entry.resolved, true);
    assert.equal(byDelivery.nodes.traces.length, 1);
    assert.equal(byDelivery.nodes.traces[0].runId, taskKey);
    assert.equal(byDelivery.nodes.pushJobs.length, 1);
    assert.equal(byDelivery.nodes.deliveries.length, 1);
    assert.equal(byDelivery.nodes.scheduledRuns.length, 1);

    // 无中生有的入口不解析，也不猜。
    const unresolved = await buildRunDiagnostic("traceId", "no-such-trace");
    assert.equal(unresolved.entry.resolved, false);
    assert.equal(unresolved.nodes.traces.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
