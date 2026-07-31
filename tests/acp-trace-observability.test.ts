import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

test("ACP trace stores compact runtime metadata without successful prompt/raw reply by default", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-acp-trace-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  delete process.env.ACP_TRACE_STORE_PROMPT_TEXT;
  delete process.env.ACP_TRACE_STORE_RAW_REPLY;

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { codexAcpTraces } = await import("../src/db/schema.js");
    const { recordAcpTrace } = await import("../src/acp/trace.js");

    initDb();
    await recordAcpTrace({
      userId: "trace-user",
      projectId: "invest-agent",
      instanceId: "invest-agent-trace-user",
      conversationId: "trace-conversation",
      messageId: "trace-message",
      channel: "weixin-mobile",
      userText: "今天行情怎么样？",
      promptText: "internal prompt that should not be persisted on success",
      replyTextRaw: "raw reply",
      replyTextSanitized: "clean reply",
      mode: "chat",
      status: "success",
      elapsedMs: 1234,
      acpBackend: "codex",
      acpModel: "gpt-test",
      mcpManifest: {
        sessionId: "session-a",
        userId: "trace-user",
        instanceId: "invest-agent-trace-user",
        taskType: "interactive",
        servers: [{ id: "market-data-tool", transportKind: "stdio", configFingerprint: "abc123" }],
      },
      toolCalls: [{
        source: "acp-event",
        toolCallId: "call-1",
        title: "quant_screen_stocks",
        status: "completed",
        inputChars: 18,
        outputChars: 42,
      }],
    });

    const [row] = await db.select().from(codexAcpTraces).where(eq(codexAcpTraces.userId, "trace-user"));
    assert.equal(row.promptText, null);
    assert.equal(row.replyTextRaw, null);
    assert.equal(row.replyTextSanitized, "clean reply");
    assert.equal(row.acpBackend, "codex");
    assert.equal(row.acpModel, "gpt-test");
    assert.equal(row.promptChars, "internal prompt that should not be persisted on success".length);
    assert.equal(row.replyChars, "raw reply".length);
    assert.match(row.mcpManifest ?? "", /market-data-tool/);
    assert.match(row.toolCalls ?? "", /quant_screen_stocks/);
    assert.doesNotMatch(row.toolCalls ?? "", /secret/);
    assert.equal(sqlite.prepare("SELECT json_valid(tool_calls) AS valid FROM codex_acp_traces WHERE user_id = ?").get("trace-user").valid, 1);

    await recordAcpTrace({
      conversationId: "large-json-conversation",
      channel: "api",
      userText: "trace test",
      mode: "chat",
      status: "success",
      toolCalls: [{ title: "large tool output", output: "x".repeat(20_000) }],
    });
    const [largeRow] = await db.select().from(codexAcpTraces).where(eq(codexAcpTraces.conversationId, "large-json-conversation"));
    assert.equal(sqlite.prepare("SELECT json_valid(tool_calls) AS valid FROM codex_acp_traces WHERE conversation_id = ?").get("large-json-conversation").valid, 1);
    assert.match(largeRow.toolCalls ?? "", /"truncated":true/);
    sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
