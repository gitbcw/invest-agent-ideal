#!/usr/bin/env node
/**
 * W7 B1 观察期前置验证：服务器侧隔离真模型回放（2026-09-21 owner 要求提前验证）。
 *
 * 用当天生产终态的隔离副本（在线备份 DB + 项目树拷贝），在装配模式下用
 * 真实模型网关逐个回放 mg 全部 active 任务 + weixin-mobile 渠道装配构造。
 * 纪律：隔离 DB/隔离项目根（脚本硬校验路径含 w7-b1/replay，防指错生产）；
 * push job 只入队不消费（零真实投递）；不改生产任何数据。
 *
 * 用法（服务器）：
 *   DB_PATH=.backup/w7-b1/replay/runtime.db WORKSPACE_ROOT=.backup/w7-b1/replay/workspaces \
 *   RUNTIME_DATA_ROOT=.backup/w7-b1/replay/runtime-data MASTRA_PROJECTS_ROOT=.backup/w7-b1/replay/projects \
 *   SYSTEM_SKILLS_TEMPLATE_ROOT=.backup/w7-b1/replay/templates NODE_ENV=production \
 *   AGENT_SPACE_ASSEMBLY_MODE=scope:mg \
 *   node scripts/agent-space/w7-b1-verify-replay.mjs --out .backup/w7-b1/replay/report.jsonl
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const outFile = argOf("out");
if (!outFile) {
  console.error("usage: w7-b1-verify-replay.mjs --out <report.jsonl>");
  process.exit(2);
}
for (const guard of [process.env.DB_PATH ?? "", process.env.MASTRA_PROJECTS_ROOT ?? ""]) {
  if (!guard.includes("w7-b1/replay")) {
    console.error(`refusing: ${guard || "(unset)"} 不在 w7-b1/replay 隔离目录内（防误指生产）`);
    process.exit(2);
  }
}
if (process.env.NODE_ENV !== "production") {
  console.error("refusing: 本回放要求 NODE_ENV=production（加载真实模型网关配置；隔离根已由上面的硬校验保证）");
  process.exit(2);
}
mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
writeFileSync(outFile, "", { mode: 0o600 });
const emit = (record) => {
  appendFileSync(outFile, JSON.stringify(record) + "\n");
  console.log(JSON.stringify({ ...record, at: record.at ?? new Date().toISOString() }));
};

async function importAppModule(relative) {
  for (const base of ["../../src", "../../dist"]) {
    try { return await import(new URL(`${base}/${relative}`, import.meta.url).href); }
    catch { /* 尝试下一个基目录 */ }
  }
  throw new Error(`cannot resolve app module: ${relative}`);
}

const db = await importAppModule("db/index.js");
db.initDb();
const { sqlite } = db;
const runner = await importAppModule("services/generic-automation-runner.js");
const { buildAgentSpaceTurnOptions } = await importAppModule("runtime/agent-space-context.js");

const scope = { userId: "mg", projectId: "invest-agent", instanceId: "invest-agent-mg" };
const tasks = sqlite
  .prepare("SELECT task_id, task_type, status FROM automation_tasks WHERE user_id=? AND status='active' ORDER BY task_id")
  .all(scope.userId);
emit({ step: "tasks-found", count: tasks.length, taskIds: tasks.map((t) => t.task_id) });

for (const task of tasks) {
  const startedAt = Date.now();
  try {
    const result = await runner.runGenericAutomationTaskNow({
      scope, taskId: task.task_id, origin: "manual",
      idempotencyKey: `w7b1-replay-${task.task_id.slice(0, 18)}-${Date.now()}`,
    });
    const basisRow = sqlite
      .prepare("SELECT basis_json FROM agent_space_run_basis WHERE basis_key LIKE ?")
      .get(`%run:${result.run.runId}:basis`);
    const basis = basisRow ? JSON.parse(basisRow.basis_json) : null;
    const outcomes = sqlite
      .prepare("SELECT kind FROM agent_space_run_outcomes WHERE run_id=? ORDER BY rowid")
      .all(result.run.runId)
      .map((r) => r.kind);
    emit({
      step: "task-replay", taskId: task.task_id, taskType: task.task_type,
      status: result.run.status, durationMs: Date.now() - startedAt,
      error: result.run.error_message ?? null, errorCategory: result.run.error_category ?? null,
      basis: basis ? { entryKind: basis.entryKind, methods: (basis.methods ?? []).map((m) => ({ methodId: m.methodId, checksum: (m.contentChecksum ?? "").slice(0, 8) })), skipped: (basis.skipped ?? []).map((s) => String(s.reason ?? s.ref ?? "").slice(0, 60)) } : null,
      outcomes, deliveryStatus: result.run.delivery_status ?? null, outputAssetId: result.run.output_asset_id ?? null,
    });
  } catch (error) {
    emit({ step: "task-replay", taskId: task.task_id, taskType: task.task_type, status: "thrown", durationMs: Date.now() - startedAt, error: String(error.message ?? error).slice(0, 300) });
  }
}

// weixin-mobile 渠道装配构造（渠道 L1 规则 + 四因子注入；不发起模型调用）
try {
  const options = await buildAgentSpaceTurnOptions({
    scope, conversationId: "w7b1-replay-wx-conv", messageId: "w7b1-replay-wx-msg",
    channel: "weixin-mobile", entryKind: "conversation",
    grantedTools: {}, toolAllowlist: null,
  });
  const instructions = options.instructions;
  emit({
    step: "weixin-channel-assembly",
    instructionChars: instructions.length,
    markerAgentSpace: instructions.includes("Agent Space 装配"),
    markerFourFactor: instructions.includes("控盘度综合评分"),
    markerWeixinRules: /微信|weixin/i.test(instructions),
    workspaceAbsent: !("workspace" in options) || options.workspace === undefined,
    basisKey: options.basisKey,
  });
} catch (error) {
  emit({ step: "weixin-channel-assembly", status: "thrown", error: String(error.message ?? error).slice(0, 300) });
}

// push job 只入队未消费（零真实投递）——记录在案
const queuedJobs = sqlite.prepare("SELECT status, COUNT(*) AS n FROM push_jobs GROUP BY status").all();
emit({ step: "push-jobs-queued-not-consumed", jobs: queuedJobs, note: "隔离库内排队，未执行任何真实投递" });
emit({ step: "done" });
process.exit(0);
