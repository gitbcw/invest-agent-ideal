import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-generic-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "automation.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const automation = await import("../src/services/automation-tasks.js");
  const assets = await import("../src/services/user-assets.js");
  const connector = await import("../src/portal/connector.js");
  return { db, automation, assets, connector };
})();

const scope = { userId: "generic-user", projectId: "invest-agent", instanceId: "generic-instance" };

function schedule() {
  return { frequency: "daily" as const, time: "07:30", timezone: "Asia/Shanghai" };
}

function command(type: string, payload: Record<string, unknown> = {}) {
  return { protocolVersion: "2026-08-05", requestId: `generic-${Math.random()}`, type, sentAt: new Date().toISOString(), payload };
}

test("creates and activates an asset-free push task", async () => {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-push-task",
    name: "每日摘要",
    instruction: "整理今天的重要市场摘要。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "wechat_summary" },
  });
  assert.equal(task.status, "paused");
  assert.deepEqual(task.revision.inputs, []);
  assert.deepEqual(task.revision.output, { mode: "none" });
  assert.deepEqual(task.revision.delivery, { mode: "wechat_summary" });
  const active = await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  assert.equal(active.status, "active");
});

test("generic tasks default to intelligent file handling", async () => {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-default",
    name: "智能处理任务",
    instruction: "根据任务需要处理文件并汇报结果。",
    schedule: schedule(),
  });
  assert.deepEqual(task.revision.output, { mode: "agent" });
});

test("generic automation prompt defaults to provisional public values and avoids meaningless no-data rows", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /默认按可用数据完成任务/);
  assert.match(runnerSource, /即使尚未完成第二次独立核验/);
  assert.match(runnerSource, /不得为了证明执行过而写入空值、零值、估算值或无意义状态行/);
});

test("delivery-enabled generic tasks must produce a WeChat-renderable Markdown summary", async () => {
  // The migrated scheduled briefs (market-watch / daily review) push
  // result_summary straight to WeChat; a0f7997 covered only the legacy
  // scheduler prompts, so the generic runner template needs the same rule.
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /revision\.delivery\.mode === "none"/);
  assert.match(runnerSource, /summary 会直接作为微信消息正文发送给用户/);
  assert.match(runnerSource, /必须使用适合微信阅读且可由微信渲染的简洁 Markdown/);
  assert.match(runnerSource, /不要写成无格式的连续纯文本/);
  assert.match(runnerSource, /禁止输出 Markdown 表格/);
});

test("assistant and generic automation prompts require XLSX for user-facing tables", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  const template = await source.readFile(new URL("../templates/workspace/AGENTS.md", import.meta.url), "utf8");
  const { buildMobilePrompt } = await import("../src/runtime/mobile-prompt.js");
  const prompt = buildMobilePrompt({ userText: "创建一个表格" });

  for (const content of [prompt, template]) {
    assert.match(content, /统一.*Excel|统一使用 Excel/);
    assert.match(content, /CSV.*xlsx|CSV.*XLSX/);
    assert.match(content, /不得提交.*csv|不要创建 CSV/);
  }
  assert.match(runnerSource, /本次输出策略（明确格式和文件名必须严格遵守）/);
  assert.match(runnerSource, /OUTPUT_VOLUME_POLICY/);
});

test("validates create Markdown output and preserves immutable generic revisions", async () => {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-markdown-task",
    name: "生成研究笔记",
    instruction: "生成一份结构化的 Markdown 研究笔记。",
    schedule: schedule(),
    output: { mode: "create", format: "markdown", fileName: "daily-note.md" },
    delivery: { mode: "none" },
  });
  assert.equal(task.revision.output.mode, "create");
  assert.equal(task.revision.output.fileName, "daily-note.md");
  const updated = await automation.updateAutomationTask({
    ...scope,
    taskId: task.taskId,
    expectedRevision: 1,
    instruction: "生成一份更详细的 Markdown 研究笔记。",
    output: { mode: "create", format: "markdown", fileName: "detailed-note.md" },
  });
  assert.equal(updated.status, "paused");
  assert.equal(updated.currentRevision, 2);
  assert.equal(updated.revision.output.fileName, "detailed-note.md");
  assert.deepEqual((await automation.listAutomationTaskRevisions({ ...scope, taskId: task.taskId })).map((item) => item.revision), [2, 1]);
  assert.ok((await automation.listAutomationTasks(scope, { outputModes: ["create"] })).some((item) => item.taskId === task.taskId));
  assert.equal((await automation.listAutomationTasks(scope, { outputModes: ["none"] })).some((item) => item.taskId === task.taskId), false);
  await assert.rejects(
    () => automation.createAutomationTask({ ...scope, taskId: "generic-invalid-file", name: "bad", instruction: "bad", schedule: schedule(), output: { mode: "create", format: "markdown", fileName: "bad.csv" } }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_INVALID_OUTPUT_POLICY",
  );
});

test("binds an active CSV update target and rejects archived/cross-scope targets", async () => {
  const { automation, assets, db } = await fixture;
  const target = await assets.createUserAsset({ ...scope, name: "tracking", fileName: "tracking.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1500\n") });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-update-task",
    name: "维护跟踪表",
    instruction: "按最新数据维护跟踪表。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest", expectedVersionId: target.currentVersionId! },
  });
  assert.equal(task.revision.output.mode, "update");
  assert.equal(task.revision.inputs[0]?.assetId, target.assetId);
  const bindings = db.sqlite.prepare("SELECT role, version_policy AS versionPolicy FROM automation_task_asset_bindings WHERE task_id = ? ORDER BY role").all(task.taskId) as Array<{ role: string; versionPolicy: string }>;
  assert.deepEqual(bindings, [{ role: "input", versionPolicy: "latest" }, { role: "update_target", versionPolicy: "latest" }]);

  await assets.archiveUserAsset({ ...scope, assetId: target.assetId });
  await assert.rejects(
    () => automation.updateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1, instruction: "再次维护", output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" } }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_ASSET_BINDING_INVALID",
  );
  await assert.rejects(
    () => automation.createAutomationTask({ ...scope, taskId: "generic-cross-scope", name: "bad", instruction: "bad", schedule: schedule(), inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }], output: { mode: "none" } }),
    (error: unknown) => (error as { code?: string }).code === "AUTOMATION_SCOPE_MISMATCH" || (error as { code?: string }).code === "AUTOMATION_ASSET_BINDING_INVALID",
  );
});

test("connector creates generic tasks without a file and rejects malformed base64", async () => {
  const { connector } = await fixture;
  const scopeWithConnector = { ...scope, assistantId: scope.instanceId, connectorId: "generic-connector", displayName: "generic" };
  const created = await connector.__test__.handleCommand(scopeWithConnector, command("automation.create", {
    name: "connector push",
    instruction: "发送每日摘要。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "wechat_summary" },
  })) as any;
  assert.equal(created.ok, true);
  assert.equal(created.data.revision.output.mode, "none");
  const invalid = await connector.__test__.handleCommand(scopeWithConnector, command("asset.upload", { fileName: "bad.md", base64: "not-base64!" })) as any;
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_REQUEST");
});

test("batch lifecycle actions are scope-bound, revision-aware, and partially successful", async () => {
  const { automation } = await fixture;
  const create = (taskId: string) => automation.createAutomationTask({
    ...scope,
    taskId,
    name: taskId,
    instruction: "按说明执行任务。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  const successfulTask = await create("generic-batch-success");
  const conflictTask = await create("generic-batch-conflict");
  const result = await automation.batchAutomationTaskAction({
    ...scope,
    action: "pause",
    items: [
      { taskId: successfulTask.taskId, expectedRevision: successfulTask.currentRevision },
      { taskId: conflictTask.taskId, expectedRevision: conflictTask.currentRevision + 1 },
    ],
    idempotencyKey: "generic-batch-partial-1",
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results.filter((item) => item.ok).length, 1);
  assert.equal(result.results.filter((item) => !item.ok).length, 1);
  assert.equal(result.results.find((item) => item.taskId === successfulTask.taskId)?.ok, true);
  assert.equal(result.results.find((item) => item.taskId === conflictTask.taskId)?.ok, false);
  const audits = await automation.listAutomationTaskAuditLogs({ ...scope, taskId: successfulTask.taskId });
  assert.equal(audits.some((audit) => audit.details.correlationId === result.correlationId), true);
  const conflictAudits = await automation.listAutomationTaskAuditLogs({ ...scope, taskId: conflictTask.taskId });
  assert.equal(conflictAudits.some((audit) => audit.status === "failed" && audit.details.correlationId === result.correlationId), true);
});

test("generic runner commits one Markdown version and keeps run output references", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-create",
    name: "生成运行产物",
    instruction: "生成 Markdown 结果。",
    schedule: schedule(),
    output: { mode: "create", format: "markdown", fileName: "run-result.md" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-create-once",
    executor: async () => ({
      content: { type: "text" as const, text: "已生成结果" },
      finished: true,
      data: { summary: "结构化结果摘要", stagedOutput: { fileName: "run-result.md", mimeType: "text/markdown", base64: Buffer.from("# result\n").toString("base64") } },
    }),
  });
  assert.equal(result.run.status, "succeeded");
  assert.ok(result.run.outputAssetId);
  assert.ok(result.run.outputVersionId);
  assert.equal(result.run.deliveryStatus, "not_requested");
  const output = await (await import("../src/services/user-assets.js")).readCurrentUserAsset({ ...scope, assetId: result.run.outputAssetId! });
  assert.equal(output.bytes.toString(), "# result\n");
  assert.equal(output.descriptor.versionId, result.run.outputVersionId);
  assert.equal((await automation.listAutomationTaskRuns({ ...scope, hasOutput: true })).some((run) => run.runId === result.run.runId), true);
  assert.equal((await automation.listAutomationTaskRuns({ ...scope, hasOutput: false })).some((run) => run.runId === result.run.runId), false);

  const replay = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-create-once",
    executor: async () => { throw new Error("replay must not execute"); },
  });
  assert.equal(replay.run.runId, result.run.runId);
  assert.equal((await (await import("../src/services/user-assets.js")).listUserAssets(scope)).filter((item) => item.assetId === result.run.outputAssetId).length, 1);
});

test("new automation spreadsheet outputs reject CSV in favor of XLSX", async () => {
  const { automation, assets } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  await assert.rejects(() => automation.createAutomationTask({
    ...scope,
    taskId: "generic-create-csv-for-conversion",
    name: "生成 CSV",
    instruction: "生成跟踪表。",
    schedule: schedule(),
    output: { mode: "create", format: "csv", fileName: "automation-table.csv" },
  }), /new spreadsheet outputs must use xlsx/);
});

test("agent-managed attachment may be read without changes or update its own latest version", async () => {
  const { automation, assets } = await fixture;
  const target = await assets.createUserAsset({
    ...scope,
    name: "煤价跟踪表",
    fileName: "coal-tracker.csv",
    mimeType: "text/csv",
    bytes: Buffer.from("week,price\n2026-W31,700\n"),
  });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-managed",
    name: "维护煤价跟踪表",
    instruction: "核验公开数据；需要时维护附件表格，否则只汇报。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  const unchanged = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-agent-managed-read",
    executor: async () => ({ content: { type: "text" as const, text: "无须变更" }, finished: true, data: { summary: "已核验，未更新文件。" } }),
  });
  assert.equal(unchanged.run.status, "succeeded");
  assert.equal(unchanged.run.outputAssetId, null);
  assert.deepEqual(unchanged.run.inputVersions, [{ assetId: target.assetId, versionId: target.currentVersionId, fileName: "coal-tracker.xlsx" }]);

  const updated = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-agent-managed-update",
    executor: async () => ({ content: { type: "text" as const, text: "已更新" }, finished: true, data: {
      summary: "已补充本周煤价。",
      stagedOutput: { operation: "update", assetId: target.assetId, fileName: "coal-tracker.csv", mimeType: "text/csv", base64: Buffer.from("week,price\n2026-W31,700\n2026-W32,705\n").toString("base64") },
    } }),
  });
  assert.equal(updated.run.status, "succeeded");
  assert.equal(updated.run.outputAssetId, target.assetId);
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  assert.equal(current.descriptor.format, "xlsx");
});

test("generic XLSX runs install the structured spreadsheet helper", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const bytes = await convertCsvBytesToXlsx(Buffer.from("name,value\ncoal,700\n"));
  const target = await assets.createUserAsset({
    ...scope, name: "XLSX helper target", fileName: "helper.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes,
  });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-xlsx-helper",
    name: "维护 Excel",
    instruction: "检查工作簿。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  const result = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-xlsx-helper-once",
    executor: async (input) => {
      assert.equal(input.spreadsheetHelper, "automation-sheet.mjs");
      assert.equal(existsSync(path.join(input.stagingPath, input.spreadsheetHelper!)), true);
      return { content: { type: "text" as const, text: "已检查" }, finished: true, data: { summary: "已检查，未修改。" } };
    },
  });
  assert.equal(result.run.status, "succeeded");
});

test("generic runner pushes idempotently and does not commit malformed output", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-push",
    name: "推送运行结果",
    instruction: "生成一条摘要。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "wechat_on_condition", conditionVersion: 1 },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const pushed = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-push-once",
    executor: async () => ({ content: { type: "text" as const, text: "fallback" }, finished: true, data: { summary: "发送摘要", shouldNotify: true } }),
  });
  assert.equal(pushed.run.status, "succeeded");
  assert.equal(pushed.run.deliveryStatus, "pending");
  assert.ok(pushed.run.pushJobId);
  const pushCount = (await import("../src/db/index.js")).sqlite.prepare("SELECT COUNT(*) AS count FROM push_jobs WHERE idempotency_key = ?").get(`automation:${pushed.run.runId}:delivery`) as { count: number };
  assert.equal(pushCount.count, 1);
  const pushQueue = await import("../src/services/push-queue.js");
  await pushQueue.processDuePushJobs(async () => true, { limit: 20 });
  const delivered = await automation.getAutomationTaskRun({ ...scope, runId: pushed.run.runId });
  assert.equal(delivered?.deliveryStatus, "sent");

  const badTask = await automation.createAutomationTask({ ...scope, taskId: "generic-run-bad-output", name: "坏输出", instruction: "生成结果。", schedule: schedule(), output: { mode: "create", format: "markdown", fileName: "bad-result.md" } });
  await automation.activateAutomationTask({ ...scope, taskId: badTask.taskId, expectedRevision: 1 });
  const bad = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: badTask.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-bad-output-once",
    executor: async () => ({ content: { type: "text" as const, text: "看起来完成了" }, finished: true }),
  });
  assert.equal(bad.run.status, "failed");
  assert.equal(bad.run.outputAssetId, null);
  assert.equal((await (await import("../src/services/user-assets.js")).listUserAssets({ ...scope, search: "坏输出" })).length, 0);
});

test("generic latest update uses the head read at run start and advances it once", async () => {
  const { automation, assets } = await fixture;
  const target = await assets.createUserAsset({ ...scope, name: "generic-update-target", fileName: "generic-update.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1500\n") });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-update-conflict",
    name: "冲突更新",
    instruction: "更新 CSV。",
    schedule: schedule(),
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest", expectedVersionId: target.currentVersionId! },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const changed = await assets.uploadUserAssetVersion({ ...scope, assetId: target.assetId, fileName: "generic-update.csv", mimeType: "text/csv", bytes: Buffer.from("code,price\n600519,1510\n"), expectedVersionId: target.currentVersionId!, source: "conversation" });
  const runner = await import("../src/services/generic-automation-runner.js");
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-update-conflict-once",
    executor: async () => ({ content: { type: "text" as const, text: "generated" }, finished: true, data: { stagedOutput: { assetId: target.assetId, fileName: "generic-update.csv", mimeType: "text/csv", base64: Buffer.from("code,price\n600519,1520\n").toString("base64") } } }),
  });
  assert.equal(result.run.status, "succeeded");
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  assert.notEqual(current.descriptor.versionId, changed.currentVersionId);
  assert.equal(current.descriptor.format, "xlsx");
});

test("bound update task may finish without changing its file and exposes its exact target to the executor", async () => {
  const { automation, assets } = await fixture;
  const target = await assets.createUserAsset({ ...scope, name: "海运模板", fileName: "shipping.csv", mimeType: "text/csv", bytes: Buffer.from("date,index\n") });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-update-unchanged",
    name: "维护海运模板",
    instruction: "有数据时维护文件，没有数据时说明原因。",
    schedule: schedule(),
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-update-unchanged-once",
    executor: async (input) => {
      assert.deepEqual(input.writableTargets, [{ assetId: target.assetId, versionId: target.currentVersionId, fileName: "shipping.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }]);
      return { content: { type: "text" as const, text: "暂无可核验报价。" }, finished: true, data: { summary: "暂无可核验报价，未更新文件。" } };
    },
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.outputAssetId, null);
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  assert.equal(current.descriptor.versionId, target.currentVersionId);
});

test("generic runner preserves a retryable ACP capacity failure", async () => {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-model-capacity",
    name: "模型容量测试",
    instruction: "生成摘要。",
    schedule: schedule(),
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-model-capacity-once",
    executor: async () => ({
      content: { type: "text" as const, text: "模型服务暂时繁忙。" },
      finished: true,
      data: {
        executionStatus: "failed",
        executionErrorCode: "TASK_MODEL_CAPACITY",
        executionErrorCategory: "transient",
        executionRetryable: true,
      },
    }),
  });
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCategory, "transient");
  assert.equal(result.run.retryable, true);
  assert.match(result.run.errorMessage || "", /模型服务暂时繁忙/);
});
