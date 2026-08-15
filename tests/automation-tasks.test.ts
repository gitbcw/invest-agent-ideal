import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

// The runtime config captures these values on import, so keep this test fully
// isolated before dynamically loading any project module.
const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-tasks-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(TEST_ROOT, "automation.db");
process.env.WORKSPACE_ROOT = path.join(TEST_ROOT, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(TEST_ROOT, "runtime");
// E8: the mastra registry is the only storage root; isolate it per run so
// asset files never leak across test runs (AUTOMATION_ASSET_SOURCE_IMMUTABLE).
process.env.MASTRA_PROJECTS_ROOT = path.join(TEST_ROOT, "projects");
mkdirSync(path.join(TEST_ROOT, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(TEST_ROOT, { recursive: true, force: true }));

type AutomationModule = typeof import("../src/services/automation-tasks.js");
type DbModule = typeof import("../src/db/index.js");

const scopeA = { userId: "automation-user-a", instanceId: "automation-instance-a", projectId: "invest-agent" };
const scopeB = { userId: "automation-user-b", instanceId: "automation-instance-b", projectId: "invest-agent" };
let fixturePromise: Promise<{ automation: AutomationModule; db: DbModule; workspaceA: string; workspaceB: string }> | null = null;
let sequence = 0;

async function fixture() {
  if (!fixturePromise) {
    fixturePromise = (async () => {
      const db = await import("../src/db/index.js");
      db.initDb();
      const automation = await import("../src/services/automation-tasks.js");
      // E8: storage roots resolve to registered mastra project roots.
      const { registerTestProject } = await import("./helpers/mastra-project.js");
      const workspaceA = await registerTestProject(scopeA);
      const workspaceB = await registerTestProject(scopeB);
      return { automation, db, workspaceA, workspaceB };
    })();
  }
  return fixturePromise;
}

async function createTask(fileName = "tracking.csv", scope = scopeA) {
  const { automation } = await fixture();
  sequence += 1;
  return automation.createAutomationTask({
    ...scope,
    taskId: `automation-test-${sequence}`,
    name: `维护任务 ${sequence}`,
    description: "根据规则维护工作文件",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset: {
      fileName,
      mimeType: fileName.endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv",
      bytes: fileName.endsWith(".xlsx") ? Buffer.from([0, 255, 1, 2, 3]) : Buffer.from("code,price\n600519,1500\n"),
    },
  });
}

test("creates paused task with immutable revision and source/working assets", async () => {
  const { automation } = await fixture();
  const task = await createTask();

  assert.equal(task.status, "paused");
  assert.equal(task.currentRevision, 1);
  assert.equal(task.revision.revision, 1);
  assert.equal(task.sourceAsset?.relativePath, `automations/${task.taskId}/source/tracking.csv`);
  assert.equal(task.workingAsset?.relativePath, `automations/${task.taskId}/working/tracking.csv`);
  assert.equal(task.sourceAsset?.checksum, task.workingAsset?.checksum);

  const source = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.sourceAsset!.assetId });
  const working = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.workingAsset!.assetId });
  assert.equal(source.bytes.toString("utf8"), "code,price\n600519,1500\n");
  assert.deepEqual(working.bytes, source.bytes);

  const active = await automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: 1 });
  assert.equal(active.status, "active");
  assert.ok(active.nextRunAt);
  const paused = await automation.pauseAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: 1 });
  assert.equal(paused.status, "paused");
  assert.equal(paused.nextRunAt, null);

  const rows = (await automation.listAutomationTaskAssets({ ...scopeA, taskId: task.taskId }));
  assert.equal(rows.length, 2);
  assert.ok((await automation.listAutomationTaskAuditLogs({ ...scopeA, taskId: task.taskId })).length >= 3);
});

test("archived tasks are read-only, hidden from due work, and cannot claim runs", async () => {
  const { automation } = await fixture();
  const task = await createTask();
  await automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision });
  const archived = await automation.archiveAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision });

  assert.equal(archived.status, "archived");
  assert.equal(archived.nextRunAt, null);
  assert.equal((await automation.listAutomationTasks(scopeA)).some((item) => item.taskId === task.taskId), false);
  assert.equal((await automation.listAutomationTasks(scopeA, { statuses: ["archived"] })).some((item) => item.taskId === task.taskId), true);
  assert.equal((await automation.listDueAutomationTasks(new Date("2999-01-01T00:00:00.000Z"))).some((item) => item.taskId === task.taskId), false);

  await assert.rejects(
    () => automation.updateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision, name: "不应修改" }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_ARCHIVED",
  );
  await assert.rejects(
    () => automation.claimAutomationTaskRun({ ...scopeA, taskId: task.taskId, origin: "manual", idempotencyKey: `archived-${task.taskId}` }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_ARCHIVED",
  );
});

test("global run history keeps the revision name and records recovered attempts", async () => {
  const { automation, db } = await fixture();
  const task = await createTask();
  const historical = await automation.claimAutomationTaskRun({ ...scopeA, taskId: task.taskId, origin: "manual", idempotencyKey: `historical-${task.taskId}` });
  assert.ok(historical.run.executionDeadlineAt, "claimed runs have a persisted execution deadline");
  await automation.finishAutomationTaskRun({ ...scopeA, runId: historical.run.runId, leaseToken: historical.run.leaseToken, status: "succeeded", resultSummary: "旧版本完成" });
  await automation.updateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision, name: "后来改名的任务" });

  const history = await automation.listAutomationTaskRuns({ ...scopeA, query: "维护任务" });
  const historicalRow = history.find((run) => run.runId === historical.run.runId);
  assert.equal(historicalRow?.taskName, task.revision.name);
  assert.equal(historicalRow?.revision, 1);

  const retryTask = await createTask();
  const firstAttempt = await automation.claimAutomationTaskRun({ ...scopeA, taskId: retryTask.taskId, origin: "manual", idempotencyKey: `recovery-${retryTask.taskId}` });
  db.sqlite.prepare("UPDATE automation_task_runs SET lease_expires_at = ?, claimed_at = ? WHERE run_id = ?").run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", firstAttempt.run.runId);
  db.sqlite.prepare("UPDATE automation_tasks SET active_run_lease_expires_at = ? WHERE task_id = ?").run("2000-01-01T00:00:00.000Z", retryTask.taskId);
  const recovered = await automation.claimAutomationTaskRun({ ...scopeA, taskId: retryTask.taskId, origin: "manual", idempotencyKey: `recovery-${retryTask.taskId}` });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.run.attempt, 2);
  await automation.finishAutomationTaskRun({ ...scopeA, runId: recovered.run.runId, leaseToken: recovered.run.leaseToken, status: "succeeded", resultSummary: "恢复后完成" });
  const retryHistory = await automation.listAutomationTaskRuns({ ...scopeA, taskId: retryTask.taskId });
  assert.equal(retryHistory[0]?.attempt, 2);
  assert.equal(retryHistory[0]?.status, "succeeded");
  assert.equal(retryHistory[1]?.status, "failed");
});

test("defaults an omitted automation timezone to Asia/Shanghai", async () => {
  const { automation } = await fixture();
  sequence += 1;
  const task = await automation.createAutomationTask({
    ...scopeA,
    taskId: `automation-default-timezone-${sequence}`,
    name: "默认时区任务",
    schedule: { frequency: "daily", time: "07:30" },
    sourceAsset: {
      fileName: "default-timezone.csv",
      mimeType: "text/csv",
      bytes: Buffer.from("code,price\\n600519,1500\\n"),
    },
  });
  assert.equal(task.revision.schedule.timezone, "Asia/Shanghai");
});

test("schedules trading-day tasks after A-share market closures", async () => {
  const { automation } = await fixture();
  const next = automation.nextAutomationRunAt(
    { frequency: "trading_days", time: "09:00", timezone: "Asia/Shanghai" },
    new Date("2026-10-01T00:00:00.000Z"),
  );
  assert.equal(next, "2026-10-08T01:00:00.000Z");

  const legacyNext = automation.nextAutomationRunAt(
    { frequency: "weekdays", time: "09:00", timezone: "Asia/Shanghai" },
    new Date("2026-10-01T00:00:00.000Z"),
  );
  assert.equal(legacyNext, "2026-10-08T01:00:00.000Z");
});

test("updates task definition by appending a revision and pauses the new version", async () => {
  const { automation } = await fixture();
  const task = await createTask();

  const updated = await automation.updateAutomationTask({
    ...scopeA,
    taskId: task.taskId,
    expectedRevision: 1,
    name: "新版维护任务",
    description: "换一个执行时间",
    schedule: { frequency: "weekdays", time: "08:00", timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5] },
  });
  assert.equal(updated.status, "paused");
  assert.equal(updated.currentRevision, 2);
  assert.equal(updated.revision.name, "新版维护任务");
  assert.equal(updated.revision.schedule.time, "08:00");
  assert.equal(updated.sourceAsset?.assetId, task.sourceAsset?.assetId);
  assert.equal(updated.workingAsset?.assetId, task.workingAsset?.assetId);
  assert.deepEqual(updated.revision.inputs, []);

  const revisions = await automation.listAutomationTaskRevisions({ ...scopeA, taskId: task.taskId });
  assert.deepEqual(revisions.map((item) => item.revision), [2, 1]);
  assert.equal(revisions[1]?.name, task.revision.name);
  assert.equal(revisions[1]?.schedule.time, "07:30");
  await assert.rejects(
    () => automation.updateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: 1, name: "stale" }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_REVISION_CONFLICT",
  );
});

test("enforces all three scope fields for list, detail, and asset reads", async () => {
  const { automation } = await fixture();
  const task = await createTask();

  assert.equal((await automation.listAutomationTasks(scopeB)).length, 0);
  await assert.rejects(
    () => automation.getAutomationTask({ ...scopeB, taskId: task.taskId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
  );
  await assert.rejects(
    () => automation.readAutomationTaskAsset({ ...scopeB, assetId: task.sourceAsset!.assetId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
  );

  await assert.rejects(
    () => automation.getAutomationTask({ ...scopeA, projectId: "other-project", taskId: task.taskId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH",
  );
});

test("rejects asset path escape, refuses source overwrite, and only accepts structurally valid xlsx bytes", async () => {
  const { automation } = await fixture();
  const task = await createTask();

  await assert.rejects(
    () => automation.createAutomationTaskAsset({
      ...scopeA,
      taskId: task.taskId,
      assetRole: "working",
      asset: { fileName: "../escape.csv", bytes: Buffer.from("escape") },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_ASSET_INVALID_PATH",
  );
  await assert.rejects(
    () => automation.createAutomationTaskAsset({
      ...scopeA,
      taskId: task.taskId,
      assetRole: "source",
      asset: { fileName: "tracking.csv", bytes: Buffer.from("overwrite") },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_ASSET_SOURCE_IMMUTABLE",
  );
  const source = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.sourceAsset!.assetId });
  assert.equal(source.bytes.toString("utf8"), "code,price\n600519,1500\n");

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("跟踪");
  worksheet.addRow(["code", "price"]);
  worksheet.addRow(["600519", 1500]);
  const validXlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const xlsx = await automation.createAutomationTaskAsset({
    ...scopeA,
    taskId: task.taskId,
    assetRole: "working",
    asset: {
      fileName: "maintained.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      bytes: validXlsx,
    },
  });
  const xlsxRead = await automation.downloadAutomationTaskAsset({ ...scopeA, assetId: xlsx.assetId });
  assert.deepEqual(xlsxRead.bytes, validXlsx);
  assert.equal(xlsxRead.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await assert.rejects(
    () => automation.createAutomationTaskAsset({
      ...scopeA,
      taskId: task.taskId,
      assetRole: "working",
      asset: {
        fileName: "invalid.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_ASSET_INVALID_CONTENT",
  );
});

test("claims runs idempotently and finish retries do not change the terminal result", async () => {
  const { automation } = await fixture();
  const task = await createTask();
  const first = await automation.claimAutomationTaskRun({
    ...scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: "manual-run-1",
  });
  const replay = await automation.claimAutomationTaskRun({
    ...scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: "manual-run-1",
  });
  assert.equal(first.claimed, true);
  assert.equal(replay.claimed, false);
  assert.equal(replay.run.runId, first.run.runId);

  const finished = await automation.finishAutomationTaskRun({
    ...scopeA,
    runId: first.run.runId,
    status: "succeeded",
    resultSummary: "工作文件已更新",
  });
  const finishReplay = await automation.finishAutomationTaskRun({
    ...scopeA,
    runId: first.run.runId,
    status: "succeeded",
    resultSummary: "different retry payload is ignored",
  });
  assert.equal(finished.status, "succeeded");
  assert.equal(finishReplay.finishedAt, finished.finishedAt);
  assert.equal(finishReplay.resultSummary, "工作文件已更新");
  await assert.rejects(
    () => automation.finishAutomationTaskRun({ ...scopeA, runId: first.run.runId, status: "failed" }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_RUN_ALREADY_FINISHED",
  );

  const runs = await automation.listAutomationTaskRuns({ ...scopeA, taskId: task.taskId });
  assert.equal(runs.length, 1);
  assert.equal((await automation.getAutomationTaskRun({ ...scopeA, runId: first.run.runId }))?.status, "succeeded");
});

test("task assets survive cleanup of the short-lived conversation attachment", async () => {
  const { automation, workspaceA } = await fixture();
  const task = await createTask();
  const attachmentPath = path.join(workspaceA, "attachments", "2026-01-01", "temporary.csv");
  await mkdir(path.dirname(attachmentPath), { recursive: true });
  await writeFile(attachmentPath, "temporary upload\n");

  const { registerAttachment, cleanupExpiredAttachments } = await import("../src/services/file-retention.js");
  registerAttachment({
    userId: scopeA.userId,
    instanceId: scopeA.instanceId,
    conversationId: "automation-attachment-cleanup-test",
    storedAt: "2020-01-01T00:00:00.000Z",
    stored: {
      id: `att_automation_${task.taskId}`,
      type: "document",
      mimeType: "text/csv",
      fileName: "temporary.csv",
      sizeBytes: Buffer.byteLength("temporary upload\n"),
      path: attachmentPath,
      relativePath: "attachments/2026-01-01/temporary.csv",
      source: "portal",
      checksum: "unused-in-cleanup-test",
    },
  });
  const summary = await cleanupExpiredAttachments({ now: new Date("2020-01-09T00:00:00.000Z") });
  assert.equal(summary.deletedFiles, 1);
  assert.equal(existsSync(attachmentPath), false);

  const source = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.sourceAsset!.assetId });
  const working = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.workingAsset!.assetId });
  assert.equal(source.bytes.toString("utf8"), "code,price\n600519,1500\n");
  assert.deepEqual(working.bytes, source.bytes);
  assert.equal(existsSync(path.join(workspaceA, "automations", task.taskId, "source", "tracking.csv")), true);
});

test("rejects a database asset row whose relative path was tampered to escape the task directory", async () => {
  const { automation, db } = await fixture();
  const task = await createTask();
  const forgedAssetId = `forged-${task.taskId}`;
  db.sqlite.prepare(`
    INSERT INTO automation_task_assets (
      asset_id, task_id, revision_id, user_id, project_id, instance_id, asset_role,
      file_name, relative_path, mime_type, extension, size_bytes, checksum, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'source', 'forged.csv', ?, 'text/csv', '.csv', 1, ?, ?, ?)
  `).run(
    forgedAssetId,
    task.taskId,
    task.revision.revisionId,
    scopeA.userId,
    scopeA.projectId,
    scopeA.instanceId,
    `automations/${task.taskId}/source/../../outside.csv`,
    "bad-checksum",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await assert.rejects(
    () => automation.readAutomationTaskAsset({ ...scopeA, assetId: forgedAssetId }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_ASSET_UNSAFE",
  );
});

test("moves an active task to needs_attention after three failures and advances the next run on success", async () => {
  const { automation } = await fixture();
  const task = await createTask();
  await automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision });

  for (let index = 1; index <= 3; index += 1) {
    const claimed = await automation.claimAutomationTaskRun({
      ...scopeA,
      taskId: task.taskId,
      origin: "scheduled",
      scheduledFor: `2026-08-05T07:3${index}:00.000Z`,
      idempotencyKey: `failure-${task.taskId}-${index}`,
    });
    assert.equal(claimed.claimed, true);
    await automation.finishAutomationTaskRun({
      ...scopeA,
      runId: claimed.run.runId,
      status: "failed",
      errorMessage: `failure ${index}`,
    });
  }

  const attention = await automation.getAutomationTask({ ...scopeA, taskId: task.taskId });
  assert.equal(attention?.status, "needs_attention");
  assert.equal(attention?.consecutiveFailures, 3);
  assert.equal(attention?.nextRunAt, null);

  await assert.rejects(
    () => automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_NEEDS_ATTENTION",
  );
  const repaired = await automation.updateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision, description: "修复失败原因后继续执行" });
  assert.equal(repaired.status, "paused");
  const reactivated = await automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: repaired.currentRevision });
  assert.equal(reactivated.status, "active");
  assert.equal(reactivated.consecutiveFailures, 0);
  assert.ok(reactivated.nextRunAt);

  const successfulClaim = await automation.claimAutomationTaskRun({
    ...scopeA,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: reactivated.nextRunAt!,
    idempotencyKey: `success-${task.taskId}`,
  });
  await automation.finishAutomationTaskRun({
    ...scopeA,
    runId: successfulClaim.run.runId,
    status: "succeeded",
    resultSummary: "success",
  });
  const afterSuccess = await automation.getAutomationTask({ ...scopeA, taskId: task.taskId });
  assert.equal(afterSuccess?.status, "active");
  assert.equal(afterSuccess?.consecutiveFailures, 0);
  assert.ok(afterSuccess?.nextRunAt);
});

test("keeps all automation runs out of chat until the user explicitly continues", async () => {
  const { automation, workspaceA } = await fixture();
  const conversation = await import("../src/services/conversation-log.js");
  const task = await createTask();
  let executorCalls = 0;

  const executor = async (
    scope: typeof scopeA,
    currentTask: automation.AutomationTaskRecord,
    run: automation.AutomationTaskRunRecord,
    conversationId?: string,
  ) => {
    executorCalls += 1;
    assert.equal(scope.userId, scopeA.userId);
    assert.equal(currentTask.taskId, task.taskId);
    assert.equal(conversationId, undefined);
    await writeFile(
      path.join(workspaceA, "automations", task.taskId, "working", "tracking.csv"),
      "code,price\n600519,1550\n",
    );
    return { content: { type: "text" as const, text: "手动运行已更新工作文件。" }, finished: true };
  };

  const manual = await (await import("../src/services/automation-runner.js")).runAutomationTaskNow({
    scope: scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `runner-manual-${task.taskId}`,
    executor,
  });
  assert.equal(manual.run.status, "succeeded");
  assert.equal(manual.conversationId, undefined);
  assert.equal(manual.run.conversationId, null);
  assert.equal(manual.run.outputAssetId, task.workingAsset?.assetId);
  assert.ok(manual.run.outputChecksum);

  assert.equal(conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length, 0);

  const working = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.workingAsset!.assetId });
  assert.equal(working.bytes.toString("utf8"), "code,price\n600519,1550\n");
  assert.equal(working.checksum, manual.run.outputChecksum);

  const replay = await (await import("../src/services/automation-runner.js")).runAutomationTaskNow({
    scope: scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `runner-manual-${task.taskId}`,
    executor: async () => {
      throw new Error("idempotent replay must not execute");
    },
  });
  assert.equal(replay.run.runId, manual.run.runId);
  assert.equal(replay.conversationId, undefined);
  assert.equal(executorCalls, 1);
  assert.equal(conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length, 0);

  await automation.activateAutomationTask({ ...scopeA, taskId: task.taskId, expectedRevision: task.currentRevision });
  const conversationsBeforeScheduled = conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length;
  const scheduled = await (await import("../src/services/automation-runner.js")).runAutomationTaskNow({
    scope: scopeA,
    taskId: task.taskId,
    origin: "scheduled",
    scheduledFor: "2026-08-05T07:30:00.000Z",
    idempotencyKey: `runner-scheduled-${task.taskId}`,
    executor: async (_scope, _currentTask, run, conversationId) => {
      executorCalls += 1;
      assert.equal(conversationId, undefined);
      assert.ok(run.runId);
      await writeFile(
        path.join(workspaceA, "automations", task.taskId, "working", "tracking.csv"),
        "code,price\n600519,1600\n",
      );
      return { content: { type: "text" as const, text: "计划运行已完成。" }, finished: true };
    },
  });
  assert.equal(scheduled.run.status, "succeeded");
  assert.equal(scheduled.conversationId, undefined);
  assert.equal(scheduled.run.conversationId, null);
  assert.equal(conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length, conversationsBeforeScheduled);

  const continued = (await import("../src/services/automation-runner.js")).continueAutomationRunInChat({ scope: scopeA, runId: scheduled.run.runId });
  const continuedResult = await continued;
  assert.equal(conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length, conversationsBeforeScheduled + 1);
  const continuedConversation = conversation.getConversation({
    ...scopeA,
    assistantId: scopeA.instanceId,
    conversationId: continuedResult.conversationId,
  });
  assert.deepEqual(continuedConversation.messages.map((message) => message.role), ["system"]);
  assert.equal(continuedConversation.messages[0]?.metadata?.origin, "automation_continue");

  const scheduledWorking = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.workingAsset!.assetId });
  assert.equal(scheduledWorking.bytes.toString("utf8"), "code,price\n600519,1600\n");
  assert.equal(scheduledWorking.checksum, scheduled.run.outputChecksum);
  assert.equal(executorCalls, 2);
});

test("records an ACP failure as failed and never commits the staged working file", async () => {
  const { automation } = await fixture();
  const conversation = await import("../src/services/conversation-log.js");
  const task = await createTask();
  const conversationsBefore = conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length;
  const result = await (await import("../src/services/automation-runner.js")).runAutomationTaskNow({
    scope: scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `runner-failure-${task.taskId}`,
    executor: async () => ({
      content: { type: "text" as const, text: "这次回复生成失败了，请稍后重试。" },
      finished: true,
      data: { executionStatus: "failed", executionErrorCode: "AGENT_TURN_FAILED" },
    }),
  });

  assert.equal(result.run.status, "failed");
  const working = await automation.readAutomationTaskAsset({ ...scopeA, assetId: task.workingAsset!.assetId });
  assert.equal(working.bytes.toString("utf8"), "code,price\n600519,1500\n");
  assert.equal(result.conversationId, undefined);
  assert.equal(result.run.conversationId, null);
  assert.equal(conversation.listConversations({ ...scopeA, assistantId: scopeA.instanceId }).items.length, conversationsBefore);
});

test("runner returns a domain busy error while another execution owns the task lease", async () => {
  const task = await createTask();
  const runner = await import("../src/services/automation-runner.js");
  let releaseFirstRun!: () => void;
  let signalFirstRunStarted!: () => void;
  const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
  const firstRunStarted = new Promise<void>((resolve) => { signalFirstRunStarted = resolve; });

  const first = runner.runAutomationTaskNow({
    scope: scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `runner-busy-first-${task.taskId}`,
    executor: async () => {
      signalFirstRunStarted();
      await firstRunGate;
      return { content: { type: "text" as const, text: "首个运行完成。" }, finished: true };
    },
  });
  await firstRunStarted;

  await assert.rejects(
    () => runner.runAutomationTaskNow({
      scope: scopeA,
      taskId: task.taskId,
      origin: "manual",
      idempotencyKey: `runner-busy-second-${task.taskId}`,
      executor: async () => {
        throw new Error("busy execution must not invoke ACP");
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_BUSY",
  );

  releaseFirstRun();
  assert.equal((await first).run.status, "succeeded");
});

test("automation follow-up conversations receive a two-file staging scope and an auditable fenced run", async () => {
  const { automation } = await fixture();
  const conversation = await import("../src/services/conversation-log.js");
  const task = await createTask();
  const original = await automation.claimAutomationTaskRun({
    ...scopeA,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: `original-follow-up-${task.taskId}`,
  });
  await automation.finishAutomationTaskRun({
    ...scopeA,
    runId: original.run.runId,
    leaseToken: original.run.leaseToken,
    status: "succeeded",
    resultSummary: "初次运行完成",
  });
  const conversationId = `automation-follow-up-${task.taskId}`;
  conversation.createConversationSession({
    scope: { ...scopeA, assistantId: scopeA.instanceId },
    conversationId,
    channel: "web",
    title: "自动化后续",
    metadata: { taskId: task.taskId, runId: original.run.runId, origin: "automation_manual" },
  });

  const prepared = await conversation.__test__.prepareAutomationConversation({
    scope: { ...scopeA, assistantId: scopeA.instanceId },
    conversationId,
    binding: { taskId: task.taskId, runId: original.run.runId, origin: "automation_manual" },
    idempotencyKey: `follow-up-${task.taskId}`,
  });
  assert.deepEqual(readdirSync(prepared.workspacePath).sort(), ["automation-sheet.mjs", "source", "working"]);
  await assert.rejects(
    () => conversation.__test__.prepareAutomationConversation({
      scope: { ...scopeA, assistantId: scopeA.instanceId },
      conversationId,
      binding: { taskId: task.taskId, runId: original.run.runId, origin: "automation_manual" },
      idempotencyKey: `follow-up-contender-${task.taskId}`,
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_TASK_BUSY",
  );
  await prepared.complete({ content: { type: "text", text: "已说明结果，未改动表格。" }, finished: true });
  await prepared.cleanup();

  const runs = await automation.listAutomationTaskRuns({ ...scopeA, taskId: task.taskId });
  const followUp = runs.find((run) => run.idempotencyKey === `follow-up-${task.taskId}`);
  assert.equal(followUp?.status, "succeeded");
  assert.equal(followUp?.leaseExpiresAt, null);
});
