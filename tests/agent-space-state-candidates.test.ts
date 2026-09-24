/**
 * T-540 纠错候选端到端测试：结构性边界 + 生命周期 + 问题会话。
 *
 * 结构性断言（设计 §11「服务与安全验收」）：
 * - 工具面只暴露 propose/revise；approve 永不在模型工具表；
 * - 无 conversation/task 上下文的候选调用被拒（无自主反思路径）；
 * - scheduled grant 白名单不含候选工具（自动化轮默认无候选权）；
 * - draft 候选不进入 buildScopedStatePacket 默认注入。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-state-candidates-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "state-candidates.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scope = { userId: "sc-user", projectId: "invest-agent", instanceId: "sc-instance" };

let mods: Awaited<ReturnType<typeof load>> | null = null;
async function load() {
  if (!mods) {
    const db = await import("../src/db/index.js");
    db.initDb();
    const { registerTestProject } = await import("./helpers/mastra-project.js");
    await registerTestProject(scope);
    mods = {
      db,
      state: await import("../src/services/agent-space/state.js"),
      statePortal: await import("../src/services/agent-space/state-portal.js"),
      attention: await import("../src/services/attention-items.js"),
      tools: await import("../src/mastra/tools/registry.js"),
      classification: await import("../src/mcp/service-tool-classification.js"),
      core: await import("../src/mcp/service-tools-core.js"),
      conversations: await import("../src/services/conversation-log.js"),
    };
  }
  return mods;
}

test("structural: tool surface exposes propose/revise only — approve is never a model tool", async () => {
  const { tools } = await load();
  const ids = tools.TOOL_SPECS.map((spec: { id: string }) => spec.id);
  assert.ok(ids.includes("state.candidate.propose"));
  assert.ok(ids.includes("state.candidate.revise"));
  assert.equal(ids.filter((id: string) => id.startsWith("state.candidate") && id.includes("approve")).length, 0, "approve 不在模型工具面");
});

test("structural: proposing without conversation/task context is refused", async () => {
  const { core } = await load();
  const result = (await core.callServiceTool(
    "state.candidate.propose",
    { kind: "lesson", title: "无上下文候选", trigger: "t", guidance: "g" },
    { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId },
  )) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.equal(result.error, "STATE_CANDIDATE_NO_OWNER_CONTEXT");
});

test("structural: scheduled grants never include candidate tools", async () => {
  const { classification } = await load();
  for (const taskType of ["scheduled-daily-review", "scheduled-market-watch", "scheduled-weekly-review"]) {
    const grant = classification.resolveScheduledServiceGrant(taskType);
    assert.equal(grant.includes("state.candidate.propose"), false, `${taskType} grant 不应含候选工具`);
    assert.equal(grant.includes("state.candidate.revise"), false);
  }
});

test("lifecycle: propose in conversation → draft (not injected) → portal approve → effective", async () => {
  const m = await load();
  const conversationId = "sc-conv-1";
  m.conversations.createConversationSession({ scope, conversationId, channel: "web", title: "候选测试会话" });

  const proposed = (await m.core.callServiceTool(
    "state.candidate.propose",
    { kind: "lesson", title: "盯盘空推送处置", trigger: "盯盘任务推送结果为空时", guidance: "先核对数据源，再决定是否跳过推送" },
    { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId, conversationId },
  )) as { ok: boolean; candidate?: { objectId: string; versionId: string } };
  assert.equal(proposed.ok, true);
  const objectId = proposed.candidate!.objectId;

  // draft 不进入默认注入（exclusions 记录排除原因属设计内审计，不算注入）
  const packet = m.state.buildScopedStatePacket({ scope, ownerKind: "conversation", ownerId: conversationId, budgetChars: 4000 });
  assert.equal(
    (packet as unknown as { entries: Array<{ objectId: string }> }).entries.some((entry) => entry.objectId === objectId),
    false,
    "draft 候选不得进入 state packet 默认注入",
  );
  const exclusion = (packet as unknown as { exclusions: Array<{ objectId: string; reason: string }> }).exclusions.find((e) => e.objectId === objectId);
  assert.ok(exclusion, "draft 排除应有审计记录");

  // Portal 读模型可见（低优先级待确认改进）
  const pending = m.statePortal.listPendingStateCandidates(scope);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.objectId, objectId);
  assert.equal(pending[0]!.surface, "conversation");

  // 批准（portal 凭证消耗）→ active → 有效注入可见
  m.statePortal.portalApproveStateCandidate({
    scope,
    kind: "lesson",
    objectId,
    versionId: proposed.candidate!.versionId,
    portalRequestId: "sc-approve-1",
    actor: `portal:${scope.userId}`,
  });
  assert.equal(m.statePortal.listPendingStateCandidates(scope).length, 0, "批准后离开待确认列表");
  const approvedPacket = m.state.buildScopedStatePacket({ scope, ownerKind: "conversation", ownerId: conversationId, budgetChars: 4000 });
  assert.ok(
    (approvedPacket as unknown as { entries: Array<{ objectId: string }> }).entries.some((entry) => entry.objectId === objectId),
    "批准后候选进入有效状态面",
  );
});

test("lifecycle: reject is terminal; same-owner same-title new draft is flagged do-not-disturb-again", async () => {
  const m = await load();
  const conversationId = "sc-conv-2";
  m.conversations.createConversationSession({ scope, conversationId, channel: "web", title: "拒绝测试会话" });

  const proposed = (await m.core.callServiceTool(
    "state.candidate.propose",
    { kind: "workflow", title: "被拒的工作流候选", scenario: "场景 A", steps: [{ action: "检查数据源" }] },
    { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId, conversationId },
  )) as { ok: boolean; candidate?: { objectId: string } };
  assert.equal(proposed.ok, true);

  m.statePortal.portalRejectStateCandidate({ scope, kind: "workflow", objectId: proposed.candidate!.objectId, reason: "不适用", actor: `portal:${scope.userId}` });
  assert.equal(m.statePortal.listPendingStateCandidates(scope).filter((c) => c.objectId === proposed.candidate!.objectId).length, 0, "拒绝后离开待确认");

  // 同 owner 同标题新草案 → 读模型标记 previouslyRejected（不重复打扰依据）
  const again = m.state.createStateCandidate({
    scope,
    kind: "workflow",
    title: "被拒的工作流候选",
    content: { scenario: "场景 A 改", steps: [{ action: "检查数据源" }] },
    ownerKind: "conversation",
    ownerId: conversationId,
    origin: "agent",
    actor: "agent:test",
  });
  const flagged = m.statePortal.listPendingStateCandidates(scope).find((c) => c.objectId === again.objectId);
  assert.ok(flagged?.previouslyRejected, "同标题新草案应标记 previouslyRejected");
});

test("issue conversation: bound to attention item, sanitized system injection, reused on reopen", async () => {
  const m = await load();
  // 构造失败事项（直接经服务层 record —— 与终态钩子同一入口）
  const task = await (await import("../src/services/automation-tasks.js")).createAutomationTask({
    ...scope,
    taskId: "sc-attention-task",
    name: "候选测试任务",
    instruction: "x",
    schedule: { frequency: "daily", time: "09:00", timezone: "Asia/Shanghai" },
    output: { mode: "none" },
    delivery: { mode: "none" },
  });
  const item = m.attention.recordAutomationFailureAttention({ scope, taskId: task.taskId, runId: "sc-run-1", errorCategory: "timeout" });

  const opened = m.attention.openAttentionConversation(scope, item.itemId);
  assert.equal(opened.reused, false);
  assert.ok(opened.conversationId.startsWith("attention-"));

  const session = m.db.sqlite
    .prepare("SELECT metadata FROM conversation_sessions WHERE conversation_id=?")
    .get(opened.conversationId) as { metadata: string };
  const metadata = JSON.parse(session.metadata) as { attentionItemId?: string };
  assert.equal(metadata.attentionItemId, item.itemId, "会话 metadata 绑定失败事项");

  const systemMessage = m.db.sqlite
    .prepare("SELECT content FROM conversation_messages WHERE conversation_id=? AND role='system'")
    .get(opened.conversationId) as { content: string };
  assert.ok(systemMessage.content.includes("直接影响"), "system 注入用户语言失败摘要");
  assert.ok(systemMessage.content.includes("不要展示错误码"), "注入包含脱敏边界指令");

  const reopened = m.attention.openAttentionConversation(scope, item.itemId);
  assert.equal(reopened.reused, true, "重开复用同一会话");
  assert.equal(reopened.conversationId, opened.conversationId);
});
