import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-onboarding-guidance-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(root, ".sandbox-secret");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("web conversation with an uninitialized user opens with onboarding guidance (R1 feedback)", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const agentMod = await import("../src/runtime/agent.js");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const userId = "guidance-user";
  const instanceId = "invest-agent-guidance-user";
  await registerTestProject({ userId, projectId: "invest-agent", instanceId });

  // No model call happens for a gated turn, so a plain message is safe.
  const response = await agentMod.createRuntimeAgent().handleMessage({
    id: "msg-opening-1",
    from: "conv-guidance-1",
    timestamp: Date.now(),
    content: { type: "text", text: "帮我看看现在买什么好" },
    context: { channel: "web", conversationId: "conv-guidance-1", userId, projectId: "invest-agent", instanceId },
  });
  assert.match(response.content.text ?? "", /没有持仓、观察仓/);
  assert.match(response.content.text ?? "", /初始化/);
  assert.match(response.content.text ?? "", /对话内导入|向导/);

  // Second turn of the same conversation is NOT gated. In production the
  // conversation-log service persists the user message before the agent
  // turn; mirror that here.
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?) ON CONFLICT(id) DO NOTHING").run(userId, "guidance", now, now);
  sqlite.prepare("INSERT INTO conversation_sessions (conversation_id, user_id, project_id, instance_id, assistant_id, channel, title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id) DO NOTHING")
    .run("conv-guidance-1", userId, "invest-agent", instanceId, instanceId, "web", "guidance", now, now);
  sqlite.prepare(
    "INSERT INTO conversation_messages (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run("msg-opening-1", "conv-guidance-1", userId, "invest-agent", instanceId, instanceId, "web", "user", "帮我看看现在买什么好", now);
  const second = await agentMod.__test__.isInitializationUnfinished({ userId, projectId: "invest-agent", instanceId });
  assert.equal(second, true, "still uninitialized, but conversation-opening gate already fired once");
  // Production persists the current user message before the turn: the second
  // turn sees two user rows (first turn + its own) and must not be an opening.
  sqlite.prepare(
    "INSERT INTO conversation_messages (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run("msg-opening-2", "conv-guidance-1", userId, "invest-agent", instanceId, instanceId, "web", "user", "第二轮", now);
  const opening = agentMod.__test__.isConversationOpening("conv-guidance-1");
  assert.equal(opening, false, "second user turn is not a conversation opening");

  // After initialization (portfolio holdings exist) the predicate flips off.
  const { replaceMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
  replaceMastraPortfolioProjection(userId, instanceId, { holdings: [{ name: "贵州茅台", code: "600519" }], watchlist: [] } as never, null);
  const afterInit = await agentMod.__test__.isInitializationUnfinished({ userId, projectId: "invest-agent", instanceId });
  assert.equal(afterInit, false);
  void sqlite;
});
