import { z } from "zod";
import { nanoid } from "nanoid";

import { openDatabase } from "@/lib/db";
import {
  ConversationMirrorRepository,
  InvalidConversationMessageCursorError,
  mapMessageRow
} from "@/lib/db/conversations";
import { badRequest, forbidden, notFound, ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { DOCUMENT_MIME, IMAGE_MIME, canonicalAttachmentMime, isCsvFile } from "@/lib/attachment-policy";
import {
  PORTAL_TYPES,
  type ConversationChatResult,
  type ConversationGetResult,
  type PortalAttachmentInput,
  type PortalError
} from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";
import { syncConversationDetail } from "@/lib/conversation-detail-sync";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MESSAGE = 8;
const MAX_TOTAL_BYTES_PER_MESSAGE = 40 * 1024 * 1024;

const AttachmentSchema = z.object({
  kind: z.enum(["image", "document"]).optional(),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(160),
  sizeBytes: z.number().int().nonnegative(),
  base64: z.string().min(1).optional(),
  downloadUrl: z.string().url().optional()
}).refine((item) => Boolean(item.base64 || item.downloadUrl), "base64 或 downloadUrl 至少需要一个");

const SendSchema = z.object({
  text: z.string().trim().max(8000).optional(),
  attachments: z.array(AttachmentSchema).max(MAX_FILES_PER_MESSAGE).optional(),
  idempotencyKey: z.string().min(1).max(128).optional()
}).refine((item) => Boolean(item.text?.trim() || item.attachments?.length), "内容或附件至少需要一个");

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);
  const conv = repo.getConversation(params.id);
  if (conv && conv.user_id !== session.sub) return forbidden();
  if (!conv) return notFound("会话不存在");
  try {
    const messages = repo.listMessages({
      conversationId: params.id,
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
      cursor,
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId
    });
    return ok({ items: messages.items.map(mapMessageRow), nextCursor: messages.nextCursor });
  } catch (error) {
    if (error instanceof InvalidConversationMessageCursorError) {
      return badRequest("消息游标无效");
    }
    throw error;
  }
}

export async function POST(request: Request, { params }: Params) {
  const startedAt = Date.now();
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = SendSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }

  const text = parsed.data.text?.trim() || "";
  const attachments = (parsed.data.attachments || []).map(normalizeAttachment);
  const attachmentError = validateAttachments(attachments);
  if (attachmentError) return badRequest(attachmentError.message, attachmentError.details);
  const { idempotencyKey } = parsed.data;
  const conversationId = params.id;
  const userMessageId = `um_${nanoid(16)}`;
  const clientSentAt = new Date().toISOString();

  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);

  // 确保会话存在(本地云端镜像,作为占位)
  const existing = repo.getConversation(conversationId);
  if (existing && (existing.user_id !== session.sub || existing.assistant_id !== session.assistantId)) return forbidden();
  if (existing?.deleted_at) return notFound("会话不存在");
  if (!existing) {
    repo.upsertConversation({
      conversationId,
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      channel: "web",
      title: deriveTitle(text, attachments),
      createdAt: clientSentAt,
      updatedAt: clientSentAt
    });
  }

  // 立刻把 user 消息写进镜像(status=pending)
  const userMessage = {
    messageId: userMessageId,
    conversationId,
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId,
    channel: "web" as const,
    role: "user" as const,
    content: text || attachmentOnlyText(attachments),
    status: "pending" as const,
    requestId: idempotencyKey,
    createdAt: clientSentAt,
    metadata: attachments.length > 0
      ? { attachments: attachments.map(toPendingAttachmentMetadata) }
      : undefined
  };
  repo.upsertMessage(userMessage);
  repo.touchConversationPreview(
    conversationId,
    userMessage.content.slice(0, 80),
    clientSentAt,
    { userId: session.sub, assistantId: session.assistantId, instanceId: session.instanceId }
  );

  // 转发给 connector
  const relayTimeoutMs = getConfig().connectorRequestTimeoutMs;
  console.log(`[api/chat] request start conversation=${conversationId} user=${session.sub} assistant=${session.assistantId} timeoutMs=${relayTimeoutMs}`);
  const remote = await sendConnectorRequest<ConversationChatResult>(
    session.assistantId,
    PORTAL_TYPES.CONVERSATION_CHAT,
    {
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      conversationId,
      userMessageId,
      text,
      attachments,
      idempotencyKey: idempotencyKey ?? userMessageId,
      clientSentAt
    },
    relayTimeoutMs
  );

  if (!remote.ok) {
    console.warn(`[api/chat] request failed conversation=${conversationId} user=${session.sub} assistant=${session.assistantId} code=${remote.code} elapsedMs=${Date.now() - startedAt}`);
    const scope = { userId: session.sub, assistantId: session.assistantId, instanceId: session.instanceId };
    if (remote.code === "TIMEOUT" || remote.code === "CONNECTOR_OFFLINE") {
      repo.markReconciliationPending({
        ...scope,
        conversationId,
        userMessageId,
        requestId: idempotencyKey ?? userMessageId,
        reason: remote.code
      });
      // Do not make the user wait for a second Relay deadline. A connector
      // that is still busy can answer this best-effort read later; the marker
      // remains until a canonical assistant message is observed.
      void syncConversationDetail({
        repo,
        conversationId,
        ...scope,
        requestPage: (cursor, limit) =>
          sendConnectorRequest<ConversationGetResult>(
            session.assistantId,
            PORTAL_TYPES.CONVERSATION_GET,
            {
              ...scope,
              conversationId,
              limit,
              cursor
            }
          )
      }).catch((error) => {
        repo.recordReconciliationError({
          ...scope,
          conversationId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    repo.markMessageFailed(userMessageId, conversationId, new Date().toISOString(), scope);
    const err: PortalError = {
      code: remote.code as PortalError["code"],
      message: remote.message,
      retryable: remote.retryable,
      details: remote.details
    };
    return ok({
      ok: false,
      conversationId,
      userMessage,
      error: err
    });
  }

  // 把 connector 返回的最终消息写入镜像(幂等)
  const scope = { userId: session.sub, assistantId: session.assistantId, instanceId: session.instanceId };
  if (remote.data.userMessage.messageId !== userMessageId) {
    // A browser retry can receive the canonical result of an earlier request
    // with the same idempotency key. Remove this request's provisional row;
    // otherwise it remains pending forever beside the canonical turn.
    repo.removeMessage({ ...scope, messageId: userMessageId, conversationId, updatedAt: remote.data.assistantMessage.createdAt });
  }
  repo.upsertMessage(remote.data.userMessage);
  repo.upsertMessage(remote.data.assistantMessage);
  repo.touchConversationPreview(
    conversationId,
    remote.data.assistantMessage.content.slice(0, 80),
    remote.data.assistantMessage.createdAt,
    scope
  );

  console.log(`[api/chat] request done conversation=${conversationId} user=${session.sub} assistant=${session.assistantId} elapsedMs=${Date.now() - startedAt}`);
  return ok({
    ok: true,
    conversationId,
    userMessage: remote.data.userMessage,
    assistantMessage: remote.data.assistantMessage,
    traceId: remote.data.traceId
  });
}

function validateAttachments(attachments: PortalAttachmentInput[]) {
  const total = attachments.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (total > MAX_TOTAL_BYTES_PER_MESSAGE) {
    return {
      message: "附件总大小超过 40MB",
      details: { limitBytes: MAX_TOTAL_BYTES_PER_MESSAGE, sizeBytes: total }
    };
  }
  for (const item of attachments) {
    const mimeType = item.mimeType.toLowerCase();
    const isImage = IMAGE_MIME.includes(mimeType as (typeof IMAGE_MIME)[number]);
    const isDocument = DOCUMENT_MIME.includes(mimeType as (typeof DOCUMENT_MIME)[number]);
    if (!isImage && !isDocument) {
      return { message: `不支持的附件类型: ${item.mimeType}`, details: { fileName: item.fileName, mimeType: item.mimeType } };
    }
    const limit = isImage ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (item.sizeBytes > limit) {
      return {
        message: `${item.fileName} 超过单文件大小限制`,
        details: { fileName: item.fileName, limitBytes: limit, sizeBytes: item.sizeBytes }
      };
    }
  }
  return null;
}

function normalizeAttachment(item: PortalAttachmentInput): PortalAttachmentInput {
  const mimeType = canonicalAttachmentMime(item.fileName, item.mimeType);
  if (isCsvFile(item.fileName, item.mimeType)) {
    return { ...item, kind: "document", mimeType };
  }
  return { ...item, mimeType };
}

function toPendingAttachmentMetadata(item: PortalAttachmentInput) {
  return {
    id: `pending_${nanoid(10)}`,
    type: item.kind || (IMAGE_MIME.includes(item.mimeType.toLowerCase() as (typeof IMAGE_MIME)[number]) ? "image" : "document"),
    mimeType: item.mimeType,
    fileName: item.fileName,
    sizeBytes: item.sizeBytes,
    source: "portal"
  };
}

function attachmentOnlyText(attachments: PortalAttachmentInput[]) {
  const hasDocument = attachments.some((item) => item.kind === "document" || DOCUMENT_MIME.includes(item.mimeType.toLowerCase() as (typeof DOCUMENT_MIME)[number]));
  const hasImage = attachments.some((item) => item.kind === "image" || IMAGE_MIME.includes(item.mimeType.toLowerCase() as (typeof IMAGE_MIME)[number]));
  if (hasDocument && !hasImage) return "用户上传了一份文档，请先概括内容并说明可提取的信息。";
  if (hasImage && !hasDocument) return "用户上传了一张图片，请识别其中可能的持仓、观察仓、交易记录或投资相关信息。";
  return "用户上传了图片和文档，请先识别附件内容，并说明其中可提取的投资相关信息。";
}

function deriveTitle(text: string, attachments: PortalAttachmentInput[] = []): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean && attachments.length > 0) return `附件消息(${attachments.length})`;
  if (!clean) return "新的对话";
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}
