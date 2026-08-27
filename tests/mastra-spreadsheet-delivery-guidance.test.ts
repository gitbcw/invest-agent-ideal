import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
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

    // G22 + 文件库治理契约：对话生成的表格是普通聊天交付物——只发附件卡片，
    // 不自动入「我的文件」；用户在卡片点「保存」后才登记资产并占配额。
    assert.equal(result.asset, undefined, "spreadsheet.create must not auto-save to My Files");
    assert.equal(result.version, undefined, "no asset version without an explicit user save");
    assert.equal(result.delivery.savedToMyFiles, false);
    assert.ok(result.artifact, "tool result must carry the published artifact");
    assert.equal(result.artifact.kind, "data");
    assert.equal(result.artifact.fileName, "持仓概览.xlsx");
    assert.equal(result.artifact.previewMode, "unsupported");
    assert.equal(existsSync(path.join(realProjectRoot, "deliveries", "持仓概览.xlsx")), true, "delivery copy written under deliveries/");
    const { sqlite } = await import("../src/db/index.js");
    const row = sqlite.prepare("SELECT conversation_id AS cid, turn_id AS turn, asset_id AS asset, version_id AS version FROM conversation_artifacts ORDER BY created_at DESC LIMIT 1").get() as Record<string, unknown>;
    assert.equal(row.cid, "conv-delivery");
    assert.equal(row.asset, null, "artifact must stay unbound until the user saves it");
    assert.equal(row.version, null);
    const assetRows = sqlite.prepare("SELECT COUNT(*) AS c FROM user_assets WHERE user_id = ?").get(userId) as { c: number };
    assert.equal(assetRows.c, 0, "no user asset may be created by conversational spreadsheet generation");

    // No link-invention contract: guidance points at the attached card.
    assert.equal(result.delivery.url, undefined);
    assert.ok(result.delivery.instruction.includes("附件卡片"), "guidance must describe the attached card");
    assert.ok(result.delivery.instruction.includes("不要在正文放置任何下载链接"));

    // Web channel instruction reinforces the same contract.
    const webInstruction = buildChannelContextInstruction("web", {});
    assert.ok(webInstruction!.includes("附件卡片"));
    assert.ok(webInstruction!.includes("不要放置任何下载链接"));

    // 微信渠道话术分叉：引导去网页端看卡片/保存，而不是让微信用户找卡片。
    const wechatResult = await callServiceTool("spreadsheet.create", {
      fileName: "微信渠道表格.xlsx",
      columns: ["日期"],
      rows: [["2026-08-27"]],
    }, {
      userId,
      instanceId,
      projectId,
      conversationId: "conv-weixin-delivery",
      channel: "weixin-mobile",
      permissions: ["read:self", "write:self"],
    } as any);
    assert.equal(wechatResult.ok, true);
    assert.equal(wechatResult.delivery.location, "conversation_artifact_card");
    assert.equal(wechatResult.delivery.savedToMyFiles, false, "微信渠道同样不自动入库，保存仍由用户在网页端点击");
    assert.ok(wechatResult.delivery.instruction.includes("网页端"), "wechat guidance must point at the Portal");
    assert.ok(wechatResult.delivery.instruction.includes("保存到我的文件"));
    assert.ok(wechatResult.delivery.instruction.includes("不要在正文放置任何下载链接"));

    const stagingPath = path.join(tempRoot, "automation-staging");
    await mkdir(stagingPath, { recursive: true });
    const staged = await callServiceTool("spreadsheet.create", {
      fileName: "自动化复盘.xlsx",
      columns: ["日期", "结论"],
      rows: [["2026-08-21", "完成"]],
    }, {
      userId,
      instanceId,
      projectId,
      conversationId: "automation-run:test",
      runId: "test-run",
      taskType: "scheduled-automation",
      workspacePath: stagingPath,
    });
    assert.deepEqual(staged.stagedOutput, {
      operation: "create",
      fileName: "自动化复盘.xlsx",
      filePath: "自动化复盘.xlsx",
    });
    assert.ok((await readFile(path.join(stagingPath, "自动化复盘.xlsx"))).length > 0);
    assert.equal(staged.artifact, undefined, "automation staging must not publish a conversation artifact");

    const genericAutomationStaging = path.join(tempRoot, "generic-automation-staging");
    await mkdir(genericAutomationStaging, { recursive: true });
    const genericAutomation = await callServiceTool("spreadsheet.create", {
      fileName: "通用自动化复盘.xlsx",
      columns: ["日期", "结论"],
      rows: [["2026-08-23", "完成"]],
    }, {
      userId,
      instanceId,
      projectId,
      conversationId: "automation-run:generic",
      runId: "generic-run",
      taskType: "automation-execution",
      workspacePath: genericAutomationStaging,
    });
    assert.deepEqual(genericAutomation.stagedOutput, {
      operation: "create",
      fileName: "通用自动化复盘.xlsx",
      filePath: "通用自动化复盘.xlsx",
    });
    assert.ok((await readFile(path.join(genericAutomationStaging, "通用自动化复盘.xlsx"))).length > 0);
    assert.equal(genericAutomation.artifact, undefined, "generic automation staging must not publish a conversation artifact");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
