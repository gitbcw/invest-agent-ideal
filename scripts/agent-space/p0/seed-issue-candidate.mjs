#!/usr/bin/env node
/** T-541 前置：在问题会话内经真实工具路径预置一条 pending 候选（幂等：已有 pending 则跳过）。 */
const run = async () => {
  if (!process.env.DB_PATH?.includes("agent-space-p0")) throw new Error("拒绝执行：DB_PATH 必须指向 .state/agent-space-p0");
  const { initDb } = await import("../../../src/db/index.js");
  initDb();
  const scope = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };
  const statePortal = await import("../../../src/services/agent-space/state-portal.js");
  const attention = await import("../../../src/services/attention-items.js");
  const core = await import("../../../src/mcp/service-tools-core.js");
  if (statePortal.listPendingStateCandidates(scope).length > 0) {
    console.log("已有 pending 候选，跳过");
    return;
  }
  const items = attention.listAttentionItems(scope, { status: "open" });
  if (items.length === 0) throw new Error("无 open 事项；先运行 seed-failure-fixtures.mjs");
  const conv = attention.openAttentionConversation(scope, items[0].itemId);
  const proposed = await core.callServiceTool("state.candidate.propose", {
    kind: "lesson",
    title: "复盘任务失败的用户沟通处置（e2e 预置）",
    trigger: "复盘类自动化失败且短期内无法自动恢复时",
    guidance: "在待处理事项中给出影响说明，并主动提出可执行的处理选项（重试一次/暂停任务/补充数据源）",
  }, { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId, conversationId: conv.conversationId });
  console.log("预置候选 ok:", proposed.ok, JSON.stringify(proposed.candidate || {}));
};
run().catch((e) => { console.error(e.message); process.exit(1); });
