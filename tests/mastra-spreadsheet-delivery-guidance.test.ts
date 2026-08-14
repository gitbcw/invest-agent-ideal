import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("spreadsheet.create result carries My Files delivery guidance instead of any fabricated link (G22)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-spreadsheet-delivery-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
    const { buildChannelContextInstruction } = await import("../src/runtime/agent.js");

    initDb();
    const userId = "delivery-user";
    const instanceId = "invest-agent-delivery-user";
    const projectId = "invest-agent";
    await mastraWorkspaceRegistry.bootstrap({ userId, projectId, instanceId });

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
    assert.equal(result.delivery.location, "portal_my_files");
    assert.ok(result.delivery.url, "delivery must provide a real clickable URL");
    assert.match(result.delivery.url, /^\/api\/assets\/[^/]+\/versions\/[^/]+\/download$/);
    assert.ok(result.delivery.instruction.includes(result.delivery.url), "instruction must embed the exact URL for the agent to reuse");
    assert.ok(result.delivery.instruction.includes("Markdown 链接"), "guidance must mandate a markdown link in the reply");
    assert.ok(result.delivery.instruction.includes("sandbox:/mnt/data"), "guidance must explicitly forbid fabricated sandbox links");
    assert.ok(result.delivery.instruction.includes("我的文件"), "guidance must still mention My Files as the durable entry");

    // The web channel instruction reinforces the same contract.
    const webInstruction = buildChannelContextInstruction("web", {});
    assert.ok(webInstruction!.includes("delivery.url"), "web instruction must anchor on the tool-provided URL");
    assert.ok(webInstruction!.includes("严禁编造"), "web instruction must still forbid fabricated links");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
