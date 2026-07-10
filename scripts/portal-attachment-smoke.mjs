#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../dist/db/index.js";
import {
  appendConversationMessage,
  getConversation,
} from "../dist/services/conversation-log.js";
import {
  storePortalAttachments,
  toPublicAttachmentMetadata,
} from "../dist/lib/attachment-store.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "invest-agent-portal-attachment-workspace-"));

try {
  initDb();
  const conversationId = `portal-attachment-smoke-${Date.now()}`;
  const scope = {
    userId: "test-portal-attachment",
    projectId: "invest-agent",
    instanceId: "invest-agent-test-portal-attachment",
    assistantId: "invest-agent-test-portal-attachment",
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwP9WQAAAABJRU5ErkJggg==",
    "base64"
  );
  const stored = await storePortalAttachments({
    workspacePath: workspace,
    attachments: [{
      kind: "image",
      fileName: "portfolio.png",
      mimeType: "image/png",
      sizeBytes: png.length,
      base64: png.toString("base64"),
    }],
  });
  const publicAttachments = stored.map(toPublicAttachmentMetadata);
  const userMessage = appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "用户上传了一张图片，请识别其中可能的持仓、观察仓、交易记录或投资相关信息。",
    idempotencyKey: `${conversationId}:user`,
    metadata: { attachments: publicAttachments },
  });
  const duplicateUserMessage = appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "user",
    content: "重复请求不应新增用户消息",
    idempotencyKey: `${conversationId}:user`,
    metadata: { attachments: [] },
  });
  assert.equal(duplicateUserMessage.messageId, userMessage.messageId);
  appendConversationMessage({
    scope,
    conversationId,
    channel: "web",
    role: "assistant",
    content: "已收到图片。",
  });

  const detail = getConversation({ ...scope, conversationId, limit: 10 });
  assert.equal(detail.messages.length, 2);
  const attachments = detail.messages[0].metadata?.attachments;
  assert.ok(Array.isArray(attachments));
  assert.equal(attachments[0].source, "portal");
  assert.equal(attachments[0].relativePath.startsWith("attachments/"), true);
  assert.equal(Object.hasOwn(attachments[0], "path"), false);

  console.log("[portal-attachment-smoke] ok", {
    conversationId,
    attachmentCount: attachments.length,
  });
} finally {
  await rm(workspace, { recursive: true, force: true });
}
