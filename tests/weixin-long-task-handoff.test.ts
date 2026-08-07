import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-weixin-long-task-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "long-task.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.WEIXIN_INBOUND_BATCH_WINDOW_MS = "1";
process.env.WEIXIN_EXECUTION_BUDGET_MS = "200";
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("WeChat waits for a long task and returns the final result", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { InvestAgentMobileBridge } = await import("../src/channels/weixin-message-bridge.js");
  const bridge = new InvestAgentMobileBridge(
    "long-task-test",
    path.join(root, "weixin-state"),
    undefined,
    {
      agentId: "test-agent",
      agentName: "test",
      capabilities: ["chat"],
      handleMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { content: { type: "text" as const, text: "后台分析已完成。" }, finished: true };
      },
    },
  );

  const result = await bridge.chat({ conversationId: "weixin-long-task-conversation", text: "请做一份复杂分析" });
  assert.equal(result.text, "后台分析已完成。");
  const jobs = db.sqlite.prepare("SELECT COUNT(*) AS count FROM push_jobs WHERE source = 'conversation_background'").get() as { count: number };
  assert.equal(jobs.count, 0);
  const messages = db.sqlite.prepare(`
    SELECT content FROM conversation_messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY created_at ASC, rowid ASC
  `).all("weixin-long-task-conversation") as Array<{ content: string }>;
  assert.equal(messages.some((message) => message.content === "后台分析已完成。"), true);
});
