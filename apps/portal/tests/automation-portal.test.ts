import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeAutomationTask, sanitizeAutomationRun } from "../src/lib/automation-api";
import { normalizeAutomationSchedule } from "../src/components/automation/api";
import {
  automationCreateSchema,
  automationListQuerySchema,
  automationRunsListQuerySchema,
  automationUpdateSchema,
  automationScheduleSchema,
  AUTOMATION_FILE_ACCEPT,
  AUTOMATION_INPUT_FILE_ACCEPT,
  AUTOMATION_TIMEZONE,
  isSupportedAutomationInputFileName,
  isSupportedAutomationFileName,
} from "../src/lib/automation-schemas";
import { PORTAL_TYPES } from "../src/lib/protocol";
import { statusForCode } from "../src/lib/protocol/error-status";
import { AUTOMATION_TEMPLATES } from "../src/lib/automation-templates";

test("automation protocol exposes every connector command", () => {
  assert.deepEqual(
    [
      PORTAL_TYPES.AUTOMATION_LIST,
      PORTAL_TYPES.AUTOMATION_GET,
      PORTAL_TYPES.AUTOMATION_CREATE,
      PORTAL_TYPES.AUTOMATION_UPDATE,
      PORTAL_TYPES.AUTOMATION_ACTIVATE,
      PORTAL_TYPES.AUTOMATION_PAUSE,
      PORTAL_TYPES.AUTOMATION_BATCH_ACTION,
      PORTAL_TYPES.AUTOMATION_RUN_NOW,
      PORTAL_TYPES.AUTOMATION_RUNS_LIST,
      PORTAL_TYPES.AUTOMATION_RUN_GET,
      PORTAL_TYPES.AUTOMATION_ASSET_GET,
      PORTAL_TYPES.AUTOMATION_CONTINUE_IN_CHAT,
    ],
    [
      "automation.list",
      "automation.get",
      "automation.create",
      "automation.update",
      "automation.activate",
      "automation.pause",
      "automation.batch_action",
      "automation.run_now",
      "automation.runs.list",
      "automation.run.get",
      "automation.asset.get",
      "automation.continue_in_chat",
    ],
  );
});

test("automation HTTP request schemas reject browser scope fields", () => {
  const sourceAsset = { fileName: "tracker.csv", base64: "YQ==" };
  const valid = {
    name: "Daily tracker",
    description: "Maintain rows",
    schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
    sourceAsset,
  };
  assert.equal(automationCreateSchema.safeParse(valid).success, true);
  assert.equal(automationCreateSchema.safeParse({ ...valid, schedule: { ...valid.schedule, timezone: "UTC" } }).success, false);
  assert.equal(automationCreateSchema.safeParse({ ...valid, userId: "another-user" }).success, false);
  assert.equal(automationUpdateSchema.safeParse({ taskId: "at_1", name: "New name", projectId: "other" }).success, false);
  assert.equal(automationUpdateSchema.safeParse({ taskId: "at_1", schedule: { ...valid.schedule, timezone: "UTC" } }).success, false);
  assert.equal(automationScheduleSchema.safeParse({ frequency: "weekly", time: "07:30", timezone: "Asia/Shanghai" }).success, false);
});

test("automation editor defaults to Shanghai and only exposes supported spreadsheet types", () => {
  assert.equal(AUTOMATION_TIMEZONE, "Asia/Shanghai");
  assert.ok(AUTOMATION_FILE_ACCEPT.includes(".csv"));
  assert.ok(AUTOMATION_FILE_ACCEPT.includes(".xlsx"));
  assert.ok(AUTOMATION_INPUT_FILE_ACCEPT.includes(".pdf"));
  assert.ok(AUTOMATION_INPUT_FILE_ACCEPT.includes(".md"));
  assert.equal(isSupportedAutomationFileName("tracking.csv"), true);
  assert.equal(isSupportedAutomationFileName("tracking.XLSX"), true);
  assert.equal(isSupportedAutomationFileName("tracking.xls"), false);
  assert.equal(isSupportedAutomationFileName("brief.pdf"), false);
  assert.equal(isSupportedAutomationInputFileName("research-brief.pdf"), true);
  assert.equal(isSupportedAutomationInputFileName("company-chart.webp"), true);
  assert.equal(isSupportedAutomationInputFileName("archive.zip"), false);
  assert.equal(normalizeAutomationSchedule({ frequency: "daily", time: "07:30", timezone: "UTC" }).timezone, AUTOMATION_TIMEZONE);
  assert.equal(automationCreateSchema.safeParse({
    name: "Unsupported file",
    schedule: { frequency: "daily", time: "07:30", timezone: AUTOMATION_TIMEZONE },
    sourceAsset: { fileName: "brief.pdf", base64: "YQ==" },
  }).success, false);
  assert.equal(automationCreateSchema.safeParse({
    name: "Conditional delivery",
    instruction: "仅在满足条件时推送。",
    schedule: { frequency: "daily", time: "07:30", timezone: AUTOMATION_TIMEZONE },
    output: { mode: "none" },
    delivery: { mode: "wechat_on_condition", conditionVersion: 1 },
  }).success, true);
  assert.equal(automationCreateSchema.safeParse({
    name: "Agent managed attachment",
    instruction: "根据附件决定是否更新文件。",
    schedule: { frequency: "weekly", time: "14:30", timezone: AUTOMATION_TIMEZONE, weekdays: [4] },
    inputs: [{ assetId: "asset_1", role: "input", versionPolicy: "latest" }],
    output: { mode: "agent" },
  }).success, true);
  assert.equal(automationListQuerySchema.safeParse({ outputModes: "create" }).success, true);
  assert.equal(automationRunsListQuerySchema.safeParse({ hasOutput: "true" }).data?.hasOutput, true);
});

test("automation can bind an existing user file without uploading it again", () => {
  const request = {
    name: "Maintain tracker",
    description: "Update my tracker every week.",
    instruction: "Update my tracker every week.",
    schedule: { frequency: "weekly", time: "14:30", timezone: AUTOMATION_TIMEZONE, weekdays: [4] },
    inputs: [{ assetId: "asset_existing_csv", role: "update_target", versionPolicy: "latest" }],
    output: { mode: "update", assetId: "asset_existing_csv", versionPolicy: "latest" },
  };
  const parsed = automationCreateSchema.safeParse(request);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.sourceAsset, undefined);
  assert.deepEqual(parsed.data?.inputs, request.inputs);
  assert.deepEqual(parsed.data?.output, request.output);
});

test("Portal redacts runtime connector scope from automation responses", () => {
  const task = sanitizeAutomationTask({
    userId: "user-a",
    instanceId: "instance-a",
    projectId: "project-a",
    taskId: "at_1",
    status: "paused",
    currentRevision: 1,
    consecutiveFailures: 0,
    revision: {
      userId: "user-a",
      instanceId: "instance-a",
      projectId: "project-a",
      revisionId: "rev_1",
      taskId: "at_1",
      revision: 1,
      name: "Daily tracker",
      schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
      createdAt: "2026-08-05T00:00:00Z",
    },
    sourceAsset: {
      userId: "user-a",
      instanceId: "instance-a",
      projectId: "project-a",
      assetId: "asset_1",
      taskId: "at_1",
      assetRole: "source",
      fileName: "tracker.csv",
      relativePath: "automations/at_1/source/tracker.csv",
      mimeType: "text/csv",
      extension: ".csv",
      sizeBytes: 1,
      checksum: "sha",
      createdAt: "2026-08-05T00:00:00Z",
      updatedAt: "2026-08-05T00:00:00Z",
    },
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
  } as never);
  assert.equal("userId" in (task as unknown as Record<string, unknown>), false);
  assert.equal("userId" in (task.revision as unknown as Record<string, unknown>), false);
  assert.equal("projectId" in (task.sourceAsset as unknown as Record<string, unknown>), false);

  const run = sanitizeAutomationRun({
    userId: "user-a",
    instanceId: "instance-a",
    projectId: "project-a",
    runId: "run_1",
    taskId: "at_1",
    revisionId: "rev_1",
    origin: "manual",
    idempotencyKey: "portal:1",
    revision: 3,
    inputVersions: [{ assetId: "asset_1", versionId: "version_7" }],
    taskName: "历史任务名称",
    leaseToken: "must-not-reach-browser",
    leaseExpiresAt: "2026-08-05T00:15:00Z",
    status: "succeeded",
    claimedAt: "2026-08-05T00:00:00Z",
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:00:00Z",
  } as never);
  assert.equal("instanceId" in (run as unknown as Record<string, unknown>), false);
  assert.equal("leaseToken" in (run as unknown as Record<string, unknown>), false);
  assert.equal("leaseExpiresAt" in (run as unknown as Record<string, unknown>), false);
  assert.equal(run.revision, 3);
  assert.deepEqual(run.inputVersions, [{ assetId: "asset_1", versionId: "version_7" }]);
  assert.equal(run.taskName, "历史任务名称");
});

test("automation connector errors map to stable HTTP statuses", () => {
  assert.equal(statusForCode("AUTOMATION_TASK_NOT_FOUND"), 404);
  assert.equal(statusForCode("AUTOMATION_REVISION_CONFLICT"), 409);
  assert.equal(statusForCode("AUTOMATION_ASSET_UNSUPPORTED_TYPE"), 415);
  assert.equal(statusForCode("AUTOMATION_ASSET_INVALID_CONTENT"), 422);
  assert.equal(statusForCode("AUTOMATION_SCOPE_MISMATCH"), 403);
  assert.equal(statusForCode("AUTOMATION_RUN_LEASE_LOST"), 409);
  assert.equal(statusForCode("AUTOMATION_TASK_BUSY"), 409);
});

test("automation template presets are valid create requests and contain no caller scope", () => {
  assert.equal(AUTOMATION_TEMPLATES.length, 6);
  const templates = new Map(AUTOMATION_TEMPLATES.map((template) => [template.templateId, template]));
  assert.deepEqual(templates.get("daily-market-information")?.preset.schedule, { frequency: "trading_days", time: "08:30", timezone: "Asia/Shanghai" });
  assert.deepEqual(templates.get("industry-major-dynamics")?.preset.schedule, { frequency: "daily", time: "09:00", timezone: "Asia/Shanghai" });
  assert.deepEqual(templates.get("portfolio-company-announcements")?.preset.schedule, { frequency: "trading_days", time: "18:30", timezone: "Asia/Shanghai" });
  assert.deepEqual(templates.get("weekly-watchlist-review")?.preset.output, { mode: "agent" });
  assert.deepEqual(templates.get("weekly-research-digest")?.preset.output, { mode: "agent" });
  assert.deepEqual(templates.get("update-investment-tracker")?.requirements, ["update_asset"]);
  assert.deepEqual(templates.get("daily-market-information")?.preset.delivery, { mode: "wechat_on_condition", conditionVersion: 1 });
  for (const template of AUTOMATION_TEMPLATES) {
    const parsed = automationCreateSchema.safeParse(template.preset);
    assert.equal(parsed.success, true, `${template.templateId} preset should pass the create schema`);
    assert.equal("userId" in template.preset, false);
    assert.equal("projectId" in template.preset, false);
    assert.equal("instanceId" in template.preset, false);
  }
});
