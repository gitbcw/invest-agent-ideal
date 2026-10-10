import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("strategy.rollback restores an immutable version as a new current version", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-strategy-rollback-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { ensureWorkspace, resolveWorkspacePath } = await import("../src/lib/workspace.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const userId = "strategy-rollback-user";
    const instanceId = "strategy-rollback-instance";
    const conversationId = "strategy-rollback-conversation";
    const now = new Date().toISOString();
    const context = { userId, instanceId, projectId: "invest-agent", conversationId, workspacePath: resolveWorkspacePath(userId) };
    initDb();
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    await db.insert(conversationSessions).values({ conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId, channel: "web", title: "strategy rollback", createdAt: now, updatedAt: now });
    const oldStrategy = { profile: { style: "balanced", risk_preference: "medium", markets: [] }, allocation: { cash_percent: 30 }, notes: "old" };
    sqlite.prepare("INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(userId, "invest-agent", instanceId, JSON.stringify({ ...oldStrategy, last_strategy_version_id: "v_old" }), "service-owned://strategy", "seed", now, "test", now, now);
    sqlite.prepare("INSERT INTO strategy_versions (version_id,user_id,project_id,instance_id,strategy_json,parent_version_id,change_kind,source_candidate_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("v_old", userId, "invest-agent", instanceId, JSON.stringify(oldStrategy), null, "baseline", null, now);

    const requested = await callServiceTool("confirmations.request", {
      operation: "strategy.rollback",
      payload: { versionId: "v_old", expectedCurrentVersionId: "v_old", reason: "回到已确认版本" },
      summary: "回滚策略到旧版本",
    }, context) as { confirmationId: string };
    await db.insert(conversationMessages).values({ messageId: "strategy-rollback-confirm", conversationId, userId, projectId: "invest-agent", instanceId, assistantId: instanceId, channel: "web", role: "user", content: "确认回滚", createdAt: new Date(Date.now() + 1000).toISOString() });

    const result = await callServiceTool("strategy.rollback", {
      confirmedByUser: true,
      confirmationId: requested.confirmationId,
      versionId: "v_old",
      expectedCurrentVersionId: "v_old",
      reason: "回到已确认版本",
    }, context) as { ok: boolean; rolledBackToVersionId: string; currentVersionId: string; strategy: Record<string, unknown> };
    assert.equal(result.ok, true);
    assert.equal(result.rolledBackToVersionId, "v_old");
    assert.notEqual(result.currentVersionId, "v_old");
    assert.equal((result.strategy as any).notes, "old");
    const versions = await callServiceTool("strategy.versions.read", undefined, context) as { currentVersionId: string; items: Array<{ versionId: string; changeKind: string }> };
    assert.equal(versions.currentVersionId, result.currentVersionId);
    assert.ok(versions.items.some((item) => item.versionId === "v_old"));
    assert.ok(versions.items.some((item) => item.versionId === result.currentVersionId && item.changeKind === "rollback"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
