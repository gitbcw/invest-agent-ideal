#!/usr/bin/env node
/**
 * glm-5.3-flash 空响应受控复现（owner 2026-09-14 晚授权「用 mgreplay 用户尝试复现」）。
 * 背景：9-14 当天 glm-5.3-flash(-high) 在 4 个自动化 run 上 MASTRA_EMPTY_RESPONSE
 * （06:35 ~69K / 09:35 ~837K / 11:34 ~337K / 14:02 ~763K tokens），全部被轮内兜底吸收。
 * 方法：mgreplay scope 下建一次性只读统计任务（output mode=agent，无写入、无输出契约
 * 校验），pin GENERIC_AUTOMATION_MODEL=glm-5.3-flash（user-selection lock，无轮内
 * 兜底，空响应直接显形为 run failed）连跑 N 次，观测空响应率。
 * 用法（生产 /home/claude/invest-agent-mastra 下执行）：
 *   GENERIC_AUTOMATION_MODEL 不设——脚本内部固定写入本进程 env，不影响 PM2 进程。
 */
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
process.env.GENERIC_AUTOMATION_MODEL = "glm-5.3-flash";
const PINNED = process.env.GENERIC_AUTOMATION_MODEL;
const ATTEMPTS = Number(process.env.REPRO_ATTEMPTS ?? 3);
const SCOPE = { userId: "mgreplay", projectId: "invest-agent", instanceId: "invest-agent-mgreplay" };
const MIRROR_TASK = "mgreplay-industry-chain-test";
const TASK_ID = "mgreplay-glm-empty-repro-20260914";
const INSTRUCTION = [
  "读取绑定的工作簿文件，统计其中每个复盘日期的行数，并按日期顺序列出各日期下的行业名称清单，以文字清单形式输出统计结果。",
  "本次为只读统计任务：不调用任何写入类工具，不修改、不追加、不新建任何文件。",
].join("\n");

const { sqlite } = await import("../dist/db/index.js");
const { createAutomationTask, activateAutomationTask, pauseAutomationTask } = await import("../dist/services/automation-tasks.js");
const { runGenericAutomationTaskNow } = await import("../dist/services/generic-automation-runner.js");

const mirrorRev = sqlite.prepare("SELECT revision, output_json FROM automation_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1").get(MIRROR_TASK);
const assetId = JSON.parse(mirrorRev.output_json || "{}").assetId;
if (!assetId) { console.error("[repro] mirror task has no bound asset"); process.exit(2); }
console.log(`[repro] mirror=${MIRROR_TASK} rev${mirrorRev.revision} asset=${assetId} → use as read-only input`);

const dup = sqlite.prepare("SELECT task_id, status FROM automation_tasks WHERE task_id = ?").get(TASK_ID);
if (dup) { console.error(`[repro] repro task already exists (${dup.status}) — refusing duplicate`); process.exit(2); }

const created = await createAutomationTask({
  ...SCOPE, taskId: TASK_ID, name: "glm 空响应复现（只读统计·一次性）",
  instruction: INSTRUCTION, schedule: { frequency: "trading_days", time: "19:30", timezone: "Asia/Shanghai" },
  inputs: [{ assetId, role: "input", versionPolicy: "latest" }],
  output: { mode: "agent" }, delivery: { mode: "none" },
  editSource: "script", editSourceRef: "mgreplay-glm-empty-repro-20260914",
});
await activateAutomationTask({ ...SCOPE, taskId: TASK_ID, expectedRevision: created.currentRevision });
console.log(`[repro] task created rev${created.currentRevision} pinned=${PINNED} attempts=${ATTEMPTS}`);

const results = [];
try {
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    const started = Date.now();
    try {
      const result = await runGenericAutomationTaskNow({
        scope: SCOPE, taskId: TASK_ID, origin: "manual",
        idempotencyKey: `glm-repro-${new Date().toISOString().slice(0, 16)}-a${i}`,
      });
      const run = result.run;
      const trace = sqlite.prepare("SELECT agent_model, status, elapsed_ms, input_tokens, output_tokens, first_token_ms FROM agent_traces WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(run.runId);
      results.push({ attempt: i, status: run.status, error: run.errorMessage ?? null });
      console.log(`[repro] #${i} ${run.status} in ${Math.round((Date.now() - started) / 1000)}s err=${(run.errorMessage ?? "none").slice(0, 160)}`);
      if (trace) console.log(`[repro] #${i} trace: ${trace.agent_model} ${trace.status} in=${trace.input_tokens} out=${trace.output_tokens} ft=${trace.first_token_ms}ms`);
    } catch (e) {
      results.push({ attempt: i, status: "threw", error: String(e).slice(0, 200) });
      console.log(`[repro] #${i} threw: ${String(e).slice(0, 200)}`);
    }
  }
} finally {
  try { await pauseAutomationTask({ ...SCOPE, taskId: TASK_ID }); console.log("[repro] task paused"); }
  catch (e) { console.log(`[repro] pause failed: ${String(e).slice(0, 160)}`); }
}
const empty = results.filter((r) => (r.error ?? "").includes("MASTRA_EMPTY_RESPONSE")).length;
console.log(`[repro] summary: ${empty}/${results.length} MASTRA_EMPTY_RESPONSE — ${JSON.stringify(results.map(r => `${r.attempt}:${r.status}`))}`);
