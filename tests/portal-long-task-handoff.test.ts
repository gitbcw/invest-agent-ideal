import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-long-task-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "long-task.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.PORTAL_DIRECT_ACP_TIMEOUT_MS = "100";
process.env.PORTAL_EXECUTION_BUDGET_MS = "200";
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("Portal waits for a long task and returns the final result", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const conversations = await import("../src/services/conversation-log.js");
  const scope = {
    userId: "portal-long-task-user",
    projectId: "invest-agent",
    instanceId: "portal-long-task-instance",
    assistantId: "portal-long-task-instance",
  };
  const conversationId = "portal-long-task-conversation";
  let attempts = 0;
  const result = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "请完成一项耗时分析",
    idempotencyKey: "portal-long-task-key",
    agent: {
      agentId: "test-agent",
      agentName: "test",
      capabilities: ["chat"],
      handleMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        attempts += 1;
        if (attempts === 1) {
          return {
            content: { type: "text" as const, text: "暂时无法访问上游服务，稍后自动重试。" },
            finished: true,
            data: { executionStatus: "failed", executionErrorCode: "TASK_TRANSIENT_FAILURE", executionErrorCategory: "transient", executionRetryable: true },
          };
        }
        return { content: { type: "text" as const, text: "分析已经完成。" }, finished: true };
      },
    },
  });
  assert.equal(result.assistantMessage.content, "分析已经完成。");
  const messages = conversations.getConversation({ ...scope, conversationId }).messages.filter((message) => message.role === "assistant");
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.messageId, result.assistantMessage.messageId);
  assert.equal(messages[0]?.content, "分析已经完成。");
  assert.equal(attempts, 2);
});
