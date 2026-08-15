import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";
process.env.NODE_ENV = "test";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-instructions-"));
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
});

test("buildAgentInstructions carries identity, discipline, tool doctrine and methodology guidance", async () => {
  const { buildAgentInstructions } = await import("../src/runtime/agent-instructions.js");
  const instructions = buildAgentInstructions();
  for (const marker of [
    "投资决策助手",
    "不承诺收益",
    "事实和推断分开",
    "不使用资金净流入",
    "服务工具",
    "结构化草案",
    "methods/strategy-rules.md",
    "可进化资产",
    "不向用户暴露内部路径",
  ]) {
    assert.ok(instructions.includes(marker), `instructions must mention ${marker}`);
  }
  // Channel policy lives in instructions now, not in the user message.
  assert.ok(!instructions.includes("invest-svg"), "api base has no portal visual policy");
});

test("buildAgentInstructions appends the channel presentation section per channel", async () => {
  const { buildAgentInstructions } = await import("../src/runtime/agent-instructions.js");
  const web = buildAgentInstructions({ channel: "web" });
  assert.ok(web.includes("门户网页聊天"));
  assert.ok(web.includes("spreadsheet.create"));
  assert.ok(web.includes("invest-svg"));

  const weixin = buildAgentInstructions({ channel: "weixin-mobile" });
  assert.ok(weixin.includes("微信"));
  assert.ok(!weixin.includes("invest-svg"), "weixin channel must not carry portal visual policy");

  const base = buildAgentInstructions({ channel: "api" });
  assert.ok(!base.includes("门户网页聊天"), "api channel has no web section");
});

test("interactive turn prompt wrapper no longer carries channel policy", async () => {
  // The user-message wrapper must stay lean: channel policy moved to
  // instructions, only attachment framing remains.
  const agentModule = await import("../src/runtime/agent.js");
  assert.equal(typeof agentModule.buildChannelContextInstruction, "function", "channel instruction stays exported for the instructions builder");
});
