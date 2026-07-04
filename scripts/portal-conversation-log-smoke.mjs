import { initDb } from "../dist/db/index.js";
import {
  appendConversationMessage,
  getConversation,
  listConversations
} from "../dist/services/conversation-log.js";

const scope = {
  userId: "test-portal-log",
  projectId: "invest-agent",
  instanceId: "invest-agent-test-portal-log",
  assistantId: "invest-agent-test-portal-log"
};
const conversationId = `portal-smoke-${Date.now()}`;

initDb();

const userMessage = appendConversationMessage({
  scope,
  conversationId,
  channel: "web",
  role: "user",
  content: "门户烟测：请记录这条用户消息",
  idempotencyKey: `${conversationId}:user`
});

const duplicateUserMessage = appendConversationMessage({
  scope,
  conversationId,
  channel: "web",
  role: "user",
  content: "这条重复消息不应新增",
  idempotencyKey: `${conversationId}:user`
});

if (duplicateUserMessage.messageId !== userMessage.messageId) {
  throw new Error("idempotency key should return existing user message");
}

appendConversationMessage({
  scope,
  conversationId,
  channel: "web",
  role: "assistant",
  content: "门户烟测：助手回复已记录"
});

const list = listConversations({ ...scope, channel: "web", limit: 5 });
if (!list.items.some((item) => item.conversationId === conversationId)) {
  throw new Error("conversation list should include smoke conversation");
}

const detail = getConversation({ ...scope, conversationId, limit: 10 });
if (detail.messages.length !== 2) {
  throw new Error(`conversation should have 2 messages, got ${detail.messages.length}`);
}
if (detail.messages[0].role !== "user" || detail.messages[1].role !== "assistant") {
  throw new Error("conversation messages should preserve user -> assistant order");
}

console.log("[portal-conversation-log-smoke] ok", {
  conversationId,
  title: detail.title,
  messages: detail.messages.length
});
