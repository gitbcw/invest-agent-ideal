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
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const tools = await import("../src/mcp/service-tools-core.js");
  const automation = await import("../src/services/automation-tasks.js");
  const assets = await import("../src/services/user-assets.js");
  const classification = await import("../src/mcp/service-tool-classification.js");
  return { tools, automation, assets, classification };
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
