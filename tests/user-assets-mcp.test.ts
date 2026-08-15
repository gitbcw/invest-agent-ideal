import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-assets-mcp-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// E8: the mastra registry is the only storage root; isolate it per run.
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const assets = await import("../src/services/user-assets.js");
  // E8: asset storage roots resolve to registered mastra project roots.
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectRoot = await registerTestProject({
    userId: "mcp-asset-user",
    projectId: "invest-agent",
    instanceId: "mcp-asset-instance",
  });
  const tools = await import("../src/mcp/service-tools-core.js");
  return { db, assets, tools, projectRoot };
})();

const scope = {
  userId: "mcp-asset-user",
  projectId: "invest-agent",
  instanceId: "mcp-asset-instance",
  conversationId: "conversation-asset-1",
};

function seedConversation(db: any) {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    INSERT OR IGNORE INTO conversation_sessions
      (conversation_id, user_id, project_id, instance_id, assistant_id, channel, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'web', 'Asset MCP contract', ?, ?)
  `).run(scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, now, now);
}

function addUserConfirmation(db: any, messageId: string, content: string) {
  db.sqlite.prepare(`
    INSERT INTO conversation_messages
      (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'web', 'user', ?, ?)
  `).run(messageId, scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, content, new Date(Date.now() + 1_000).toISOString());
}

test("MCP asset tools permit same-scope CRUD while keeping delete confirmation-bound", async () => {
  const { db, assets, tools } = await fixture;
  seedConversation(db);
  const created = await assets.createUserAsset({
    ...scope,
    fileName: "mcp.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# original\n"),
  });
  // This asset is intentionally not attached to the current conversation.
  const read = await tools.callServiceTool("assets.version.read", { assetId: created.assetId }, scope);
  assert.equal((read as any).ok, true);
  assert.equal(Buffer.from((read as any).base64, "base64").toString(), "# original\n");
  assert.equal("storagePath" in ((read as any).version || {}), false);
  assert.equal("userId" in ((read as any).asset || {}), false);

  const saved = await tools.callServiceTool("assets.conversation.save", {
    fileName: "saved.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# saved\n").toString("base64"),
  }, scope) as any;
  assert.equal(saved.ok, true);
  assert.equal(saved.asset.currentVersion.source, "conversation");
  assert.equal("storagePath" in saved.asset.currentVersion, false);

  const commitPayload = {
    assetId: created.assetId,
    fileName: "mcp.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# updated\n").toString("base64"),
    expectedVersionId: created.currentVersionId,
  };
  const submitted = await tools.callServiceTool("assets.version.commit", {
    ...commitPayload,
  }, scope) as any;
  assert.equal(submitted.ok, true);
  assert.notEqual(submitted.asset.currentVersionId, created.currentVersionId);

  await assert.rejects(
    () => tools.callServiceTool("assets.version.commit", { ...commitPayload, expectedVersionId: created.currentVersionId }, scope),
    (error: unknown) => (error as { code?: string }).code === "ASSET_VERSION_CONFLICT",
  );

  const renamed = await tools.callServiceTool("assets.rename", {
    assetId: created.assetId,
    name: "Renamed asset",
  }, scope) as any;
  assert.equal(renamed.asset.name, "Renamed asset");

  const archived = await tools.callServiceTool("assets.archive", { assetId: created.assetId }, scope) as any;
  assert.equal(archived.asset.status, "archived");

  await assert.rejects(
    () => tools.callServiceTool("assets.delete", { assetId: created.assetId }, scope),
    /confirmedByUser|confirmationId/i,
  );
  const deleteConfirmation = await tools.callServiceTool("confirmations.request", {
    operation: "assets.delete",
    payload: { assetId: created.assetId },
  }, scope) as any;
  addUserConfirmation(db, "asset-mcp-delete-confirmation", "确认删除");
  const deleted = await tools.callServiceTool("assets.delete", {
    assetId: created.assetId,
    confirmationId: deleteConfirmation.confirmationId,
    confirmedByUser: true,
  }, scope) as any;
  assert.equal(deleted.ok, true);
  assert.equal(await assets.getUserAsset({ ...scope, assetId: created.assetId }), null);
});

test("MCP promotes an active same-scope conversation attachment into My Files", async () => {
  const { db, tools, projectRoot } = await fixture;
  seedConversation(db);
  const { registerAttachment } = await import("../src/services/file-retention.js");
  const bytes = Buffer.from("date,freight_index\n2026-08-08,1200\n");
  // E8: the attachment file lives inside the registered mastra project root.
  const workspace = projectRoot;
  const relativePath = "attachments/2026-08-08/att_promote_freight.csv";
  const fullPath = path.join(workspace, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
  registerAttachment({
    userId: scope.userId,
    instanceId: scope.instanceId,
    conversationId: scope.conversationId,
    stored: {
      id: "att_promote_freight",
      type: "document",
      mimeType: "text/csv",
      fileName: "freight-tracker.csv",
      sizeBytes: bytes.length,
      path: fullPath,
      relativePath,
      source: "portal",
      checksum: (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"),
    },
  });

  const promoted = await tools.callServiceTool("assets.attachment.save", {
    attachmentId: "att_promote_freight",
    name: "海运运价跟踪表",
  }, scope) as any;
  assert.equal(promoted.ok, true);
  assert.equal(promoted.asset.name, "海运运价跟踪表");
  assert.equal(promoted.asset.currentVersion.source, "upload");
  assert.equal(promoted.asset.currentVersion.fileName, "freight-tracker.xlsx");
  assert.ok(promoted.asset.assetId);

  await assert.rejects(
    () => tools.callServiceTool("assets.attachment.save", { attachmentId: "att_promote_freight" }, { ...scope, instanceId: "other-instance" }),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
  );
});

test("MCP asset tools reject a cross-scope read", async () => {
  const { assets, tools } = await fixture;
  const created = await assets.createUserAsset({
    ...scope,
    fileName: "private.md",
    bytes: Buffer.from("# private\n"),
  });
  await assert.rejects(
    () => tools.callServiceTool("assets.version.read", { assetId: created.assetId }, {
      ...scope,
      userId: "other-mcp-user",
      instanceId: "other-mcp-instance",
    }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
});

test("MCP automation tools create active tasks without confirmation and enforce scope", async () => {
  const { tools } = await fixture;
  const task = await tools.callServiceTool("automation.create", {
    name: "每日信息表更新",
    instruction: "收集当天的重要行业信息并更新目标表格。",
    schedule: { frequency: "daily", time: "20:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
  }, scope) as any;
  assert.equal(task.ok, true);
  assert.equal(task.task.status, "active");

  const listed = await tools.callServiceTool("automation.list", {}, scope) as any;
  assert.equal(listed.items.some((item: any) => item.taskId === task.task.taskId), true);

  const revised = await tools.callServiceTool("automation.update", {
    taskId: task.task.taskId,
    expectedRevision: task.task.currentRevision,
    instruction: "收集当天的重要行业信息并更新目标表格，保留来源和日期。",
  }, scope) as any;
  assert.equal(revised.ok, true);
  assert.equal(revised.task.status, "active");
  assert.equal(revised.task.currentRevision, task.task.currentRevision + 1);

  await assert.rejects(
    () => tools.callServiceTool("automation.get", { taskId: task.task.taskId }, {
      ...scope,
      userId: "other-mcp-user",
      instanceId: "other-mcp-instance",
    }),
    /not found|scope/i,
  );
});

test("explicitly persistent AI artifacts appear in My Files and reuse versions by report path", async () => {
  const { db, assets, tools, projectRoot } = await fixture;
  seedConversation(db);
  // E8: artifact files live inside the registered mastra project root.
  const reportDirectory = path.join(projectRoot, "reports", "tables");
  const reportPath = path.join(reportDirectory, "weekly-inventory.csv");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, "source,inventory_change\nsmm,-1200\nmysteel,-900\n");

  const first = await tools.callServiceTool("artifacts.publish", {
    relativePath: "reports/tables/weekly-inventory.csv",
    kind: "data",
    title: "碳酸锂去库跟踪表",
    saveToMyFiles: true,
  }, scope) as any;
  const firstAssets = (await assets.listUserAssets(scope)).filter((asset) => asset.name === "碳酸锂去库跟踪表");

  assert.equal(first.ok, true);
  assert.equal(firstAssets.length, 1);
  assert.equal(firstAssets[0].name, "碳酸锂去库跟踪表");
  assert.equal(firstAssets[0].currentVersion?.source, "conversation");
  assert.equal(first.artifact.assetId, firstAssets[0].assetId);
  assert.equal(first.artifact.versionId, firstAssets[0].currentVersionId);

  await writeFile(reportPath, "source,inventory_change\nsmm,-1300\nmysteel,-950\n");
  const second = await tools.callServiceTool("artifacts.publish", {
    relativePath: "reports/tables/weekly-inventory.csv",
    kind: "data",
    title: "碳酸锂去库跟踪表",
    saveToMyFiles: true,
  }, scope) as any;
  const secondAssets = (await assets.listUserAssets(scope)).filter((asset) => asset.name === "碳酸锂去库跟踪表");

  assert.equal(secondAssets.length, 1);
  assert.equal(secondAssets[0].assetId, firstAssets[0].assetId);
  assert.equal(secondAssets[0].currentVersion?.versionNumber, 2);
  assert.equal(second.artifact.assetId, firstAssets[0].assetId);
  assert.notEqual(second.artifact.versionId, first.artifact.versionId);
});
