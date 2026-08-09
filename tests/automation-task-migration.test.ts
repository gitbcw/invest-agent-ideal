import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-migration-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "migration.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const migration = await import("../src/services/automation-task-migration.js");
  const workspace = await import("../src/lib/workspace.js");
  return { db, automation, migration, workspace };
})();

const scope = { userId: "migration-user", projectId: "invest-agent", instanceId: "migration-instance" };

test("migrates one legacy CSV task with backup, asset bindings, paused revision, and audit", async () => {
  const { automation, migration, workspace, db } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "legacy-migrate-task",
    name: "旧表格任务",
    description: "维护旧表格",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "source.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1500\n") },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const result = await migration.migrateLegacyAutomationTaskToAssets({ ...scope, taskId: task.taskId });
  assert.equal(result.status, "migrated");
  assert.equal(result.task.status, "paused");
  assert.equal(result.task.currentRevision, 2);
  assert.equal(result.task.sourceAsset, null);
  assert.equal(result.task.revision.output.mode, "update");
  assert.equal(result.task.revision.inputs[0]?.versionPolicy, "fixed");
  assert.equal(result.task.revision.output.assetId, result.workingAsset.assetId);
  assert.equal(result.task.revision.output.expectedVersionId, undefined);
  assert.match(result.backupRelativePath, /^\.automation-migration-backups\/legacy-migrate-task\//);
  const backupRoot = path.join(workspace.resolveWorkspacePath(scope.userId), result.backupRelativePath);
  assert.equal(existsSync(backupRoot), true);
  assert.equal(readFileSync(path.join(backupRoot, "source-source.csv"), "utf8"), "code,price\n600519,1500\n");
  assert.equal((await automation.listAutomationTaskAssets({ ...scope, taskId: task.taskId })).length, 2);
  const audits = await automation.listAutomationTaskAuditLogs({ ...scope, taskId: task.taskId });
  assert.ok(audits.some((audit) => audit.action === "task.migration" && audit.status === "success"));
  const bindingCount = (db.sqlite.prepare("SELECT COUNT(*) AS count FROM automation_task_asset_bindings WHERE task_id = ?").get(task.taskId) as { count: number }).count;
  assert.equal(bindingCount, 2);

  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: result.task.currentRevision });
  const runner = await import("../src/services/generic-automation-runner.js");
  const run = (idempotencyKey: string, price: number) => runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled" as const,
    idempotencyKey,
    executor: async () => ({
      content: { type: "text" as const, text: "已更新" },
      finished: true,
      data: {
        summary: "已更新迁移后的跟踪表",
        stagedOutput: {
          assetId: result.workingAsset.assetId,
          fileName: "source.csv",
          mimeType: "text/csv",
          base64: Buffer.from(`code,price\n600519,${price}\n`).toString("base64"),
        },
      },
    }),
  });
  const firstRun = await run("legacy-migrate-run-1", 1510);
  const secondRun = await run("legacy-migrate-run-2", 1520);
  assert.equal(firstRun.run.status, "succeeded");
  assert.equal(secondRun.run.status, "succeeded");
  const assets = await import("../src/services/user-assets.js");
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: result.workingAsset.assetId });
  assert.equal(current.descriptor.versionNumber, 3);
  assert.equal(current.descriptor.format, "xlsx");
});

test("refuses cross-scope legacy migration", async () => {
  const { automation, migration } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "legacy-migrate-scope-task",
    name: "旧表格任务隔离",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: { fileName: "source.csv", bytes: Buffer.from("a,b\n1,2\n") },
  });
  await assert.rejects(
    () => migration.migrateLegacyAutomationTaskToAssets({ ...scope, userId: "other-user", instanceId: "other-instance", taskId: task.taskId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
  );
});
