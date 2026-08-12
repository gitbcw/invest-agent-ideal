import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";

test("agent trace stores compact metadata and copies legacy ACP audit rows once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-acp-trace-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  delete process.env.AGENT_TRACE_STORE_PROMPT_TEXT;
  delete process.env.AGENT_TRACE_STORE_RAW_REPLY;

  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { agentTraces } = await import("../src/db/schema.js");
    sqlite.exec(`
      CREATE TABLE agent_traces (
        id INTEGER PRIMARY KEY, owner_user_id TEXT NOT NULL, user_id TEXT NOT NULL,
        user_message TEXT NOT NULL, mode TEXT NOT NULL, final_reply TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO agent_traces (id, owner_user_id, user_id, user_message, mode, final_reply, created_at)
      VALUES (3, 'primary', 'legacy-agent-user', 'old agent trace', 'chat', 'old reply', '2026-08-10T00:00:00.000Z');
      CREATE INDEX idx_agent_traces_user ON agent_traces(user_id, created_at);
      CREATE TABLE codex_acp_traces (
        id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, message_id TEXT, channel TEXT NOT NULL, user_text TEXT NOT NULL,
        prompt_text TEXT, reply_text_raw TEXT, reply_text_sanitized TEXT, mode TEXT NOT NULL,
        review_context_summary TEXT, sandbox_token_id TEXT, sandbox_permissions TEXT, acp_backend TEXT,
        acp_model TEXT, mcp_manifest TEXT, tool_calls TEXT, prompt_chars INTEGER, reply_chars INTEGER,
        status TEXT NOT NULL, error_message TEXT, elapsed_ms INTEGER, input_tokens INTEGER,
        output_tokens INTEGER, thought_tokens INTEGER, cached_read_tokens INTEGER, cached_write_tokens INTEGER,
        total_tokens INTEGER, context_window_used INTEGER, context_window_size INTEGER, cost_amount REAL,
        cost_currency TEXT, usage_source TEXT, usage_raw TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO codex_acp_traces (
        id, user_id, project_id, instance_id, conversation_id, channel, user_text, mode, status, acp_backend, created_at
      ) VALUES (7, 'legacy-user', 'invest-agent', 'invest-agent-legacy-user', 'legacy-conversation', 'web', 'legacy row', 'chat', 'success', 'acp', '2026-08-11T00:00:00.000Z');
    `);

    initDb();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM agent_traces_legacy_runtime_v1").get().n, 1);
    const [legacyRow] = await db.select().from(agentTraces).where(eq(agentTraces.id, 7));
    assert.equal(legacyRow.conversationId, "legacy-conversation");
    assert.equal(legacyRow.agentBackend, "acp");

    const { recordAgentTrace } = await import("../src/runtime/trace.js");
    await recordAgentTrace({
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
      agentBackend: "mastra",
      agentModel: "gpt-test",
      reviewContextSummary: {
        budget: {
          state: "completed",
          startedAt: 1_000,
          exhaustedAt: 1_200,
          exhaustionType: "identical_calls",
          convergenceDeadlineAt: 6_200,
          toolCallsAfterExhaustion: 0,
        },
      },
      toolManifest: {
        sessionId: "session-a",
        userId: "trace-user",
        instanceId: "invest-agent-trace-user",
        taskType: "interactive",
        servers: [{ id: "market-data-tool", transportKind: "stdio", configFingerprint: "abc123" }],
      },
      toolCalls: [{
        source: "mastra-event",
        toolCallId: "call-1",
        title: "quant_screen_stocks",
        status: "completed",
        inputChars: 18,
        outputChars: 42,
      }],
    });

    const [row] = await db.select().from(agentTraces).where(eq(agentTraces.userId, "trace-user"));
    assert.equal(row.promptText, null);
    assert.equal(row.replyTextRaw, null);
    assert.equal(row.replyTextSanitized, "clean reply");
    assert.equal(row.agentBackend, "mastra");
    assert.equal(row.agentModel, "gpt-test");
    assert.equal(row.promptChars, "internal prompt that should not be persisted on success".length);
    assert.equal(row.replyChars, "raw reply".length);
    assert.match(row.toolManifest ?? "", /market-data-tool/);
    assert.match(row.reviewContextSummary ?? "", /"toolCallsAfterExhaustion":0/);
    assert.match(row.toolCalls ?? "", /quant_screen_stocks/);
    assert.doesNotMatch(row.toolCalls ?? "", /secret/);
    assert.equal(sqlite.prepare("SELECT json_valid(tool_calls) AS valid FROM agent_traces WHERE user_id = ?").get("trace-user").valid, 1);

    await recordAgentTrace({
      conversationId: "large-json-conversation",
      channel: "api",
      userText: "trace test",
      mode: "chat",
      status: "success",
      toolCalls: [{ title: "large tool output", output: "x".repeat(20_000) }],
    });
    const [largeRow] = await db.select().from(agentTraces).where(eq(agentTraces.conversationId, "large-json-conversation"));
    assert.equal(sqlite.prepare("SELECT json_valid(tool_calls) AS valid FROM agent_traces WHERE conversation_id = ?").get("large-json-conversation").valid, 1);
    assert.match(largeRow.toolCalls ?? "", /"truncated":true/);
    sqlite.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
