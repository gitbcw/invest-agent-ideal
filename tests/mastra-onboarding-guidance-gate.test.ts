import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-init-notice-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(root, ".sandbox-secret");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("service reports unfinished initialization as prompt context, not a gate (R1 feedback round 2)", async () => {
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const agentMod = await import("../src/runtime/agent.js");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const userId = "notice-user";
  const instanceId = "invest-agent-notice-user";
  await registerTestProject({ userId, projectId: "invest-agent", instanceId });

  // Uninitialized: predicate true, notice present, and the notice instructs
  // the AGENT (answer normally + remind in passing), never blocks the turn.
  assert.equal(await agentMod.__test__.isInitializationUnfinished({ userId, projectId: "invest-agent", instanceId }), true);
  const notice = agentMod.__test__.buildInitializationNotice();
  assert.match(notice, /服务提示·初始化状态/);
  assert.match(notice, /正常回答用户的问题/);
  assert.match(notice, /不再重复提醒/);
  assert.match(notice, /onboarding draft 工具/);

  // Initialized (holdings exist): predicate flips off, no notice is appended.
  const { replaceMastraPortfolioProjection } = await import("../src/lib/mastra-portfolio-backend.js");
  replaceMastraPortfolioProjection(userId, instanceId, { holdings: [{ name: "贵州茅台", code: "600519" }], watchlist: [] } as never, null);
  assert.equal(await agentMod.__test__.isInitializationUnfinished({ userId, projectId: "invest-agent", instanceId }), false);
});
