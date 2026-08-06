import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-assets-mcp-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const assets = await import("../src/services/user-assets.js");
  const tools = await import("../src/mcp/service-tools-core.js");
  return { db, assets, tools };
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

function bindConversationAsset(db: any, assetId: string, versionId: string) {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    INSERT INTO conversation_artifacts
      (artifact_id, user_id, instance_id, project_id, assistant_id, conversation_id, source, kind, preview_mode, title, file_name, mime_type, relative_path, size_bytes, checksum, asset_id, version_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'conversation', 'document', 'text', 'Bound asset', 'bound.md', 'text/markdown', 'reports/bound.md', 1, ?, ?, ?, ?, ?)
  `).run(`artifact_${assetId}`, scope.userId, scope.instanceId, scope.projectId, scope.instanceId, scope.conversationId, "0".repeat(64), assetId, versionId, now, now);
}

test("MCP asset tools are scope-bound, confirmation-gated, and path-free", async () => {
  const { db, assets, tools } = await fixture;
  seedConversation(db);
  const created = await assets.createUserAsset({
    ...scope,
    fileName: "mcp.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# original\n"),
  });
  bindConversationAsset(db, created.assetId, created.currentVersionId!);
  const read = await tools.callServiceTool("assets.version.read", { assetId: created.assetId }, scope);
  assert.equal((read as any).ok, true);
  assert.equal(Buffer.from((read as any).base64, "base64").toString(), "# original\n");
  assert.equal("storagePath" in ((read as any).version || {}), false);
  assert.equal("userId" in ((read as any).asset || {}), false);

  await assert.rejects(
    () => tools.callServiceTool("assets.conversation.save", {
      fileName: "saved.md",
      mimeType: "text/markdown",
      base64: Buffer.from("# saved\n").toString("base64"),
    }, scope),
    (error: unknown) => (error as { code?: string }).code === "ASSET_CONFIRMATION_REQUIRED",
  );

  const savePayload = {
    fileName: "saved.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# saved\n").toString("base64"),
  };
  const saveConfirmation = await tools.callServiceTool("confirmations.request", {
    operation: "assets.conversation.save",
    payload: savePayload,
  }, scope) as any;
  addUserConfirmation(db, "asset-mcp-save-confirmation", "确认保存");
  const saved = await tools.callServiceTool("assets.conversation.save", {
    ...savePayload,
    confirmationId: saveConfirmation.confirmationId,
    confirmedByUser: true,
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
  const commitConfirmation = await tools.callServiceTool("confirmations.request", {
    operation: "assets.version.commit",
    payload: commitPayload,
  }, scope) as any;
  addUserConfirmation(db, "asset-mcp-commit-confirmation", "确认提交");
  const submitted = await tools.callServiceTool("assets.version.commit", {
    ...commitPayload,
    confirmationId: commitConfirmation.confirmationId,
    confirmedByUser: true,
  }, scope) as any;
  assert.equal(submitted.ok, true);
  assert.notEqual(submitted.asset.currentVersionId, created.currentVersionId);
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
