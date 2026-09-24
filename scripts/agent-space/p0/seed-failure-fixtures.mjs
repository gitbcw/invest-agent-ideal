#!/usr/bin/env node
/**
 * T-539: 在 111 隔离库构造失败告知反例（经服务层真实链路，不手写表行）。
 *
 * 产物形态：
 *   - 任务 A：1 次 scheduled 失败 → open attention 事项（微信已提醒标记）；
 *   - 任务 B：2 次连败 → 同一 open 事项 failure_count=2（去重）；
 *   - 任务 C：失败后成功 → resolved 事项（恢复历史）。
 * 真实链路：runGenericAutomationTaskNow（executor 抛错/成功）→ 终态钩子
 * notifyAutomationRunTerminalQuietly → attention 写入/恢复（与生产同一路径）。
 *
 * 护栏：DB_PATH 必须指向 .state/agent-space-p0。
 */
import path from "node:path";

const dbPath = process.env.DB_PATH || "";
if (!dbPath.includes("agent-space-p0")) {
  console.error(`拒绝执行：DB_PATH=${dbPath} 不是 111 隔离库`);
  process.exit(1);
}

const { initDb } = await import("../../../src/db/index.js");
initDb();
const attention = await import("../../../src/services/attention-items.js");

const SCOPE = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };

// dynamic import（服务模块依赖 db 已初始化）
const automation = await import("../../../src/services/automation-tasks.js");
const runner = await import("../../../src/services/generic-automation-runner.js");

// 幂等：清掉上一次运行留下的 p0-fixture 夹具（构造夹具的自清理，不动真实数据）
{
  const Database = (await import("better-sqlite3")).default;
  const cleanup = new Database(path.resolve(dbPath));
  cleanup.exec(`
    DELETE FROM attention_items WHERE task_id LIKE 'p0-fixture-%';
    DELETE FROM automation_task_runs WHERE task_id LIKE 'p0-fixture-%';
    DELETE FROM automation_task_audit_logs WHERE task_id LIKE 'p0-fixture-%';
    DELETE FROM automation_task_revisions WHERE task_id LIKE 'p0-fixture-%';
    DELETE FROM automation_tasks WHERE task_id LIKE 'p0-fixture-%';
  `);
  cleanup.close();
}

async function createTask(taskId, name) {
  const task = await automation.createAutomationTask({
    ...SCOPE,
    taskId,
    name,
    instruction: "T-539 失败反例任务。",
    schedule: { frequency: "trading_days", time: "19:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  await automation.activateAutomationTask({ ...SCOPE, taskId: task.taskId, expectedRevision: 1 });
  return task;
}

async function failRun(taskId, key) {
  return runner.runGenericAutomationTaskNow({
    scope: SCOPE, taskId, origin: "scheduled", idempotencyKey: key,
    executor: async () => { throw new Error("p0-seed simulated failure"); },
  });
}
async function succeedRun(taskId, key) {
  return runner.runGenericAutomationTaskNow({
    scope: SCOPE, taskId, origin: "scheduled", idempotencyKey: key,
    executor: async () => ({
      content: { type: "text", text: "ok" },
      finished: true,
      data: { summary: "p0-seed 模拟成功，数据已更新。", shouldNotify: false },
    }),
  });
}

// 任务 A：单次失败 → open 事项
const taskA = await createTask("p0-fixture-single-failure", "p0 失败反例：单次失败");
await failRun(taskA.taskId, "p0-ff-a1");
// 任务 B：连败 2 次 → 去重事项
const taskB = await createTask("p0-fixture-consecutive", "p0 失败反例：连续失败");
await failRun(taskB.taskId, "p0-ff-b1");
await failRun(taskB.taskId, "p0-ff-b2");
// 任务 C：失败 → 成功 → resolved
const taskC = await createTask("p0-fixture-recovered", "p0 失败反例：已恢复");
await failRun(taskC.taskId, "p0-ff-c1");
await succeedRun(taskC.taskId, "p0-ff-c2");

// 冻结三个反例任务未来调度（真实 UPDATE，隔离库内）
const Database = (await import("better-sqlite3")).default;
const db = new Database(path.resolve(dbPath));
db.prepare("UPDATE automation_tasks SET next_run_at = NULL WHERE task_id LIKE 'p0-fixture-%'").run();

const open = attention.listAttentionItems(SCOPE, { status: "open" });
const resolved = attention.listAttentionItems(SCOPE, { status: "resolved" });
console.log("\n构造结果：");
console.log(`  open 事项 ${open.length} 个：${open.map((i) => `${i.taskId}(count=${i.failureCount}, wechat=${i.wechatNotified})`).join("; ")}`);
console.log(`  resolved 事项 ${resolved.length} 个：${resolved.map((i) => `${i.taskId}`).join("; ")}`);
console.log(`  openCount=${attention.countOpenAttention(SCOPE)}`);
db.close();
console.log("完成。待处理页验证：start-isolated.mjs → http://127.0.0.1:3110/attention");
