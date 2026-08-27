import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("mode=none prompts forbid stagedOutput in the final envelope (2026-08-19 T-324)", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /output\.mode === "none"[\s\S]*?禁止出现 stagedOutput/);
  assert.match(runnerSource, /ignored stagedOutput under output\.mode=none/);
});

test("runner prompts steer XLSX appends to declarative appendRows and require explicit outputSkipped (mg 2026-08-19)", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /不要调用 spreadsheet\.transform，直接在最终 stagedOutput 返回 \{operation:'appendRows'/);
  assert.match(runnerSource, /skipIfCellMatches/);
  assert.match(runnerSource, /绝不能直接使用旧的 lastDedupeValue/);
  assert.doesNotMatch(runnerSource, /value:lastDedupeValue 或本次待追加日期/);
  assert.match(runnerSource, /缺少 stagedOutput 又未声明 outputSkipped 的运行会被判为失败/);
  assert.match(runnerSource, /显式返回 outputSkipped:true 并在 summary 说明原因/);
  assert.match(runnerSource, /serverTimeFact/, "automation prompts must state the server date fact like chat turns do (mg 8-12 scope incident)");
  assert.doesNotMatch(runnerSource, /一律以该日期为准|不得用于本轮取数参数/, "date injection stays a bare fact; behavior rules belong to the tool layer");
});

test("generic scheduled automation uses a narrow per-run tool allowlist and keeps typed review publication", async () => {
  const runner = await import("../src/services/generic-automation-runner.js");
  const generic = runner.resolveGenericAutomationToolAllowlist({ taskType: null });
  for (const forbidden of [
    "assets.list", "automation.list", "automation.get", "conversation.history",
    "confirmations.pending", "watch_rules.catalog", "watch_rules.list",
    "watch_rules.validate", "watch_rules.dry_run",
  ]) {
    assert.equal(generic.includes(forbidden), false, `${forbidden} must stay out of generic automation`);
  }
  assert.ok(generic.includes("assets.version.read"));
  assert.ok(generic.includes("spreadsheet.transform"));
  assert.ok(generic.includes("spreadsheet.create"));
  assert.ok(!generic.includes("reviews.save"));
  assert.equal(runner.resolveGenericAutomationToolAllowlist({ taskType: null }, { xlsxAppendOnly: true }).includes("spreadsheet.transform"), false);
  assert.ok(runner.resolveGenericAutomationToolAllowlist({ taskType: "scheduled-weekly-review" }).includes("reviews.save"));
  const weeklyTarget = runner.resolveGenericAutomationReviewTarget(
    { taskType: "scheduled-weekly-review" },
    { scheduledFor: "2026-08-22T11:00:00.000Z", claimedAt: "2026-08-22T11:00:01.000Z", userId: "mg", instanceId: "invest-agent-mg" },
  );
  assert.deepEqual(weeklyTarget, {
    kind: "weekly",
    reportKey: "2026-08-22_weekly",
    conversationId: "scheduler:weekly-review:mg:invest-agent-mg",
  });
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /mcpAllowedTools: toolAllowlist/);
  assert.match(runnerSource, /REVIEW_ARTIFACT_NOT_PUBLISHED/);
  assert.match(runnerSource, /最多 \$\{GENERIC_AUTOMATION_MAX_TOOL_CALLS\} 次/);
  const agentSource = await source.readFile(new URL("../src/runtime/agent.ts", import.meta.url), "utf8");
  assert.match(agentSource, /expectedReviewKind: message\.context\?\.expectedReviewKind/);
  assert.match(agentSource, /expectedReviewKey: message\.context\?\.expectedReviewKey/);
});

test("generic automation reserves time after the ACP attempt", async () => {
  const runner = await import("../src/services/generic-automation-runner.js");
  const deadline = new Date(Date.UTC(2026, 7, 23, 10, 0, 0)).toISOString();
  const derived = runner.resolveGenericAutomationAgentDeadline(deadline);
  assert.equal(derived, new Date(Date.parse(deadline) - 30_000).toISOString());
});

test("spreadsheet validation errors teach the expected shapes instead of bare 'invalid item'", async () => {
  const source = await import("node:fs/promises");
  const { applyAutomationSheetChanges } = await import("../src/services/automation-spreadsheet.js");
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("行业复盘");
  assert.throws(
    () => applyAutomationSheetChanges(workbook, { appendRows: [{ sheet: "行业复盘", values: "not-an-array" } as never] }),
    /invalid appendRows item: expected item #1: \{sheet:"工作表名", values:\[\["a",1\]/,
  );
  const { TOOL_SPECS } = await import("../src/mastra/tools/registry.js");
  const transform = TOOL_SPECS.find((tool) => tool.id === "spreadsheet.transform");
  assert.ok(transform, "spreadsheet.transform must stay registered");
  const changesField = (transform.inputSchema as Record<string, unknown>).changes as { shape?: Record<string, unknown> };
  assert.ok(changesField?.shape, "changes must be a structured object schema, not an opaque record");
  for (const key of ["appendRows", "setCells", "freezePanes", "autoFilters"]) {
    assert.ok(changesField.shape![key], `the changes schema must expose ${key} to the model`);
  }
  void source;
});

test("assistant and generic automation prompts require XLSX for user-facing tables", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  const { buildMobilePrompt } = await import("../src/runtime/mobile-prompt.js");
  const prompt = buildMobilePrompt({ userText: "创建一个表格" });

  assert.match(prompt, /统一.*Excel|统一使用 Excel/);
  assert.match(prompt, /CSV.*xlsx|CSV.*XLSX/);
  assert.match(prompt, /不得提交.*csv|不要创建 CSV/);
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

test("generic runner aborts the active executor at its absolute execution deadline", async () => {
  const { automation } = await fixture;
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-deadline-abort",
    name: "截止时间取消",
    instruction: "生成结果。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  let observedAbort = false;
  const startedAt = Date.now();
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: "generic-run-deadline-abort-once",
    executionDeadlineAt: new Date(Date.now() + 40).toISOString(),
    executor: async ({ signal }) => await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("deadline aborted"));
      }, { once: true });
    }),
  });
  assert.equal(observedAbort, true);
  assert.equal(result.run.status, "failed");
  assert.ok(Date.now() - startedAt < 1_000, "deadline cancellation must not wait for the normal 15 minute lease");
});

test("agent create filePath outputs stay in staging and preserve fileName (MG 2026-08-21 regression)", async () => {
  const { automation, assets } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-create-filepath-contract",
    name: "暂存文件契约",
    instruction: "生成 Markdown 文件。",
    schedule: schedule(),
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  const missing = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-missing",
    executor: async () => ({
      content: { type: "text" as const, text: "done" },
      finished: true,
      data: {
        summary: "提交缺失文件。",
        stagedOutput: { operation: "create", fileName: "missing.md", filePath: "missing.md" },
      },
    }),
  });
  assert.equal(missing.run.status, "failed", "a missing staged file must fail closed");
  assert.equal(missing.run.outputAssetId, null);

  const missingName = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-missing-name",
    executor: async ({ stagingPath }) => {
      const filePath = path.join(stagingPath, "result.md");
      writeFileSync(filePath, "# result\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: { summary: "缺少文件名。", stagedOutput: { operation: "create", filePath: "result.md" } },
      };
    },
  });
  assert.equal(missingName.run.status, "failed", "a filePath result must still provide fileName");
  assert.equal(missingName.run.outputAssetId, null);

  const success = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-success",
    executor: async ({ stagingPath }) => {
      mkdirSync(path.join(stagingPath, "outputs"), { recursive: true });
      writeFileSync(path.join(stagingPath, "outputs", "result.md"), "# result\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "已生成文件。",
          stagedOutput: { operation: "create", fileName: "result.md", filePath: "outputs/result.md", mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(success.run.status, "succeeded");
  assert.ok(success.run.outputAssetId);
  const output = await assets.readCurrentUserAsset({ ...scope, assetId: success.run.outputAssetId! });
  assert.equal(output.descriptor.fileName, "result.md");
  assert.equal(output.bytes.toString(), "# result\n");
});

test("agent create filePath rejects an existing file outside staging (MG 2026-08-21 regression)", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-create-filepath-outside",
    name: "暂存边界契约",
    instruction: "生成 Markdown 文件。",
    schedule: schedule(),
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  let outsidePath = "";
  try {
    const result = await runner.runGenericAutomationTaskNow({
      scope,
      taskId: task.taskId,
      origin: "scheduled",
      idempotencyKey: "generic-agent-create-filepath-outside-once",
      executor: async ({ stagingPath, run }) => {
        outsidePath = path.join(path.dirname(stagingPath), `outside-${run.runId}.md`);
        writeFileSync(outsidePath, "# outside\n");
        return {
          content: { type: "text" as const, text: "done" },
          finished: true,
          data: {
            summary: "提交暂存目录外文件。",
            stagedOutput: { operation: "create", fileName: "outside.md", filePath: `../${path.basename(outsidePath)}`, mimeType: "text/markdown" },
          },
        };
      },
    });
    assert.equal(result.run.status, "failed", "an existing file outside staging must fail closed");
    assert.equal(result.run.outputAssetId, null);
  } finally {
    if (outsidePath) rmSync(outsidePath, { force: true });
  }
});

test("T-337: misprefixed or absolute filePath recovers via the unique staging basename", async () => {
  const { automation, assets } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const target = await assets.createUserAsset({
    ...scope,
    name: "单一可写目标",
    fileName: "bound.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# bound input\n"),
  });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-create-filepath-basename-heal",
    name: "暂存路径自愈契约",
    instruction: "生成 Markdown 文件。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  // Case 1: the agent prefixed an invented directory to the referenced path.
  const healed = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-prefix",
    executor: async ({ stagingPath }) => {
      writeFileSync(path.join(stagingPath, "result.md"), "# healed\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "已生成文件。",
          stagedOutput: { operation: "create", fileName: "result.md", filePath: "staging/result.md", mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(healed.run.status, "succeeded", "a wrong prefix over a unique staged basename must self-heal");
  assert.ok(healed.run.outputAssetId);
  const healedOutput = await assets.readCurrentUserAsset({ ...scope, assetId: healed.run.outputAssetId! });
  assert.equal(healedOutput.bytes.toString(), "# healed\n");

  // Case 2: the agent echoed the absolute workspace path of the staged file.
  const absolute = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-absolute",
    executor: async ({ stagingPath }) => {
      const absolutePath = path.join(stagingPath, "absolute.md");
      writeFileSync(absolutePath, "# absolute\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "已生成文件。",
          stagedOutput: { operation: "create", fileName: "absolute.md", filePath: absolutePath, mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(absolute.run.status, "succeeded", "an absolute path to a unique staged file must self-heal");

  // Case 3: ambiguous basenames must stay failed instead of guessing.
  const ambiguous = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-ambiguous",
    executor: async ({ stagingPath }) => {
      mkdirSync(path.join(stagingPath, "a"), { recursive: true });
      mkdirSync(path.join(stagingPath, "b"), { recursive: true });
      writeFileSync(path.join(stagingPath, "a", "dup.md"), "# a\n");
      writeFileSync(path.join(stagingPath, "b", "dup.md"), "# b\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "提交歧义路径。",
          stagedOutput: { operation: "create", fileName: "dup.md", filePath: "wrong/dup.md", mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(ambiguous.run.status, "failed", "two staged files with the same basename must fail closed");
  assert.match(ambiguous.run.errorMessage || "", /outside staging: wrong\/dup\.md/);

  // Case 4: an existing absolute path outside staging must never be replaced
  // with a same-basename staged file. This guards against arbitrary path
  // acceptance, even when the task has one writable target.
  let outsidePath = "";
  try {
    const outside = await runner.runGenericAutomationTaskNow({
      scope,
      taskId: task.taskId,
      origin: "scheduled",
      idempotencyKey: "generic-agent-create-filepath-heal-outside-existing",
      executor: async ({ stagingPath, run }) => {
        const basename = `outside-${run.runId}.md`;
        outsidePath = path.join(path.dirname(stagingPath), basename);
        writeFileSync(outsidePath, "# outside\n");
        writeFileSync(path.join(stagingPath, basename), "# inside\n");
        return {
          content: { type: "text" as const, text: "done" },
          finished: true,
          data: {
            summary: "提交暂存目录外文件。",
            stagedOutput: { operation: "create", fileName: "outside.md", filePath: outsidePath, mimeType: "text/markdown" },
          },
        };
      },
    });
    assert.equal(outside.run.status, "failed", "an existing absolute path outside staging must fail closed");
    assert.equal(outside.run.outputAssetId, null);
  } finally {
    if (outsidePath) rmSync(outsidePath, { force: true });
  }

  // Case 5: service-owned bound inputs are not output candidates.
  const inputEcho = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-input-echo",
    executor: async () => ({
      content: { type: "text" as const, text: "done" },
      finished: true,
      data: {
        summary: "误把输入文件当成产物。",
        stagedOutput: { operation: "create", fileName: "bound.md", filePath: "inputs/1-bound.md", mimeType: "text/markdown" },
      },
    }),
  });
  assert.equal(inputEcho.run.status, "failed", "the service-owned inputs directory must not be treated as output");

  // Case 6: no writable target means there is no safe target identity for
  // basename healing, even if exactly one file exists in staging.
  const noTargetTask = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-create-filepath-heal-no-target",
    name: "无可写目标自愈护栏",
    instruction: "生成 Markdown 文件。",
    schedule: schedule(),
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: noTargetTask.taskId, expectedRevision: 1 });
  const noTarget = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: noTargetTask.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-no-target-once",
    executor: async ({ stagingPath }) => {
      writeFileSync(path.join(stagingPath, "no-target.md"), "# no target\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "无目标路径。",
          stagedOutput: { operation: "create", fileName: "no-target.md", filePath: "wrong/no-target.md", mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(noTarget.run.status, "failed", "basename healing without a writable target must fail closed");
  assert.match(noTarget.run.errorMessage || "", /exactly one writable target/);

  // Case 7: multiple writable targets make the basename non-deterministic;
  // do not hide that ambiguity behind a unique staged basename.
  const secondTarget = await assets.createUserAsset({
    ...scope,
    name: "第二个可写目标",
    fileName: "bound-two.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# second bound input\n"),
  });
  const multiTargetTask = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-agent-create-filepath-heal-multiple-targets",
    name: "多可写目标自愈护栏",
    instruction: "生成 Markdown 文件。",
    schedule: schedule(),
    inputs: [
      { assetId: target.assetId, role: "input", versionPolicy: "latest" },
      { assetId: secondTarget.assetId, role: "input", versionPolicy: "latest" },
    ],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: multiTargetTask.taskId, expectedRevision: 1 });
  const multiTarget = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: multiTargetTask.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-agent-create-filepath-heal-multiple-targets-once",
    executor: async ({ stagingPath }) => {
      writeFileSync(path.join(stagingPath, "multi-target.md"), "# ambiguous target\n");
      return {
        content: { type: "text" as const, text: "done" },
        finished: true,
        data: {
          summary: "多目标路径。",
          stagedOutput: { operation: "create", fileName: "multi-target.md", filePath: "wrong/multi-target.md", mimeType: "text/markdown" },
        },
      };
    },
  });
  assert.equal(multiTarget.run.status, "failed", "basename healing with multiple writable targets must fail closed");
  assert.match(multiTarget.run.errorMessage || "", /exactly one writable target/);
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

test("mode=none runs ignore an unexpected stagedOutput instead of failing (daily-review 2026-08-19 regression)", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  // Daily-review tasks are output.mode=none; the agent may still echo a
  // stagedOutput after persisting its report through domain tools. The run
  // itself must succeed — the domain output is already durable.
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-run-none-with-staged",
    name: "无输出任务带回显",
    instruction: "生成日复盘并通过领域工具保存。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "generic-run-none-with-staged-once",
    executor: async () => ({
      content: { type: "text" as const, text: "done" },
      finished: true,
      data: {
        summary: "日复盘已通过 reviews.save 保存。",
        shouldNotify: false,
        stagedOutput: { operation: "create", fileName: "review.md", mimeType: "text/markdown", base64: Buffer.from("# review\n").toString("base64") },
      },
    }),
  });
  assert.equal(result.run.status, "succeeded", "unexpected stagedOutput under mode=none must not fail the run");
  assert.equal(result.run.outputAssetId, null, "the ignored stagedOutput must not be committed as an asset");

  const nullResult = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "manual",
    idempotencyKey: "generic-run-none-with-null-staged-once",
    executor: async () => ({
      content: { type: "text" as const, text: "done" },
      finished: true,
      data: { summary: "无文件输出。", stagedOutput: null },
    }),
  });
  assert.equal(nullResult.run.status, "succeeded", "stagedOutput:null must be treated as absent");
});

test("typed review runs require a service-published artifact for the exact scheduled target", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const { publishServiceOwnedReviewArtifact } = await import("../src/services/conversation-artifacts.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-weekly-review-publication-guard",
    taskType: "scheduled-weekly-review",
    name: "周复盘发布门禁",
    instruction: "生成周复盘并调用 reviews.save。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const scheduledFor = "2026-08-22T11:00:00.000Z";

  const missing = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "manual",
    scheduledFor,
    idempotencyKey: "generic-weekly-review-publication-missing",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: { summary: "声称已完成。" } }),
  });
  assert.equal(missing.run.status, "failed");
  assert.match(missing.run.errorMessage || "", /REVIEW_ARTIFACT_NOT_PUBLISHED:weekly:2026-08-22_weekly/);

  const published = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "manual",
    scheduledFor,
    idempotencyKey: "generic-weekly-review-publication-present",
    executor: async ({ run }) => {
      const target = runner.resolveGenericAutomationReviewTarget(task, run)!;
      await publishServiceOwnedReviewArtifact({
        ...scope,
        assistantId: scope.instanceId,
        conversationId: target.conversationId,
        kind: "weekly",
        reportKey: target.reportKey,
        content: "# Weekly publication guard\n",
      });
      return { content: { type: "text" as const, text: "done" }, finished: true, data: { summary: "周复盘已发布。" } };
    },
  });
  assert.equal(published.run.status, "succeeded");
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

test("bound update task may finish without changing its file via explicit outputSkipped and exposes its exact target to the executor", async () => {
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
      return { content: { type: "text" as const, text: "暂无可核验报价。" }, finished: true, data: { summary: "暂无可核验报价，未更新文件。", outputSkipped: true } };
    },
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.outputAssetId, null);
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  assert.equal(current.descriptor.versionId, target.currentVersionId);
});

test("declarative stagedOutput appendRows commits rows without spreadsheet.transform (mg 2026-08-19 regression)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const bytes = await convertCsvBytesToXlsx(Buffer.from("日期,序号,行业\n2026-08-18,1,通信\n"));
  const target = await assets.createUserAsset({ ...scope, name: "行业复盘", fileName: "2026年08月行业复盘表.xlsx", mimeType: XLSX_MIME, bytes });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-appendrows",
    name: "每天行业复盘",
    instruction: "追加当日行业复盘。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  let schemaContext: unknown;
  let appendOnly = false;
  const result = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-appendrows-once",
    executor: async (input) => {
      schemaContext = input.spreadsheetContext;
      appendOnly = input.xlsxAppendOnly === true;
      return { content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "已追加 2026-08-19 行。",
      stagedOutput: { operation: "appendRows", rows: [["2026-08-19", 2, "煤炭"]], skipIfCellMatches: { column: 1, value: "2026-08-19" } },
      }};
    },
  });
  assert.equal(result.run.status, "succeeded");
  assert.equal(appendOnly, true);
  assert.deepEqual((schemaContext as Array<{ sheets: Array<{ name: string; headers: unknown[]; columnCount: number; dedupeColumn: number; lastDedupeValue?: unknown }> }>)[0]?.sheets[0], {
    name: "数据",
    headerRow: 1,
    headers: ["日期", "序号", "行业"],
    columnCount: 3,
    rowCount: 2,
    dedupeColumn: 1,
    lastDedupeValue: "2026-08-18",
  });
  assert.equal(result.run.outputAssetId, target.assetId);
  assert.notEqual(result.run.outputVersionId, target.currentVersionId);
  const ExcelJS = (await import("exceljs")).default;
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  const workbook = new ExcelJS.Workbook();
  const buf = Buffer.from(current.bytes);
  await workbook.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet("数据")!;
  assert.deepEqual((sheet.getRow(sheet.rowCount).values as unknown[]).slice(1), ["2026-08-19", 2, "煤炭"]);

  // 重跑同一判重值：确定性跳过，不产生新版本（防同日重复追加）。
  const skipped = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-appendrows-twice",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "当日行已存在。",
      stagedOutput: { operation: "appendRows", rows: [["2026-08-19", 3, "重复"]], skipIfCellMatches: { column: 1, value: "2026-08-19" } },
    } }),
  });
  assert.equal(skipped.run.status, "succeeded");
  assert.equal(skipped.run.outputAssetId, null);
  assert.match(skipped.run.resultSummary || "", /已存在匹配行/);
  const afterSkip = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  assert.equal(afterSkip.descriptor.versionId, result.run.outputVersionId, "skip must not commit a new version");

  const ambiguousUpdate = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-xlsx-ambiguous-update",
    name: "更新工作簿",
    instruction: "更新当日数据并汇报。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: ambiguousUpdate.taskId, expectedRevision: 1 });
  const ambiguousRun = await runner.runGenericAutomationTaskNow({
    scope, taskId: ambiguousUpdate.taskId, origin: "scheduled", idempotencyKey: "generic-xlsx-ambiguous-update-once",
    executor: async (input) => {
      assert.equal(input.xlsxAppendOnly, false, "ambiguous XLSX updates must retain spreadsheet.transform");
      return { content: { type: "text" as const, text: "无变化" }, finished: true, data: { summary: "无需更新。", outputSkipped: true } };
    },
  });
  assert.equal(ambiguousRun.run.status, "succeeded");
});

test("update run without stagedOutput fails unless outputSkipped is explicit (silent-success fix)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const bytes = await convertCsvBytesToXlsx(Buffer.from("日期\n"));
  const target = await assets.createUserAsset({ ...scope, name: "静默失败护栏", fileName: "silent-guard.xlsx", mimeType: XLSX_MIME, bytes });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-silent-no-output",
    name: "护栏任务",
    instruction: "追加数据；追加失败时不得静默成功。",
    schedule: schedule(),
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const runner = await import("../src/services/generic-automation-runner.js");
  const silent = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-silent-no-output-once",
    executor: async () => ({ content: { type: "text" as const, text: "看起来完成了" }, finished: true, data: { summary: "追加参数没写对，未更新文件。" } }),
  });
  assert.equal(silent.run.status, "failed", "an update task that modified nothing must not report success");
  assert.match(silent.run.errorMessage || "", /stagedOutput is required for update tasks/);
  assert.equal(silent.run.outputAssetId, null);
  const taskAfter = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.equal(taskAfter!.consecutiveFailures, 1);

  const explicit = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-silent-no-output-skipped",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: { summary: "非交易日，未修改。", outputSkipped: true } }),
  });
  assert.equal(explicit.run.status, "succeeded", "an explicit outputSkipped decision stays a success");
  assert.equal(explicit.run.outputAssetId, null);
});

test("appendRows guards: stale monthly rollover and malformed rows fail with teaching messages", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const { instantiateMonthlyFileName } = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const staleBytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n2026-08-01,示例\n"));
  const stale = await assets.createUserAsset({ ...scope, name: "旧月绑定", fileName: "2020年01月行业复盘表.xlsx", mimeType: XLSX_MIME, bytes: staleBytes });
  const rolloverTask = await automation.createAutomationTask({
    ...scope, taskId: "generic-appendrows-rollover", name: "行业复盘滚动", instruction: "追加当日行业复盘。",
    schedule: schedule(),
    output: { mode: "update", assetId: stale.assetId, versionPolicy: "latest", rollover: { kind: "monthly", fileNamePattern: "{YYYY}年{MM}行业复盘表.xlsx" } },
  });
  await automation.activateAutomationTask({ ...scope, taskId: rolloverTask.taskId, expectedRevision: 1 });
  const rolloverRun = await runner.runGenericAutomationTaskNow({
    scope, taskId: rolloverTask.taskId, origin: "scheduled", idempotencyKey: "generic-appendrows-rollover-once",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "追加。", stagedOutput: { operation: "appendRows", rows: [["2026-08-19", "煤炭"]] },
    } }),
  });
  assert.equal(rolloverRun.run.status, "failed");
  assert.match(rolloverRun.run.errorMessage || "", /operation 'create'/);

  const bytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n"));
  const target = await assets.createUserAsset({ ...scope, name: "形状护栏", fileName: "shape-guard.xlsx", mimeType: XLSX_MIME, bytes });
  const task = await automation.createAutomationTask({
    ...scope, taskId: "generic-appendrows-bad-shape", name: "形状护栏", instruction: "追加。",
    schedule: schedule(),
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const bad = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-appendrows-bad-shape-once",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "追加。", stagedOutput: { operation: "appendRows", rows: ["2026-08-19", "煤炭"] },
    } }),
  });
  assert.equal(bad.run.status, "failed");
  assert.match(bad.run.errorMessage || "", /2D array/);
  assert.equal(bad.run.outputAssetId, null);
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

test("monthly rollover creates the current-month workbook, switches the binding, and self-heals (T-317)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const { instantiateMonthlyFileName } = await import("../src/services/automation-tasks.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const pattern = "{YYYY}年{MM}行业复盘表.xlsx";
  const monthlyFile = instantiateMonthlyFileName(pattern);

  const boundBytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n2026-08-01,示例\n"));
  const bound = await assets.createUserAsset({
    ...scope, name: "行业复盘绑定", fileName: "2020年01月行业复盘表.xlsx",
    mimeType: XLSX_MIME, bytes: boundBytes,
  });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-monthly-rollover",
    name: "行业复盘",
    instruction: "追加当日行业复盘。",
    schedule: schedule(),
    output: { mode: "update", assetId: bound.assetId, versionPolicy: "latest", rollover: { kind: "monthly", fileNamePattern: pattern } },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  let sawRollover = false;
  const newBytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n2026-08-19,煤炭\n"));
  const first = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-monthly-rollover-once",
    executor: async (input) => {
      assert.ok(input.monthlyRollover, "a stale bound file must expose the monthly rollover target to the executor");
      assert.equal(input.monthlyRollover!.targetFileName, monthlyFile);
      sawRollover = true;
      return { content: { type: "text" as const, text: "done" }, finished: true, data: { summary: "已创建本月文件并追加。", stagedOutput: { operation: "create", fileName: monthlyFile, mimeType: XLSX_MIME, base64: newBytes.toString("base64") } } };
    },
  });
  assert.equal(first.run.status, "succeeded");
  assert.ok(first.run.outputAssetId);
  assert.ok(sawRollover);

  const { findActiveAssetByFileName } = await import("../src/services/user-assets.js");
  const created = await findActiveAssetByFileName({ ...scope, fileName: monthlyFile });
  assert.ok(created, "the monthly file must exist as an active asset");
  assert.equal(created!.assetId, first.run.outputAssetId);

  const after = await automation.getAutomationTask({ ...scope, taskId: task.taskId });
  assert.ok(after);
  assert.equal(after.status, "active", "the binding switch must leave the schedule active");
  const afterOutput = after.revision.output as { mode: string; assetId?: string };
  assert.equal(afterOutput.mode, "update");
  assert.equal(afterOutput.assetId, created!.assetId, "the task binding must roll to the monthly asset");

  const second = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-monthly-rollover-twice",
    executor: async (input) => {
      assert.equal(input.monthlyRollover, null, "with the current-month file present no rollover is requested");
      assert.equal(input.writableTargets[0]?.fileName, monthlyFile);
      return { content: { type: "text" as const, text: "done" }, finished: true, data: { summary: "已追加。", stagedOutput: { operation: "update", assetId: input.writableTargets[0]!.assetId, fileName: monthlyFile, mimeType: XLSX_MIME, base64: newBytes.toString("base64") } } };
    },
  });
  assert.equal(second.run.status, "succeeded");
  assert.equal(second.run.outputAssetId, created!.assetId, "the self-healed run must commit onto the monthly asset");
});

test("monthly rollover rejects a create whose fileName is not the monthly target (T-317)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const boundBytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n"));
  const bound = await assets.createUserAsset({
    ...scope, name: "行业复盘护栏", fileName: "2020年02月行业复盘表.xlsx",
    mimeType: XLSX_MIME, bytes: boundBytes,
  });
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "generic-monthly-rollover-guard",
    name: "行业复盘护栏",
    instruction: "追加当日行业复盘。",
    schedule: schedule(),
    output: { mode: "update", assetId: bound.assetId, versionPolicy: "latest", rollover: { kind: "monthly", fileNamePattern: "{YYYY}年{MM}复盘.xlsx" } },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const result = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-monthly-rollover-guard-once",
    executor: async () => ({
      content: { type: "text" as const, text: "done" }, finished: true,
      data: { summary: "创建了文件。", stagedOutput: { operation: "create", fileName: "随便什么文件.xlsx", mimeType: XLSX_MIME, base64: boundBytes.toString("base64") } },
    }),
  });
  assert.equal(result.run.status, "failed");
  assert.match(result.run.errorMessage || "", /monthly target/);
});

test("monthly rollover policy validates the fileNamePattern (T-317)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const boundBytes = await convertCsvBytesToXlsx(Buffer.from("日期\n"));
  const bound = await assets.createUserAsset({
    ...scope, name: "行业复盘模式", fileName: "2020年03月行业复盘表.xlsx",
    mimeType: XLSX_MIME, bytes: boundBytes,
  });
  await assert.rejects(
    () => automation.createAutomationTask({
      ...scope,
      taskId: "generic-monthly-rollover-bad-pattern",
      name: "坏模式",
      instruction: "追加。",
      schedule: schedule(),
      output: { mode: "update", assetId: bound.assetId, versionPolicy: "latest", rollover: { kind: "monthly", fileNamePattern: "行业复盘.xlsx" } },
    }),
    /fileNamePattern/,
  );
  await assert.rejects(
    () => automation.createAutomationTask({
      ...scope,
      taskId: "generic-monthly-rollover-path-pattern",
      name: "路径模式",
      instruction: "追加。",
      schedule: schedule(),
      output: { mode: "update", assetId: bound.assetId, versionPolicy: "latest", rollover: { kind: "monthly", fileNamePattern: "../{YYYY}年{MM}.xlsx" } },
    }),
    /path separators/,
  );
});

test("agent-mode appendRows appends deterministically to the single bound XLSX (T-378, mg 2026-08-25 regression)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const runner = await import("../src/services/generic-automation-runner.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const bytes = await convertCsvBytesToXlsx(Buffer.from("日期,标的,收盘\n2026-08-24,示例,10\n"));
  const target = await assets.createUserAsset({ ...scope, name: "持仓明细", fileName: "2026-08-24 持仓与关注股日复盘明细.xlsx", mimeType: XLSX_MIME, bytes });
  const task = await automation.createAutomationTask({
    ...scope, taskId: "generic-agent-appendrows", name: "持仓复盘",
    instruction: "逐只生成一行明细，追加到当月汇总工作簿表尾。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });
  const result = await runner.runGenericAutomationTaskNow({
    scope, taskId: task.taskId, origin: "scheduled", idempotencyKey: "generic-agent-appendrows-once",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "已追加 2026-08-25 明细。",
      stagedOutput: { operation: "appendRows", rows: [["2026-08-25", "贵州茅台", 1500]], skipIfCellMatches: { column: 1, value: "2026-08-25" } },
    } }),
  });
  assert.equal(result.run.status, "succeeded", "agent mode + single XLSX binding must accept the prompt-recommended appendRows");
  assert.equal(result.run.outputAssetId, target.assetId);
  assert.notEqual(result.run.outputVersionId, target.currentVersionId);
  const ExcelJS = (await import("exceljs")).default;
  const current = await assets.readCurrentUserAsset({ ...scope, assetId: target.assetId });
  const workbook = new ExcelJS.Workbook();
  const buf = Buffer.from(current.bytes);
  await workbook.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const sheet = workbook.getWorksheet("数据")!;
  assert.deepEqual((sheet.getRow(sheet.rowCount).values as unknown[]).slice(1), ["2026-08-25", "贵州茅台", 1500]);

  const second = await assets.createUserAsset({ ...scope, name: "第二本账", fileName: "2026-08-24 第二明细.xlsx", mimeType: XLSX_MIME, bytes });
  const ambiguous = await automation.createAutomationTask({
    ...scope, taskId: "generic-agent-appendrows-ambiguous", name: "双账本",
    instruction: "追加明细。",
    schedule: schedule(),
    inputs: [
      { assetId: target.assetId, role: "input", versionPolicy: "latest" },
      { assetId: second.assetId, role: "input", versionPolicy: "latest" },
    ],
    output: { mode: "agent" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: ambiguous.taskId, expectedRevision: 1 });
  const ambiguousRun = await runner.runGenericAutomationTaskNow({
    scope, taskId: ambiguous.taskId, origin: "scheduled", idempotencyKey: "generic-agent-appendrows-ambiguous-once",
    executor: async () => ({ content: { type: "text" as const, text: "done" }, finished: true, data: {
      summary: "追加。", stagedOutput: { operation: "appendRows", rows: [["2026-08-25", "歧义", 1]] },
    } }),
  });
  assert.equal(ambiguousRun.run.status, "failed", "multiple XLSX bindings leave appendRows target ambiguous");
  assert.match(ambiguousRun.run.errorMessage || "", /exactly one XLSX workbook/);
  assert.equal(ambiguousRun.run.outputAssetId, null);
});

test("task edits inherit the monthly rollover unless explicitly cleared (2026-08-24 industry-review regression)", async () => {
  const { automation, assets } = await fixture;
  const { convertCsvBytesToXlsx } = await import("../src/services/csv-xlsx-conversion.js");
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const bytes = await convertCsvBytesToXlsx(Buffer.from("日期,行业\n"));
  const target = await assets.createUserAsset({ ...scope, name: "行业复盘继承", fileName: "2026年08月行业复盘表_序号分段版.xlsx", mimeType: XLSX_MIME, bytes });
  const rollover = { kind: "monthly" as const, fileNamePattern: "{YYYY}年{MM}月行业复盘表_序号分段版.xlsx" };
  const task = await automation.createAutomationTask({
    ...scope, taskId: "generic-rollover-inherit", name: "行业复盘",
    instruction: "追加当日行业复盘。",
    schedule: schedule(),
    inputs: [{ assetId: target.assetId, role: "input", versionPolicy: "latest" }],
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest", rollover },
  });
  const edited = await automation.updateAutomationTask({
    ...scope, taskId: task.taskId, expectedRevision: 1,
    instruction: "追加当日行业复盘，涨停公司字段改口径。",
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest" },
  });
  assert.equal(edited.currentRevision, 2);
  assert.deepEqual(edited.revision.output, { mode: "update", assetId: target.assetId, versionPolicy: "latest", rollover }, "an edit that re-sends the output without rollover must not strip it");

  const cleared = await automation.updateAutomationTask({
    ...scope, taskId: task.taskId, expectedRevision: 2,
    output: { mode: "update", assetId: target.assetId, versionPolicy: "latest", rollover: null },
  });
  assert.equal(cleared.currentRevision, 3);
  assert.deepEqual(cleared.revision.output, { mode: "update", assetId: target.assetId, versionPolicy: "latest" }, "an explicit rollover:null clears the policy");
});

test("parseStructuredAcpResponse extracts the trailing JSON object from mixed prose (mg 2026-08-26 failure shape)", async () => {
  const { parseStructuredAcpResponse } = await import("../src/services/generic-automation-runner.js");
  const { textResponse } = await import("../src/runtime/protocol.js");
  const payload = {
    summary: "已完成2026-08-26行业复盘表尾追加。",
    shouldNotify: true,
    stagedOutput: { operation: "appendRows", sheet: "行业复盘", rows: [[61, "2026-08-26", "有色金属"]], skipIfCellMatches: { column: "日期", value: "2026-08-26" } },
  };
  const prose = `I have gathered the key evidence. Now I'll append today's rows.\n\nKey data compiled: {"note": "inline brace { in prose"} and more narration.\n\n${JSON.stringify(payload)}`;
  const parsed = parseStructuredAcpResponse(textResponse(prose));
  assert.equal(parsed.data?.summary, payload.summary);
  assert.deepEqual(parsed.data?.stagedOutput, payload.stagedOutput);
  assert.equal(parsed.data?.shouldNotify, true);
});

test("parseStructuredAcpResponse prefers the last JSON object and tolerates trailing prose", async () => {
  const { parseStructuredAcpResponse } = await import("../src/services/generic-automation-runner.js");
  const { textResponse } = await import("../src/runtime/protocol.js");
  const earlier = { summary: "草稿版本" };
  const final = { summary: "最终版本", outputSkipped: true };
  const mixed = `${JSON.stringify(earlier)}\n中间叙述。\n${JSON.stringify(final)}\n尾随说明文字。`;
  const parsed = parseStructuredAcpResponse(textResponse(mixed));
  assert.equal(parsed.data?.summary, "最终版本");
  assert.equal(parsed.data?.outputSkipped, true);
});

test("parseStructuredAcpResponse keeps failing closed on prose without a valid envelope", async () => {
  const { parseStructuredAcpResponse } = await import("../src/services/generic-automation-runner.js");
  const { textResponse } = await import("../src/runtime/protocol.js");
  for (const text of [
    "纯叙述回复，没有任何 JSON。",
    "未闭合的对象 {\"summary\": \"被截断",
    "{\"unrelated\": true}",
    "```json\n{\"summary\": 42}\n```",
  ]) {
    const parsed = parseStructuredAcpResponse(textResponse(text));
    assert.equal(parsed.data, undefined, `expected no envelope for: ${text.slice(0, 40)}`);
  }
});

test("parseStructuredAcpResponse still accepts whole-text and fenced envelopes unchanged", async () => {
  const { parseStructuredAcpResponse } = await import("../src/services/generic-automation-runner.js");
  const { textResponse } = await import("../src/runtime/protocol.js");
  const whole = parseStructuredAcpResponse(textResponse(JSON.stringify({ summary: "整段即JSON" })));
  assert.equal(whole.data?.summary, "整段即JSON");
  const fenced = parseStructuredAcpResponse(textResponse("说明\n```json\n" + JSON.stringify({ summary: "围栏JSON", shouldNotify: false }) + "\n```"));
  assert.equal(fenced.data?.summary, "围栏JSON");
});

test("generic automation supports an operator model pin via GENERIC_AUTOMATION_MODEL (mgreplay replay 2026-08-27)", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.ok(runnerSource.includes("GENERIC_AUTOMATION_MODEL"), "env pin must exist");
  assert.ok(runnerSource.includes("...(pinnedModel ? { model: pinnedModel } : {})"), "pin must land in the ACP context model field");
});

test("service tool manifest is trimmed to the mcpAllowedTools grant (glm stall diagnosis 2026-08-27)", async () => {
  const { filterServiceToolsByGrant } = await import("../src/mastra/tools/mastra-tools.js");
  const full = { "market_watch.snapshot": { id: 1 }, "automation.create": { id: 2 }, "spreadsheet.create": { id: 3 } };
  const grant = ["market_watch.snapshot", "spreadsheet.create"];
  const filtered = filterServiceToolsByGrant(full, grant);
  assert.deepEqual(Object.keys(filtered).sort(), ["market_watch.snapshot", "spreadsheet.create"]);
  // 空/缺省 grant 不裁剪（交互轮保持全量）。
  assert.equal(filterServiceToolsByGrant(full, undefined), full);
  assert.equal(filterServiceToolsByGrant(full, []), full);
});

test("validation failures trigger one repair round-trip with the validator error fed back (owner 2026-08-27 B plan)", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.ok(runnerSource.includes("repairContext: { previousReply"), "runner must feed the previous reply and validator error back");
  assert.ok(runnerSource.includes("GENERIC_AUTOMATION_REPAIR_MIN_REMAINING_MS"), "repair must be budget-gated");
  assert.ok(runnerSource.includes("AUTOMATION_RUN_INVALID_RESULT") && runnerSource.includes("只救"), "only contract violations get a repair round");
  assert.ok(runnerSource.includes("不要重新取数、不要从头重做"), "repair directive must preserve prior work");
  assert.ok(runnerSource.includes("上一轮被拒原因"), "validator error must be quoted in the repair directive");
});
