#!/usr/bin/env node
/**
 * One-time fix (2026-09-12): owner 2026-09-11 晚间二次裁决——行业复盘
 * 「行业名称」的一级/二级口径属 agent 判断区，不再绑申万词表。本脚本把
 * mg 行业复盘任务的列规则从枚举白名单（rev22 一级 31 / rev23 一级∪二级）
 * 重切为 kind=text 格式级规则（非空 + 30 字上限 + 括号闭合截断检测），
 * 并把口径约束写入任务说明（agent 判断区）。
 *
 * 前置：先部署含 kind=text 校验的代码，再跑本脚本（旧校验器会忽略
 * text 规则的 maxLength/balancedBrackets，先切规则后部署等于裸奔）。
 * 幂等：col4 已是 kind=text 且说明已含口径行时跳过。
 * 用法（生产，部署后）：node scripts/industry-review-caliber-to-agent.mjs [--dry-run]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const dryRun = process.argv.includes("--dry-run");
const TASK_ID = "at_60d62fcb-5eb3-4e0e-b70b-6203680a750d"; // mg 行业复盘（trading_days 19:30 update）
const CALIBER_LINE = "行业名称口径由你按当日复盘主线判断：申万一级或二级粒度均可，同一交易日内保持粒度一致；必须使用数据源的完整行业名，禁止截断、简写或自造合并名。";

const rules = JSON.parse(readFileSync(new URL("./industry-review-column-rules.json", import.meta.url), "utf8"));
if (rules["4"]?.kind !== "text") {
  console.error("[caliber] rules JSON col4 is not kind=text — refusing to run with a stale rules file");
  process.exit(2);
}

const { sqlite } = await import("../dist/db/index.js");
const { updateAutomationTask, activateAutomationTask } = await import("../dist/services/automation-tasks.js");

const taskRow = sqlite.prepare("SELECT task_id, user_id, project_id, instance_id, status FROM automation_tasks WHERE task_id = ?").get(TASK_ID);
if (!taskRow) { console.error(`[caliber] task not found: ${TASK_ID}`); process.exit(2); }
const scope = { userId: taskRow.user_id, projectId: taskRow.project_id, instanceId: taskRow.instance_id };
const rev = sqlite.prepare(`
  SELECT revision, name, instruction, schedule_json, inputs_json, output_json, delivery_json
  FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1
`).get(TASK_ID);
const output = JSON.parse(rev.output_json || "{}");
const col4 = output.expectedSchema?.columnRules?.["4"];
const instructionDone = (rev.instruction || "").includes(CALIBER_LINE);

if (col4?.kind === "text" && instructionDone) {
  console.log(`[caliber] rev${rev.revision} already caliber-to-agent, skip`);
  process.exit(0);
}

const nextInstruction = instructionDone ? rev.instruction : `${rev.instruction}\n${CALIBER_LINE}`;
console.log(`[caliber] task rev${rev.revision} col4=${JSON.stringify(col4)?.slice(0, 80)}… -> ${JSON.stringify(rules["4"])}`);
console.log(`[caliber] instruction +caliber line (${instructionDone ? "already present" : "appending"})`);
if (dryRun) { console.log("[caliber] dry-run, no changes"); process.exit(0); }

const updated = await updateAutomationTask({
  ...scope,
  taskId: TASK_ID,
  expectedRevision: rev.revision,
  name: rev.name,
  instruction: nextInstruction,
  schedule: JSON.parse(rev.schedule_json || "{}"),
  inputs: JSON.parse(rev.inputs_json || "[]"),
  output: { ...output, expectedSchema: { ...output.expectedSchema, columnRules: rules } },
  delivery: JSON.parse(rev.delivery_json || "{}"),
  editSource: "script",
  editSourceRef: "industry-caliber-to-agent-20260912",
});
if (taskRow.status === "active") {
  const active = await activateAutomationTask({ ...scope, taskId: TASK_ID, expectedRevision: updated.currentRevision });
  console.log(`[caliber] committed rev${updated.currentRevision} status=${active.status} next_run=${active.nextRunAt ?? "n/a"}`);
} else {
  console.log(`[caliber] committed rev${updated.currentRevision} kept status=${taskRow.status}`);
}
const check = sqlite.prepare("SELECT output_json, instruction FROM automation_task_revisions WHERE task_id = ? AND revision = ?").get(TASK_ID, updated.currentRevision);
const committedCol4 = JSON.parse(check.output_json).expectedSchema?.columnRules?.["4"];
console.log(`[caliber] verify col4=${JSON.stringify(committedCol4)} caliberLine=${check.instruction.includes(CALIBER_LINE)}`);
