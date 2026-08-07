import assert from "node:assert/strict";
import test from "node:test";
import { getAssistantMessageByRequestId } from "../src/services/conversation-log.js";
import { appendConversationMessage, getConversationMessageByIdempotencyKey } from "../src/services/conversation-log.js";

test("WeChat inbound idempotency keeps a duplicate delivery from creating a second reply", () => {
  const scope = {
    userId: "weixin-idempotency-user",
    projectId: "invest-agent",
    instanceId: "invest-agent-weixin-idempotency-user",
    assistantId: "invest-agent-weixin-idempotency-user",
  };
  const conversationId = "weixin-idempotency-conversation";
  const requestId = "weixin-inbound:test-account:test-client-message";

  const user = appendConversationMessage({
    scope,
    conversationId,
    channel: "weixin-mobile",
    role: "user",
    content: "晚上好",
    requestId,
    idempotencyKey: requestId,
  });
  appendConversationMessage({
    scope,
    conversationId,
    channel: "weixin-mobile",
    role: "assistant",
    content: "晚上好！",
    requestId: user.requestId,
  });

  const duplicate = getConversationMessageByIdempotencyKey({ idempotencyKey: requestId, scope, conversationId });
  assert.equal(duplicate?.messageId, user.messageId);
  assert.equal(
    getAssistantMessageByRequestId({ conversationId, requestId: duplicate?.requestId || "" })?.content,
    "晚上好！",
  );
});
