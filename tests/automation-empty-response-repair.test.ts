import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-automation-empty-repair-"));
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
  const sqlite = db.sqlite;
  return { db, automation, sqlite };
})();

const scope = { userId: "empty-repair-user", projectId: "invest-agent", instanceId: "empty-repair-instance" };

function schedule() {
  return { frequency: "daily" as const, time: "07:30", timezone: "Asia/Shanghai" };
}

/** Simulate the failing AgentResponse shape produced by the runtime for
 * MASTRA_EMPTY_RESPONSE (executionStatus=failed + preserved error code). */
function emptyResponseFailure() {
  return {
    content: { type: "text" as const, text: "" },
    finished: true,
    data: {
      executionStatus: "failed",
      executionErrorCode: "MASTRA_EMPTY_RESPONSE",
      executionErrorCategory: "unknown",
    },
  };
}

/** Seed one automation_tool_payloads observation row for the given run
 * (the T-459 table the runtime writes via recordAgentTrace). */
function seedToolPayload(sqlite: import("better-sqlite3").Database, runId: string, output: string) {
  sqlite.prepare(`
    INSERT INTO automation_tool_payloads (run_id, user_id, project_id, instance_id, tool_call_id, tool_name, status, output_payload, created_at)
    VALUES (?, ?, 'invest-agent', ?, ?, 'get_hist_klines', 'success', ?, ?)
  `).run(runId, scope.userId, scope.instanceId, `${runId}-call-1`, output, new Date().toISOString());
}

test("empty-response runs get one tool-log repair turn and can still succeed (T-595)", async () => {
  const { automation, sqlite } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-basic",
    name: "空响应修复轮",
    instruction: "整理结果。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  const calls: Array<{ runId: string; toolWorkLog?: string }> = [];
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-basic-once",
    executor: async (input) => {
      calls.push({ runId: input.run.runId, toolWorkLog: input.repairContext?.toolWorkLog });
      if (input.repairContext?.toolWorkLog) {
        return {
          content: { type: "text" as const, text: "done" },
          finished: true,
          data: { summary: "基于已完成取数补交的最终摘要。" },
        };
      }
      seedToolPayload(sqlite, input.run.runId, "{\"close\":1520.5}");
      return emptyResponseFailure();
    },
  });

  assert.equal(calls.length, 2, "exactly one repair turn must follow the empty-response failure");
  assert.equal(result.run.status, "succeeded", "the repaired turn must complete the run");
  assert.ok(calls[1].toolWorkLog?.includes("get_hist_klines"), "the repair turn must receive the observed tool work log");
  assert.ok(calls[1].toolWorkLog?.includes("1520.5"), "the work log must carry tool outputs");
});

test("empty-response without observed tool work fails without a repair turn", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-no-log",
    name: "无工作记录",
    instruction: "整理结果。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  let calls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-no-log-once",
    executor: async () => {
      calls += 1;
      return emptyResponseFailure();
    },
  });
  assert.equal(calls, 1, "no repair turn without tool observations");
  assert.equal(result.run.status, "failed");
  assert.match(result.run.errorMessage || "", /MASTRA_EMPTY_RESPONSE/);
});

test("a repair turn that fails again closes the run without further retries", async () => {
  const { automation, sqlite } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-still-empty",
    name: "修复轮仍空",
    instruction: "整理结果。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  let calls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-still-empty-once",
    executor: async (input) => {
      calls += 1;
      if (calls === 1) seedToolPayload(sqlite, input.run.runId, "{\"close\":1520.5}");
      return emptyResponseFailure();
    },
  });
  assert.equal(calls, 2, "repair turn happens once; no third attempt");
  assert.equal(result.run.status, "failed");
});

test("non-empty failures never trigger the repair turn", async () => {
  const { automation, sqlite } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-other-code",
    name: "其它错误码",
    instruction: "整理结果。",
    schedule: schedule(),
    output: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  let calls = 0;
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-other-code-once",
    executor: async (input) => {
      calls += 1;
      seedToolPayload(sqlite, input.run.runId, "{\"close\":1520.5}");
      return {
        content: { type: "text" as const, text: "" },
        finished: true,
        data: { executionStatus: "failed", executionErrorCode: "MASTRA_TURN_TIMEOUT" },
      };
    },
  });
  assert.equal(calls, 1, "timeout failures keep the existing no-retry semantics");
  assert.equal(result.run.status, "failed");
});

test("failed review runs with a published artifact still deliver the archived report (T-595 compensation)", async () => {
  const { automation, sqlite } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const { publishServiceOwnedReviewArtifact } = await import("../src/services/conversation-artifacts.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-compensate-delivery",
    taskType: "scheduled-daily-review",
    name: "日报补偿投递",
    instruction: "生成日复盘并调用 reviews.save。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "wechat_summary" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  // Mirror the 2026-10-12 111 daily-review incident: reviews.save published the
  // report inside the run window, then the model produced no final reply.
  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-compensate-once",
    executor: async (input) => {
      const target = runner.resolveGenericAutomationReviewTarget(task, input.run)!;
      await publishServiceOwnedReviewArtifact({
        ...scope,
        assistantId: scope.instanceId,
        conversationId: target.conversationId,
        kind: target.kind,
        reportKey: target.reportKey,
        content: "# daily report\n",
      });
      return emptyResponseFailure();
    },
  });

  assert.equal(result.run.status, "failed", "compensation must not mask the failure");
  assert.match(result.run.errorMessage || "", /MASTRA_EMPTY_RESPONSE/);
  assert.equal(result.run.deliveryStatus, "pending", "the archived report must still be enqueued for delivery");
  const job = sqlite.prepare("SELECT message AS message FROM push_jobs WHERE idempotency_key = ?")
    .get(`automation:${result.run.runId}:delivery`) as { message?: string } | undefined;
  assert.ok(job?.message, "a compensation push job exists");
});

test("failed review runs without an archived artifact deliver nothing extra", async () => {
  const { automation } = await fixture;
  const runner = await import("../src/services/generic-automation-runner.js");
  const task = await automation.createAutomationTask({
    ...scope,
    taskId: "empty-repair-no-artifact",
    taskType: "scheduled-daily-review",
    name: "无落稿不补偿",
    instruction: "生成日复盘并调用 reviews.save。",
    schedule: schedule(),
    output: { mode: "none" },
    delivery: { mode: "wechat_summary" },
  });
  await automation.activateAutomationTask({ ...scope, taskId: task.taskId, expectedRevision: 1 });

  const result = await runner.runGenericAutomationTaskNow({
    scope,
    taskId: task.taskId,
    origin: "scheduled",
    idempotencyKey: "empty-repair-no-artifact-once",
    executor: async () => emptyResponseFailure(),
  });
  assert.equal(result.run.status, "failed");
  assert.notEqual(result.run.deliveryStatus, "pending", "no artifact means no compensation delivery");
});

test("automation runs must surface EMPTY to the repair chain: partial narration is never a usable reply (T-317)", async () => {
  const { __test__ } = await import("../src/runtime/agent.js");
  // 2026-10-13/15 生产形态：glm flash 工具期中文叙述（汉字占比≥30%）曾被
  // partial 降级当成 success 返回，吞掉 MASTRA_EMPTY_RESPONSE，T-317 因此绕过
  // 空响应修复链、走上只看得见叙述散文的旧验证修复轮，补交 16≠17 列失败。
  const narration = "任务：行业复盘，追加到工作簿。需要当日涨幅前10行业数据。食品饮料 0.72，非银金融 0.40。";
  assert.equal(__test__.isPartialTextUsableReply("automation", narration), false);
  assert.equal(__test__.isPartialTextUsableReply("automation", ""), false);
  // 会话通道语义保持：中文叙述仍可作为阶段性回复，英文工作叙述仍判不可用。
  assert.equal(__test__.isPartialTextUsableReply("web", narration), true);
  assert.equal(__test__.isPartialTextUsableReply("weixin-mobile", narration), true);
  assert.equal(__test__.isPartialTextUsableReply("web", "Need top 10 industry gainers. Use mdt catalog."), false);
});

test("the empty-response repair prompt keeps tools forbidden and feeds the work log", async () => {
  const source = await import("node:fs/promises");
  const runnerSource = await source.readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.match(runnerSource, /本轮禁止调用任何工具/);
  assert.match(runnerSource, /【上一轮工具调用工作记录（服务端观测，含结果摘录）】/);
  assert.match(runnerSource, /落稿补偿投递/);
  assert.match(runnerSource, /【补交列数要求】/);
});
