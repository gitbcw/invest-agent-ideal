import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RuntimeAgent } from "../src/runtime/agent.js";

/** T-506 P1 / BC-20260913-001：Portal 轮「工具调用已发生但最终文本为空」
 * （MASTRA_EMPTY_RESPONSE）时，用确定性降级回复替换泛化「暂时性故障」：
 * 不承诺成功、不绕过确认校验；有等待确认的草案时指路「回复确认继续」，
 * 无草案时引导重发。回归样例来自 9-13 mg 事故（4 轮空回复、2 份草案悬空、
 * 用户无任何指引）与 9-14 glm 复现（空响应前有完整工具调用序列）。 */

function stubAgentReturning(failedData: Record<string, unknown>): RuntimeAgent {
  return {
    handleMessage: async () => ({
      content: { type: "text", text: "" },
      finished: true,
      data: { executionStatus: "failed", executionRetryable: false, ...failedData },
    }),
  } as unknown as RuntimeAgent;
}

async function setupConversation(tempRoot: string, name: string) {
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
  const { db, initDb } = await import("../src/db/index.js");
  const { conversationSessions } = await import("../src/db/schema.js");
  const { createConversationSession, chatViaConversationLog } = await import("../src/services/conversation-log.js");
  const { ensureWorkspace } = await import("../src/lib/workspace.js");
  const userId = `empty-degrade-${name}`;
  const instanceId = `invest-agent-empty-degrade-${name}`;
  const conversationId = `web_empty_degrade_${name}`;
  const scope = { userId, projectId: "invest-agent", instanceId };
  initDb();
  await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
  createConversationSession({ scope, conversationId, channel: "web", title: "empty degradation" });
  return { db, conversationSessions, chatViaConversationLog, scope, conversationId, userId, instanceId };
}

test("portal empty response with tool calls degrades to actionable reply (no pending draft → retry guidance)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-empty-degrade-a-"));
  try {
    const { chatViaConversationLog, scope, conversationId } = await setupConversation(tempRoot, "a");
    const result = await chatViaConversationLog({
      ...scope, conversationId, text: "帮我提交方法修改",
      agent: stubAgentReturning({ executionErrorCode: "MASTRA_EMPTY_RESPONSE", executionToolCallCount: 3 }),
    });
    const reply = String(result.assistantMessage.content ?? "");
    assert.match(reply, /本轮没有生成最终回复，你的请求未完成/);
    assert.match(reply, /均有系统审计记录/);
    assert.match(reply, /直接重发这条请求/);
    assert.doesNotMatch(reply, /「确认」/);
    const { db } = await import("../src/db/index.js");
    const { conversationMessages } = await import("../src/db/schema.js");
    const rows = await db.select().from(conversationMessages);
    const failed = rows.find((row) => row.conversationId === conversationId && row.role === "assistant");
    assert.ok(failed?.content.includes("本轮没有生成最终回复"), "degraded reply must be persisted");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("portal empty response with a pending confirmation draft points the user to reply 确认 (mg 9-13 scenario)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-empty-degrade-b-"));
  try {
    const { chatViaConversationLog, scope, conversationId, userId, instanceId } = await setupConversation(tempRoot, "b");
    const { db } = await import("../src/db/index.js");
    const { pendingSandboxConfirmations } = await import("../src/db/schema.js");
    await db.insert(pendingSandboxConfirmations).values({
      id: "degrade-draft-1", userId, projectId: "invest-agent", instanceId,
      role: "user", channel: "web", backend: "mastra", conversationId,
      requestedTokenId: "tok-1", operation: "method_changes.propose",
      resourceType: "method_change_candidate", requestBody: JSON.stringify({ proposedChange: "x", reason: "y" }),
      status: "pending", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const result = await chatViaConversationLog({
      ...scope, conversationId, text: "确认",
      agent: stubAgentReturning({ executionErrorCode: "MASTRA_EMPTY_RESPONSE", executionToolCallCount: 1 }),
    });
    const reply = String(result.assistantMessage.content ?? "");
    assert.match(reply, /等待你确认的操作草案/);
    assert.match(reply, /回复「确认」/);
    assert.doesNotMatch(reply, /重发这条请求/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("empty response without tool calls keeps the generic terminal message", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-empty-degrade-c-"));
  try {
    const { chatViaConversationLog, scope, conversationId } = await setupConversation(tempRoot, "c");
    const result = await chatViaConversationLog({
      ...scope, conversationId, text: "随便聊聊",
      agent: stubAgentReturning({ executionErrorCode: "MASTRA_EMPTY_RESPONSE" }),
    });
    const reply = String(result.assistantMessage.content ?? "");
    assert.doesNotMatch(reply, /本轮没有生成最终回复/);
    assert.ok(reply.length > 0, "generic terminal message must still be non-empty");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("non-empty-response failures keep the generic terminal message", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-empty-degrade-d-"));
  try {
    const { chatViaConversationLog, scope, conversationId } = await setupConversation(tempRoot, "d");
    const result = await chatViaConversationLog({
      ...scope, conversationId, text: "帮我查一下",
      agent: stubAgentReturning({ executionErrorCode: "TASK_DEPENDENCY_UNAVAILABLE", executionToolCallCount: 5 }),
    });
    const reply = String(result.assistantMessage.content ?? "");
    assert.doesNotMatch(reply, /本轮没有生成最终回复/);
    assert.ok(reply.length > 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
