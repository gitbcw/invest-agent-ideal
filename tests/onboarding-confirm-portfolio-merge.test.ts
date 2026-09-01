import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-onboarding-merge-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

type CallServiceTool = typeof import("../src/mcp/service-tools-core.js").callServiceTool;
type RegisterSandboxRoutes = typeof import("../src/routes/sandbox.js").registerSandboxRoutes;
type CreateSandboxToken = typeof import("../src/lib/sandbox-context.js").createSandboxToken;

let callServiceTool: CallServiceTool;
let registerSandboxRoutes: RegisterSandboxRoutes;
let createSandboxToken: CreateSandboxToken;
let Fastify: typeof import("fastify").default;
let insertUserMessage: (userId: string, instanceId: string, conversationId: string, content: string, offsetMs: number) => Promise<void>;

before(async () => {
  const core = await import("../src/mcp/service-tools-core.js");
  callServiceTool = core.callServiceTool;
  const dbModule = await import("../src/db/index.js");
  dbModule.initDb();
  const schema = await import("../src/db/schema.js");
  const db = dbModule.db;
  insertUserMessage = async (userId, instanceId, conversationId, content, offsetMs) => {
    const now = new Date().toISOString();
    await db.insert(schema.conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      title: "onboarding merge regression",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    await db.insert(schema.conversationMessages).values({
      messageId: `${userId}-${offsetMs}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "weixin-mobile",
      role: "user",
      content,
      createdAt: new Date(Date.now() + offsetMs).toISOString(),
    });
  };
  const sandboxModule = await import("../src/routes/sandbox.js");
  registerSandboxRoutes = sandboxModule.registerSandboxRoutes;
  const contextModule = await import("../src/lib/sandbox-context.js");
  createSandboxToken = contextModule.createSandboxToken;
  Fastify = (await import("fastify")).default;
});

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function confirmViaMcp(userId: string, holdings: Array<{ name: string; code: string }>) {
  const instanceId = `${userId}-instance`;
  const conversationId = `${userId}-conversation`;
  const context = { userId, instanceId, projectId: "invest-agent", conversationId };
  const request = await callServiceTool("confirmations.request", {
    operation: "onboarding.confirm_portfolio",
    payload: { holdings },
    summary: "请确认初始持仓",
  }, context) as { ok: boolean; confirmationId: string };
  assert.equal(request.ok, true);
  await insertUserMessage(userId, instanceId, conversationId, "确认", Date.now() % 100_000 + 1_000);
  const confirmed = await callServiceTool("onboarding.confirm_portfolio", {
    confirmedByUser: true,
    confirmationId: request.confirmationId,
    holdings,
  }, context) as { ok: boolean; holdings: Array<{ code: string | null; name: string }> };
  assert.equal(confirmed.ok, true);
  return confirmed.holdings;
}

test("MCP 通道：同名不同码的持仓确认追加新行，不覆盖已有持仓", async () => {
  const userId = "onboarding-merge-mcp";
  await confirmViaMcp(userId, [{ name: "贵州茅台", code: "600519" }]);
  // Same display name, different code: must append 600520 and keep 600519 intact.
  const holdings = await confirmViaMcp(userId, [{ name: "贵州茅台", code: "600520" }]);
  const codes = holdings.map((item) => item.code).filter(Boolean).sort();
  assert.deepEqual(codes, ["600519", "600520"]);
  const byCode = new Map(holdings.map((item) => [item.code, item]));
  assert.equal(byCode.get("600519")!.name, "贵州茅台");
  assert.equal(byCode.get("600520")!.name, "贵州茅台");
});

test("sandbox HTTP 通道：同名不同码的持仓确认追加新行，不覆盖已有持仓", async () => {
  const userId = "onboarding-merge-sandbox";
  const instanceId = `${userId}-instance`;
  const app = Fastify();
  registerSandboxRoutes(app);
  const token = createSandboxToken({
    userId,
    projectId: "invest-agent",
    instanceId,
    role: "user",
    channel: "api",
    permissions: ["read:self", "write:self"],
  });

  const post = async (holdings: Array<{ name: string; code: string }>) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/sandbox/onboarding/confirm-portfolio",
      headers: { authorization: `Bearer ${token}` },
      payload: { holdings },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { ok: boolean; holdings: Array<{ code: string | null; name: string }> };
  };

  await post([{ name: "贵州茅台", code: "600519" }]);
  const result = await post([{ name: "贵州茅台", code: "600520" }]);
  const codes = result.holdings.map((item) => item.code).filter(Boolean).sort();
  assert.deepEqual(codes, ["600519", "600520"]);
});
