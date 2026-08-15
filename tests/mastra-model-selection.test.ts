import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

const scope = {
  userId: "model-select-user",
  projectId: "invest-agent",
  instanceId: "model-select-instance",
  assistantId: "model-select-instance",
};

test("conversation.chat model selection flows to the agent turn (D25)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-model-select-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb } = await import("../src/db/index.js");
    const { chatViaConversationLog } = await import("../src/services/conversation-log.js");
    initDb();

    const seenModels: Array<string | undefined> = [];
    const fakeAgent = {
      agentId: "model-test-agent",
      agentName: "model test",
      capabilities: ["chat"],
      async handleMessage(message: { context?: Record<string, unknown> }) {
        seenModels.push(typeof message.context?.model === "string" ? message.context.model : undefined);
        return { content: { type: "text" as const, text: "ok" }, finished: true };
      },
    };

    // Selected model reaches the turn context...
    await chatViaConversationLog({
      ...scope,
      conversationId: "model-conv",
      text: "用 luna 帮我看看",
      model: "gpt-5.6-luna",
      agent: fakeAgent as any,
    });
    // ...and an absent model stays absent (service default applies).
    await chatViaConversationLog({
      ...scope,
      conversationId: "model-conv",
      text: "再来一轮",
      agent: fakeAgent as any,
    });
    assert.deepEqual(seenModels, ["gpt-5.6-luna", undefined]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
