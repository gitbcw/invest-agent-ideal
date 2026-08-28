import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-regen-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "regen.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const database = await import("../src/db/index.js");
  database.initDb();
  const conversations = await import("../src/services/conversation-log.js");
  const history = await import("../src/services/conversation-history.js");
  return { conversations, history };
})();

const scope = {
  userId: "portal-regen-user",
  projectId: "invest-agent",
  instanceId: "portal-regen-instance",
  assistantId: "portal-regen-instance",
};

function fakeAgent(reply: string, seen: Array<{ text: string }> = []) {
  return {
    agentId: "regen-test-agent",
    agentName: "regen test",
    capabilities: ["chat"],
    async handleMessage(message: { content?: { text?: string } }) {
      seen.push({ text: String(message.content?.text ?? "") });
      return { content: { type: "text" as const, text: reply }, finished: true };
    },
  };
}

test("regenerate replaces the last reply, excludes it from history, and keeps one user row (owner 2026-08-26)", async () => {
  const { conversations, history } = await fixture;
  const conversationId = "regen-happy-path";
  const seenFirst: Array<{ text: string }> = [];
  const first = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "帮我分析赣锋锂业",
    agent: fakeAgent("第一版回答（不够好）", seenFirst),
  });
  assert.equal(first.assistantMessage.status, "sent");
  assert.equal(first.assistantMessage.content, "第一版回答（不够好）");

  const seenRegen: Array<{ text: string }> = [];
  const regenerated = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    regenerateAssistantMessageId: first.assistantMessage.messageId,
    agent: fakeAgent("第二版回答（更好）", seenRegen),
  });
  assert.equal(regenerated.assistantMessage.status, "sent");
  assert.equal(regenerated.assistantMessage.content, "第二版回答（更好）");
  // 轮真实时长落 metadata：重新生成轮的用时以它为准，而不是跨到原提问时间。
  assert.equal(typeof regenerated.assistantMessage.metadata?.executionDurationMs, "number");
  assert.ok((regenerated.assistantMessage.metadata?.executionDurationMs as number) >= 0);
  // 重放轮拿到的正是原 user 消息的文本，且不新插 user 行。
  assert.equal(seenRegen.length, 1);
  assert.equal(seenRegen[0].text, seenFirst[0].text);

  const listed = conversations.getConversation({ ...scope, conversationId })?.messages ?? [];
  const userRows = listed.filter((m) => m.role === "user");
  assert.equal(userRows.length, 1, "regenerate must not append a duplicate user row");
  const assistantContents = listed.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(assistantContents, ["第二版回答（更好）"], "superseded reply must be hidden from the portal listing");

  // 审计行保留：DB 里旧回答仍存在，状态为 superseded。
  const raw = (await import("../src/db/index.js")).sqlite
    .prepare(`SELECT status FROM conversation_messages WHERE message_id = ?`)
    .get(first.assistantMessage.messageId) as { status: string } | undefined;
  assert.equal(raw?.status, "superseded");

  // 模型历史排除 superseded：后续轮看不到旧回答，看得到新回答。
  const modelHistory = history.loadConversationHistory({ conversationId });
  const historyTexts = modelHistory.map((m) => m.content);
  assert.equal(historyTexts.includes("第一版回答（不够好）"), false);
  assert.equal(historyTexts.includes("第二版回答（更好）"), true);
});

test("regenerate only accepts the last reply and rejects invalid targets", async () => {
  const { conversations } = await fixture;
  const conversationId = "regen-guards";
  const first = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "第一问",
    agent: fakeAgent("第一答"),
  });
  await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "第二问",
    agent: fakeAgent("第二答"),
  });
  await assert.rejects(
    () => conversations.chatViaConversationLog({
      ...scope,
      conversationId,
      regenerateAssistantMessageId: first.assistantMessage.messageId,
      agent: fakeAgent("不应出现"),
    }),
    /REGENERATE_ONLY_LAST_REPLY/
  );
  await assert.rejects(
    () => conversations.chatViaConversationLog({
      ...scope,
      conversationId,
      regenerateAssistantMessageId: "no-such-message",
      agent: fakeAgent("不应出现"),
    }),
    /REGENERATE_TARGET_INVALID/
  );
  // 守卫拒绝不得污染现状：两条 user、两条 assistant 均保持 sent。
  const listed = conversations.getConversation({ ...scope, conversationId })?.messages ?? [];
  assert.equal(listed.filter((m) => m.role === "user").length, 2);
  assert.equal(listed.filter((m) => m.role === "assistant" && m.status === "sent").length, 2);
});

test("feedback labels an assistant reply, switches, and revokes (owner 2026-08-26)", async () => {
  const { conversations } = await fixture;
  const conversationId = "feedback-path";
  const turn = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "帮我看看大盘",
    agent: fakeAgent("大盘点评"),
  });
  const targetId = turn.assistantMessage.messageId;

  const like = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "like",
  });
  assert.equal(like.metadata?.userFeedback, "like");

  // 切换为 dislike：同一键覆写。
  const dislike = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "dislike",
  });
  assert.equal(dislike.metadata?.userFeedback, "dislike");

  // 撤销：键移除，其余 metadata 字段保留。
  const revoked = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: null,
  });
  assert.equal(revoked.metadata?.userFeedback, undefined);

  // user 消息与无效目标拒绝。
  assert.throws(
    () => conversations.setConversationMessageFeedback({
      ...scope,
      conversationId,
      messageId: turn.userMessage.messageId,
      rating: "like",
    }),
    /FEEDBACK_TARGET_INVALID/
  );
  assert.throws(
    () => conversations.setConversationMessageFeedback({
      ...scope,
      conversationId,
      messageId: "no-such-message",
      rating: "like",
    }),
    /FEEDBACK_TARGET_INVALID/
  );

  // 原始行可被分析侧直接 json_extract 取出。
  const raw = (await import("../src/db/index.js")).sqlite
    .prepare(`SELECT json_extract(metadata, '$.userFeedback') AS rating FROM conversation_messages WHERE message_id = ?`)
    .get(targetId) as { rating: string | null };
  assert.equal(raw.rating, null);
});

test("feedback comment: dislike dialog submit, omit preserves, empty clears, revoke purges (owner 2026-08-28)", async () => {
  const { conversations } = await fixture;
  const conversationId = "feedback-comment";
  const turn = await conversations.chatViaConversationLog({
    ...scope,
    conversationId,
    text: "帮我分析一下持仓",
    agent: fakeAgent("持仓分析"),
  });
  const targetId = turn.assistantMessage.messageId;

  // 点踩弹窗提交：dislike + 文字反馈落库（trim 后写入）。
  const withComment = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "dislike",
    comment: "  数据来源不对  ",
  });
  assert.equal(withComment.metadata?.userFeedback, "dislike");
  assert.equal(withComment.metadata?.userFeedbackComment, "数据来源不对");

  // 弹窗跳过（不带 comment）：dislike 幂等，已有评论保留。
  const kept = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "dislike",
  });
  assert.equal(kept.metadata?.userFeedback, "dislike");
  assert.equal(kept.metadata?.userFeedbackComment, "数据来源不对");

  // 显式空评论 = 清除文字反馈，标注本身保留。
  const cleared = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "dislike",
    comment: "   ",
  });
  assert.equal(cleared.metadata?.userFeedback, "dislike");
  assert.equal(cleared.metadata?.userFeedbackComment, undefined);

  // 超长评论截断到 500 字符。
  const truncated = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: "dislike",
    comment: "x".repeat(600),
  });
  assert.equal(truncated.metadata?.userFeedbackComment?.length, 500);

  // 撤销标注（再次点击踩按钮）：rating 与 comment 一并清除。
  const revoked = conversations.setConversationMessageFeedback({
    ...scope,
    conversationId,
    messageId: targetId,
    rating: null,
  });
  assert.equal(revoked.metadata?.userFeedback, undefined);
  assert.equal(revoked.metadata?.userFeedbackComment, undefined);
});
