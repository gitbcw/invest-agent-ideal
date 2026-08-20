import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";
// 本文件拉起完整 runtime agent，必须先于任何动态 import 封闭外部服务，
// 否则裸跑单文件时 .env 的真实网关/本地 MCP 会泄入：真实网关触发模型轮
// 30 分钟降级冷却，本地 MDT (127.0.0.1:8000) 的 keep-alive MCP socket
// 让测试进程永不退出（2026-08-20 套件挂起根因）。拒连端口号使轮内快速失败。
process.env.NODE_ENV = "test";
process.env.MASTRA_GATEWAY_BASE_URL ||= "http://127.0.0.1:9";
process.env.MARKET_DATA_MCP_URL ||= "http://127.0.0.1:9/mcp";

test("weixin light guidance gates uninitialized users and passes configured ones", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-weixin-gate-"));
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    initDb();
    const { createRuntimeAgent } = await import("../src/runtime/agent.js");
    const agent = createRuntimeAgent();
    const message = (userId: string) => ({
      id: `gate-${userId}`,
      from: userId,
      content: { text: "帮我看看持仓" },
      context: { conversationId: `conv-${userId}`, channel: "weixin-mobile", userId },
    });

    // Uninitialized user: light guidance instead of a model turn.
    const gated = await agent.handleMessage(message("gate-user-new") as never);
    assert.match(gated.content?.text ?? "", /Portal/);
    assert.equal(gated.content?.text?.includes("初始化"), true);

    // Configured user (completed onboarding state): the gate must not trigger,
    // so the request proceeds to the normal turn path (model unavailable in
    // this test env → terminal error response, never the guidance text).
    const { MastraUserPreferenceStore } = await import("../src/services/user-preferences.js");
    const store = new MastraUserPreferenceStore("gate-user-done", "invest-agent-gate-user-done", "invest-agent");
    await store.writeOnboardingState({
      version: 1, status: "completed", current_step: "completed",
      steps: {}, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), notes: "",
    } as never);
    const passed = await agent.handleMessage(message("gate-user-done") as never);
    assert.equal((passed.content?.text ?? "").includes("Portal 完成初始化"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
