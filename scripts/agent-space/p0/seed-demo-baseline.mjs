#!/usr/bin/env node
/**
 * v3 演示视频播种：demo 老账号的确定性部分（服务层真实写入，非手写表行）。
 *  - 持仓投影（replaceMastraPortfolioProjection，与对话确认同一后端）
 *  - 经验类改进候选 draft（createStateCandidate，与 state.candidate.propose 同一入口）
 *  - 激活 4 个预置定时任务
 * 失败任务夹具走 seed-demo-failure-fixture.mjs；复盘报告走真实 LLM run-now。
 *
 * 用法：DB_PATH=.state/production-mirror/runtime.db node --import tsx scripts/agent-space/p0/seed-demo-baseline.mjs
 */
const dbPath = process.env.DB_PATH || "";
if (!dbPath.includes("production-mirror")) {
  console.error(`拒绝执行：DB_PATH=${dbPath} 不是本地镜像库`);
  process.exit(1);
}

const { initDb } = await import("../../../src/db/index.js");
initDb();

const SCOPE = { userId: "demo", projectId: "invest-agent", instanceId: "invest-agent-demo" };

// 1) 持仓投影
const portfolio = await import("../../../src/lib/mastra-portfolio-backend.js");
const currentRevision = portfolio.getMastraPortfolioRevision(SCOPE.userId, SCOPE.instanceId);
const revision = portfolio.replaceMastraPortfolioProjection(SCOPE.userId, SCOPE.instanceId, {
  cash: { amount: 300000, currency: "CNY", note: "约 30% 现金仓" },
  holdings: [
    { name: "贵州茅台", code: "600519", buy_date: "2026-08-12", cost_price: 1478.0, sell_date: null, sell_price: null, status: "open", weight_hint: "30%" },
    { name: "宁德时代", code: "300750", buy_date: "2026-09-03", cost_price: 186.5, sell_date: null, sell_price: null, status: "open", weight_hint: "20%" },
    { name: "招商银行", code: "600036", buy_date: "2026-09-18", cost_price: 33.8, sell_date: null, sell_price: null, status: "open", weight_hint: "20%" },
  ],
  watchlist: [],
}, currentRevision);
console.log("portfolio projection written, revision:", revision);

// 2) 经验类改进候选（draft，待处理页可批准）；幂等：同名 draft 已存在则跳过
const Database = (await import("better-sqlite3")).default;
const existing = new Database(dbPath, { readonly: true })
  .prepare("SELECT lesson_id FROM agent_space_lessons WHERE user_id='demo' AND title LIKE '回测/模拟报告标准工作流%' AND status='draft'")
  .get();
if (existing) {
  console.log("lesson candidate exists:", existing.lesson_id);
} else {
const state = await import("../../../src/services/agent-space/state.js");
const created = state.createStateCandidate({
  scope: SCOPE,
  kind: "lesson",
  title: "回测/模拟报告标准工作流：对照式输出+信号状态显式提示",
  content: {
    trigger: "用户要求对持仓或候选标的做策略回测、信号模拟或历史表现复盘时。",
    guidance:
      "输出结构固定四层：①对照输出——同周期下同时给出「严格执行策略」与「买入持有基线」两条净值与收益，凸显规则的实际贡献或损耗；②信号状态显式提示——结尾列出当前处于买入/卖出触发状态的标的及对应规则，作为行动信息而非结论；③数据口径先声明——模拟前注明已核验维度（如前复权日线）与近似/覆盖不足维度（如估值分位、MA60 前段）；④行动状态收尾——按继续观察/准备行动/暂不处理收束，附触发与失效条件。",
  },
  ownerKind: "task",
  ownerId: "preset_demo_low-disturbance-review_scheduled-weekly-review",
  origin: "agent",
  actor: "agent:demo",
});
console.log("lesson candidate:", created.objectId);
}

// 3) 激活 4 个预置任务
const automation = await import("../../../src/services/automation-tasks.js");
for (const suffix of ["scheduled-daily-review", "scheduled-weekly-review", "scheduled-monthly-review", "scheduled-market-watch"]) {
  const taskId = `preset_demo_low-disturbance-review_${suffix}`;
  try {
    await automation.activateAutomationTask({ ...SCOPE, taskId, expectedRevision: 1 });
    console.log("activated:", taskId);
  } catch (error) {
    console.log("activate failed:", taskId, String(error).slice(0, 120));
  }
}
console.log("完成。");
