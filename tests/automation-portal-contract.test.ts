import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-portal-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const connector = await import("../src/portal/connector.js");
  const automation = await import("../src/services/automation-tasks.js");
  return { db, connector, automation };
})();

const scopeA = {
  userId: "portal-automation-a",
  assistantId: "portal-automation-instance-a",
  instanceId: "portal-automation-instance-a",
  projectId: "invest-agent",
  connectorId: "test-connector-a",
  displayName: "test",
};
const scopeB = { ...scopeA, userId: "portal-automation-b", assistantId: "portal-automation-instance-b", instanceId: "portal-automation-instance-b" };

function command(scope: typeof scopeA, type: string, payload: Record<string, unknown> = {}) {
  return { protocolVersion: "2026-07-04", requestId: `req-${Math.random()}`, type, sentAt: new Date().toISOString(), payload };
}

test("Portal connector preserves the registered instance's owning project scope", async () => {
  const { connector } = await fixture;
  const scope = connector.__test__.scopeFromProject({
    instanceId: "invest-agent-112",
    projectId: "invest-agent-112",
    legacyProjectId: "invest-agent",
    ownerUserId: "112",
    name: "112",
  } as never);

  assert.equal(scope.instanceId, "invest-agent-112");
  assert.equal(scope.projectId, "invest-agent");
  assert.equal(scope.userId, "112");
});

test("Portal automation commands use registered scope and expose task/asset contracts", async () => {
  const { connector } = await fixture;
  const malicious = await connector.__test__.handleCommand(scopeA, command(scopeA, "automation.create", {
    userId: scopeB.userId,
    instanceId: scopeB.instanceId,
    name: "Portal 任务",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "portal.csv", mimeType: "text/csv", base64: Buffer.from("a,b\n1,2\n").toString("base64") },
  }) as any);
  assert.equal(malicious.ok, false);
  assert.equal(malicious.error.code, "INVALID_REQUEST");
  const created = await connector.__test__.handleCommand(scopeA, command(scopeA, "automation.create", {
    name: "Portal 任务",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "portal.csv", mimeType: "text/csv", base64: Buffer.from("a,b\n1,2\n").toString("base64") },
  }) as any);
  assert.equal(created.ok, true);
  const task = (created as any).data;
  assert.equal(task.userId, scopeA.userId);
  assert.equal(task.status, "paused");

  const listedA = await connector.__test__.handleCommand(scopeA, command(scopeA, "automation.list")) as any;
  assert.equal(listedA.ok, true);
  assert.equal(listedA.data.items.some((item: any) => item.taskId === task.taskId), true);
  const listedB = await connector.__test__.handleCommand(scopeB, command(scopeB, "automation.list")) as any;
  assert.equal(listedB.ok, true);
  assert.equal(listedB.data.items.some((item: any) => item.taskId === task.taskId), false);

  const asset = await connector.__test__.handleCommand(scopeA, command(scopeA, "automation.asset.get", { assetId: task.sourceAsset.assetId })) as any;
  assert.equal(asset.ok, true);
  assert.equal(Buffer.from(asset.data.base64, "base64").toString("utf8"), "a,b\n1,2\n");
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeB, command(scopeB, "automation.asset.get", { assetId: task.sourceAsset.assetId })),
    /AUTOMATION_SCOPE_MISMATCH/,
  );
});

test("Portal connector rejects cross-user run, run-detail, and continue requests", async () => {
  const { connector, automation } = await fixture;
  const created = await connector.__test__.handleCommand(scopeA, command(scopeA, "automation.create", {
    name: "运行 scope 边界",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "scope.csv", mimeType: "text/csv", base64: Buffer.from("a,b\n1,2\n").toString("base64") },
  }) as any);
  const task = created.data;
  const claimed = await automation.claimAutomationTaskRun({
    userId: scopeA.userId,
    instanceId: scopeA.instanceId,
    projectId: scopeA.projectId,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `scope-run-${task.taskId}`,
  });

  for (const [type, payload] of [
    ["automation.run_now", { taskId: task.taskId }],
    ["automation.run.get", { runId: claimed.run.runId }],
    ["automation.continue_in_chat", { runId: claimed.run.runId }],
  ] as const) {
    await assert.rejects(
      () => connector.__test__.handleCommand(scopeB, command(scopeB, type, payload)),
      (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
      `${type} must reject a run owned by another connector scope`,
    );
  }

  await automation.finishAutomationTaskRun({
    userId: scopeA.userId,
    instanceId: scopeA.instanceId,
    projectId: scopeA.projectId,
    runId: claimed.run.runId,
    leaseToken: claimed.run.leaseToken,
    status: "cancelled",
  });
});
