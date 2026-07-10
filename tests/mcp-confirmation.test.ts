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
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
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

    const payload = { step: "style", summary: "保存趋势辅助型风格" };
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

    await assert.rejects(
      () => callServiceTool("onboarding.confirm_step", {
        confirmedByUser: true,
        confirmationId: requested.confirmationId,
        ...payload,
      }, context),
      /pending confirmation is unavailable/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
