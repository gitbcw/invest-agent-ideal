import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("spreadsheet.create delivers via the canonical artifact-card pipeline (G22)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-spreadsheet-delivery-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
    const { resolveRegisteredMastraProjectRoot } = await import("../src/mastra/workspace-registry.js");
    const { buildChannelContextInstruction } = await import("../src/runtime/agent.js");

    initDb();
    const userId = "delivery-user";
    const instanceId = "invest-agent-delivery-user";
    const projectId = "invest-agent";
    await mastraWorkspaceRegistry.bootstrap({ userId, projectId, instanceId });
    const realProjectRoot = await resolveRegisteredMastraProjectRoot({ userId, projectId, instanceId });
    assert.ok(realProjectRoot, "project root must be registered");

    const result = await callServiceTool("spreadsheet.create", {
      fileName: "持仓概览.xlsx",
      columns: ["代码", "名称", "仓位"],
      rows: [["600519", "贵州茅台", 0.12]],
    }, {
      userId,
      instanceId,
      projectId,
      conversationId: "conv-delivery",
      permissions: ["read:self", "write:self"],
    } as any);

    assert.equal(result.ok, true);
    assert.equal(result.asset.status, "active");

    // Canonical delivery: a conversation artifact bound to this turn, so the
    // assistant message carries the standard artifact card in the Portal.
    assert.ok(result.artifact, "tool result must carry the published artifact");
    assert.equal(result.artifact.kind, "data");
    assert.equal(result.artifact.fileName, "持仓概览.xlsx");
    assert.equal(result.artifact.previewMode, "unsupported");
    assert.equal(existsSync(path.join(realProjectRoot, "deliveries", "持仓概览.xlsx")), true, "delivery copy written under deliveries/");
    const { sqlite } = await import("../src/db/index.js");
    const row = sqlite.prepare("SELECT conversation_id AS cid, turn_id AS turn, asset_id AS asset, version_id AS version FROM conversation_artifacts ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown>;
    assert.equal(row.cid, "conv-delivery");
    assert.equal(row.asset, result.asset.assetId, "artifact linked to the durable My Files asset");
    assert.equal(row.version, result.version.versionId);

    // No link-invention contract: guidance points at the attached card.
    assert.equal(result.delivery.url, undefined);
    assert.ok(result.delivery.instruction.includes("附件卡片"), "guidance must describe the attached card");
    assert.ok(result.delivery.instruction.includes("不要在正文放置任何下载链接"));

    // Web channel instruction reinforces the same contract.
    const webInstruction = buildChannelContextInstruction("web", {});
    assert.ok(webInstruction!.includes("附件卡片"));
    assert.ok(webInstruction!.includes("不要放置任何下载链接"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
