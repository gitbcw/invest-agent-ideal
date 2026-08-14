import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Onboarding step tools (confirm_step / complete_watch_setup / draft.accept+)
// were retired with the preset-model onboarding (D14); this contract now uses
// surviving confirmed-write tools to verify the durable confirmation gate.

test("MCP durable writes consume an exact, later-turn confirmation once", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mcp-confirmation-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb } = await import("../src/db/index.js");
    const { pendingSandboxConfirmations, sandboxAuditLogs } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");

    const userId = "mcp-confirmation-test";
    const instanceId = "invest-agent-mcp-confirmation-test";
    const conversationId = "mcp-confirmation-conversation";
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };

    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    const now = new Date().toISOString();
    await db.insert((await import("../src/db/schema.js")).conversationSessions).values({
      conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId,
      channel: "weixin-mobile", title: "Confirmation contract", createdAt: now, updatedAt: now,
    });

    const draft = { name: "贵州茅台", code: "600519", reason: "用户主动要求加入自选股" };
    const requested = await callServiceTool("confirmations.request", {
      operation: "watchlist.add",
      payload: draft,
      summary: "请确认加入自选股",
    }, context) as { ok: boolean; confirmationId: string };
    assert.equal(requested.ok, true);
    const [pending] = await db.select().from(pendingSandboxConfirmations).where(eq(pendingSandboxConfirmations.id, requested.confirmationId));
    assert.equal(pending?.requestBody, JSON.stringify(draft));
    const audits = await db.select().from(sandboxAuditLogs).where(eq(sandboxAuditLogs.userId, userId));
    assert.ok(audits.some((row) => row.resultSummary?.includes("watchlist.add")), "confirmation requests must be audited");

    await assert.rejects(
      () => callServiceTool("watchlist.add", { confirmedByUser: true, ...draft }, context),
      /confirmationId is required/,
    );

    const confirmedAt = new Date(Date.now() + 1_000).toISOString();
    await db.insert((await import("../src/db/schema.js")).conversationMessages).values({
      messageId: "mcp-confirmation-user-message",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      role: "user",
      content: "确认",
      createdAt: confirmedAt,
    });

    await assert.rejects(
      () => callServiceTool("watchlist.add", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...draft,
      }, { ...context, instanceId: "invest-agent-other-instance" }),
      /pending confirmation is unavailable/,
    );

    await assert.rejects(
      () => callServiceTool("watchlist.add", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...draft,
        reason: "被篡改的草案",
      }, context),
      /confirmation payload mismatch/,
    );

    const saved = await callServiceTool("watchlist.add", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      ...draft,
    }, context) as { ok: boolean };
    assert.equal(saved.ok, true);

    await assert.rejects(
      () => callServiceTool("watchlist.add", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...draft,
      }, context),
      /pending confirmation is unavailable/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
