#!/usr/bin/env node
/**
 * v3 演示视频播种：在本地镜像 demo 账号构造一条真实的「失败任务 → 待处理事项」链路。
 *
 * 产物形态：任务「组合净值日更」1 次 scheduled 失败 → open attention 事项。
 * 真实链路：runGenericAutomationTaskNow（executor 抛错）→ finishAutomationTaskRun
 * 终态钩子 notifyAutomationRunTerminalQuietly → attention 写入（与生产同一路径，
 * 仅 executor 的报错是模拟的，错误文案贴近真实缺文件场景）。
 *
 * 用法：DB_PATH=.state/production-mirror/runtime.db node --import tsx scripts/agent-space/p0/seed-demo-failure-fixture.mjs
 */
import path from "node:path";

const dbPath = process.env.DB_PATH || "";
if (!dbPath.includes("production-mirror")) {
  console.error(`拒绝执行：DB_PATH=${dbPath} 不是本地镜像库`);
  process.exit(1);
}

const { initDb } = await import("../../../src/db/index.js");
initDb();
const attention = await import("../../../src/services/attention-items.js");
const automation = await import("../../../src/services/automation-tasks.js");
const runner = await import("../../../src/services/generic-automation-runner.js");

const SCOPE = { userId: "demo", projectId: "invest-agent", instanceId: "invest-agent-demo" };
const TASK_ID = "demo-seed-netvalue-daily";

// 幂等：清掉上一次播种的同 id 夹具
{
  const Database = (await import("better-sqlite3")).default;
  const cleanup = new Database(path.resolve(dbPath));
  cleanup.exec(`
    DELETE FROM attention_items WHERE task_id = '${TASK_ID}';
    DELETE FROM automation_task_runs WHERE task_id = '${TASK_ID}';
    DELETE FROM automation_task_audit_logs WHERE task_id = '${TASK_ID}';
    DELETE FROM automation_task_revisions WHERE task_id = '${TASK_ID}';
    DELETE FROM automation_tasks WHERE task_id = '${TASK_ID}';
  `);
  cleanup.close();
}

const task = await automation.createAutomationTask({
  ...SCOPE,
  taskId: TASK_ID,
  name: "组合净值日更",
  instruction:
    "读取我的文件里的「组合净值跟踪.xlsx」，在表尾追加一行：当日日期、组合总市值、当日收益率（按持仓最新收盘价计算总市值）。",
  schedule: { frequency: "trading_days", time: "10:00", timezone: "Asia/Shanghai" },
  output: { mode: "none" },
  delivery: { mode: "none" },
});
await automation.activateAutomationTask({ ...SCOPE, taskId: task.taskId, expectedRevision: 1 });

const result = await runner.runGenericAutomationTaskNow({
  scope: SCOPE,
  taskId: task.taskId,
  origin: "scheduled",
  idempotencyKey: `demo-seed-netvalue-fail-${Date.now()}`,
  executor: async () => {
    throw new Error("读取输入文件「组合净值跟踪.xlsx」失败：file not found，用户资产库中不存在该文件（可能已被删除或从未上传）。");
  },
});

const open = attention.listAttentionItems(SCOPE, { status: "open" });
console.log(`run 状态：${result.run.status}，error=${result.run.errorMessage ?? ""}`);
console.log(`open 事项 ${open.length} 个：${open.map((i) => `${i.taskId}(count=${i.failureCount}, category=${i.errorCategory})`).join("; ")}`);
console.log("完成。");
