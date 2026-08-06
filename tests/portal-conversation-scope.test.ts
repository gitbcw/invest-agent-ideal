import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-conversation-scope-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "scope.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const conversation = await import("../src/services/conversation-log.js");
  return { database, conversation };
})();

const registeredScope = {
  userId: "111",
  projectId: "invest-agent",
  instanceId: "invest-agent-111",
  assistantId: "invest-agent-111",
};

test("new Portal conversations retain the registered business project scope", async () => {
  const { conversation } = await fixture;
  const resolved = conversation.__test__.resolveConversationPersistenceScope({
    scope: registeredScope,
    conversationId: "new-conversation",
    runtimeProjectId: "invest-agent-111",
  });
  assert.deepEqual(resolved, registeredScope);
});

test("existing Portal conversations retain their compatible runtime project scope", async () => {
  const { conversation } = await fixture;
  conversation.createConversationSession({
    scope: { ...registeredScope, projectId: "invest-agent-111" },
    conversationId: "existing-conversation",
    title: "旧对话",
  });

  const resolved = conversation.__test__.resolveConversationPersistenceScope({
    scope: registeredScope,
    conversationId: "existing-conversation",
    runtimeProjectId: "invest-agent-111",
  });
  assert.equal(resolved.projectId, "invest-agent-111");

  conversation.appendConversationMessage({
    scope: resolved,
    conversationId: "existing-conversation",
    channel: "web",
    role: "user",
    content: "继续旧对话",
  });
  conversation.appendConversationMessage({
    scope: resolved,
    conversationId: "existing-conversation",
    channel: "web",
    role: "assistant",
    content: "旧对话回复",
  });
});

test("Portal conversation compatibility rejects an unrelated project scope", async () => {
  const { conversation } = await fixture;
  conversation.createConversationSession({
    scope: { ...registeredScope, projectId: "unrelated-project" },
    conversationId: "foreign-project-conversation",
    title: "错误项目",
  });

  assert.throws(
    () => conversation.__test__.resolveConversationPersistenceScope({
      scope: registeredScope,
      conversationId: "foreign-project-conversation",
      runtimeProjectId: "invest-agent-111",
    }),
    conversation.ConversationScopeError,
  );
});
