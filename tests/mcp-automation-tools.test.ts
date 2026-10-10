import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mcp-automation-tools-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// E8: the mastra registry is the only storage root; isolate it per run.
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const tools = await import("../src/mcp/service-tools-core.js");
  const automation = await import("../src/services/automation-tasks.js");
  const assets = await import("../src/services/user-assets.js");
  const classification = await import("../src/mcp/service-tool-classification.js");
  // E8: register the asset-writing scopes before any storage resolution.
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  await registerTestProject({ userId: "mcp-direct-automation-a", projectId: "invest-agent", instanceId: "mcp-direct-automation-instance-a" });
  await registerTestProject({ userId: "mcp-direct-automation-b", projectId: "invest-agent", instanceId: "mcp-direct-automation-instance-b" });
  return { tools, automation, assets, classification, db };
})();

const scopeA = {
  userId: "mcp-direct-automation-a",
  projectId: "invest-agent",
  instanceId: "mcp-direct-automation-instance-a",
  conversationId: "mcp-direct-automation-conversation-a",
};
const scopeB = {
  ...scopeA,
  userId: "mcp-direct-automation-b",
  instanceId: "mcp-direct-automation-instance-b",
};

function schedule() {
  return { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" };
}

function seedConversation(db: any, scope: typeof scopeA) {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    INSERT OR IGNORE INTO conversation_sessions
      (conversation_id, user_id, project_id, instance_id, assistant_id, channel, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'web', 'Automation MCP delete contract', ?, ?)
  `).run(scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, now, now);
}

function addUserConfirmation(db: any, scope: typeof scopeA, messageId: string, content: string) {
  db.sqlite.prepare(`
    INSERT INTO conversation_messages
      (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'web', 'user', ?, ?)
  `).run(messageId, scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, content, new Date(Date.now() + 1_000).toISOString());
}

function createPayload(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    taskId,
    name: taskId,
    instruction: "按最新数据维护这张投资跟踪表。",
    schedule: schedule(),
    output: { mode: "none" },
    ...extra,
  };
}

test("direct automation MCP tools are classified and dispatchable", async () => {
  const { tools, classification } = await fixture;
  assert.equal(classification.classifyServiceTool("automation.create"), "other-write");
  assert.equal(classification.classifyServiceTool("automation.delete"), "other-write");
  assert.equal(classification.classifyServiceTool("automation.list"), "read");
  const result = await tools.callServiceTool("automation.list", {}, scopeA) as { ok: boolean; items: unknown[] };
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.items));
});
test("direct create derives scope and activates a complete task in one call", async () => {
  const { tools, automation } = await fixture;
  const result = await tools.callServiceTool("automation.create", {
    ...createPayload("mcp-direct-create-active"),
    userId: scopeB.userId,
    projectId: "attacker-project",
    instanceId: scopeB.instanceId,
  }, scopeA) as any;
  assert.equal(result.ok, true);
  assert.equal(result.task.status, "active");
  assert.equal(result.task.userId, scopeA.userId);
  assert.equal(result.task.projectId, scopeA.projectId);
  assert.equal(result.task.instanceId, scopeA.instanceId);
  assert.equal((await automation.getAutomationTask({ ...scopeA, taskId: result.task.taskId }))?.status, "active");

  const audits = await automation.listAutomationTaskAuditLogs({ ...scopeA, taskId: result.task.taskId });
  assert.ok(audits.some((audit) => audit.action === "task.created"));
  assert.ok(audits.some((audit) => audit.action === "task.activated"));
});

test("asset discovery and task listing/get are isolated by service scope", async () => {
  const { tools, assets } = await fixture;
  const assetA = await assets.createUserAsset({ ...scopeA, name: "A tracking table", fileName: "a.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1500\n") });
  await assets.createUserAsset({ ...scopeB, name: "B private table", fileName: "b.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n000001,10\n") });

  const listedA = await tools.callServiceTool("assets.list", { userId: scopeB.userId, instanceId: scopeB.instanceId }, scopeA) as any;
  assert.equal(listedA.ok, true);
  assert.deepEqual(listedA.items.map((item: any) => item.assetId), [assetA.assetId]);
  assert.equal("storagePath" in (listedA.items[0].currentVersion || {}), false);

  const listedTasks = await tools.callServiceTool("automation.list", {}, scopeA) as any;
  assert.ok(listedTasks.items.every((item: any) => item.userId === scopeA.userId && item.instanceId === scopeA.instanceId));
  const fetched = await tools.callServiceTool("automation.get", { taskId: "mcp-direct-create-active", userId: scopeB.userId }, scopeA) as any;
  assert.equal(fetched.task.userId, scopeA.userId);
});

test("updating an active task keeps it active, while pause is explicit", async () => {
  const { tools } = await fixture;
  const created = await tools.callServiceTool("automation.create", createPayload("mcp-direct-update-active"), scopeA) as any;
  const updated = await tools.callServiceTool("automation.update", {
    taskId: created.task.taskId,
    expectedRevision: created.task.currentRevision,
    name: "更新后的任务",
  }, scopeA) as any;
  assert.equal(updated.task.status, "active");
  assert.equal(updated.task.currentRevision, created.task.currentRevision + 1);

  const paused = await tools.callServiceTool("automation.pause", { taskId: created.task.taskId }, scopeA) as any;
  assert.equal(paused.task.status, "paused");
  const explicitlyPaused = await tools.callServiceTool("automation.update", {
    taskId: created.task.taskId,
    expectedRevision: paused.task.currentRevision,
    description: "稍后再启用",
    status: "paused",
  }, scopeA) as any;
  assert.equal(explicitlyPaused.task.status, "paused");
});

test("automation.delete requires an explicit user confirmation", async () => {
  const { tools, automation } = await fixture;
  const created = await tools.callServiceTool("automation.create", createPayload("mcp-direct-delete-guard"), scopeA) as any;
  assert.equal(created.ok, true);
  await assert.rejects(
    () => tools.callServiceTool("automation.delete", { taskId: created.task.taskId }, scopeA),
    /confirmedByUser|confirmationId/i,
  );
  assert.equal((await automation.getAutomationTask({ ...scopeA, taskId: created.task.taskId }))?.status, "active");
});

test("confirmed automation.delete soft-deletes the task and hides it from the default list", async () => {
  const { db, tools, automation } = await fixture;
  seedConversation(db, scopeA);
  const created = await tools.callServiceTool("automation.create", createPayload("mcp-direct-delete-flow"), scopeA) as any;
  assert.equal(created.ok, true);

  const requested = await tools.callServiceTool("confirmations.request", {
    operation: "automation.delete",
    payload: { taskId: created.task.taskId },
  }, scopeA) as any;
  assert.equal(requested.ok, true);
  assert.ok(requested.confirmationId);

  addUserConfirmation(db, scopeA, "mcp-automation-delete-confirmation", "确认删除");
  const deleted = await tools.callServiceTool("automation.delete", {
    taskId: created.task.taskId,
    confirmationId: requested.confirmationId,
    confirmedByUser: true,
  }, scopeA) as any;
  assert.equal(deleted.ok, true);
  assert.equal(deleted.task.status, "deleted");

  const audits = await automation.listAutomationTaskAuditLogs({ ...scopeA, taskId: created.task.taskId });
  assert.ok(audits.some((audit) => audit.action === "task.deleted"));

  const listed = await tools.callServiceTool("automation.list", {}, scopeA) as any;
  assert.ok(listed.items.every((item: any) => item.taskId !== created.task.taskId));
  const withDeleted = await tools.callServiceTool("automation.list", { statuses: ["deleted"] }, scopeA) as any;
  assert.ok(withDeleted.items.some((item: any) => item.taskId === created.task.taskId && item.status === "deleted"));

  // 终态与幂等：重复删除返回同一 deleted 记录，已删任务不能再被更新或启用。
  const again = await automation.deleteAutomationTask({ ...scopeA, taskId: created.task.taskId });
  assert.equal(again.status, "deleted");
  await assert.rejects(
    () => automation.pauseAutomationTask({ ...scopeA, taskId: created.task.taskId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_DELETED",
  );
});

test("automation.delete is rejected across service scopes", async () => {
  const { tools, automation } = await fixture;
  const created = await tools.callServiceTool("automation.create", createPayload("mcp-direct-delete-scope"), scopeB) as any;
  assert.equal(created.ok, true);
  // 登记入口的业务校验先拦：跨 scope 的 taskId 在 scopeA 不可执行。
  await assert.rejects(
    () => tools.callServiceTool("confirmations.request", {
      operation: "automation.delete",
      payload: { taskId: created.task.taskId },
    }, scopeA),
    /确认草案不可执行/,
  );
  await assert.rejects(
    () => automation.deleteAutomationTask({ ...scopeA, taskId: created.task.taskId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
  );
  assert.equal((await automation.getAutomationTask({ ...scopeB, taskId: created.task.taskId }))?.status, "active");
});
