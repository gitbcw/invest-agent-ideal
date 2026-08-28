import { z } from "zod";

import { openDatabase } from "@/lib/db";
import {
  ConversationMirrorRepository,
  InvalidConversationMessageCursorError,
  mapConversationRow,
  mapMessageRow
} from "@/lib/db/conversations";
import { badRequest, notFound, ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES, type ConversationGetResult } from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";
import { syncConversationDetail } from "@/lib/conversation-detail-sync";

const GetSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  /** before: 配合 nextBeforeCursor 向更早方向翻页。缺省时首屏取最新 limit 条。 */
  before: z.string().optional()
}).refine((value) => !value.before || !value.cursor, "before 与 cursor 互斥");

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const url = new URL(request.url);
  const parsed = GetSchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    before: url.searchParams.get("before") ?? undefined
  });
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }

  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);
  // Ownership = the authenticated session's instance+assistant scope (1:1
  // with the portal user). A scope-filtered miss is "not found"; user_id
  // equality is not an ownership signal because meta rows may not exist yet.
  const sessionScope = {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  };
  const conv = repo.getConversation(params.id, sessionScope);
  if (!conv) return notFound("会话不存在");
  if (conv.deleted_at) return notFound("会话不存在");

  const sync = await syncConversationDetail({
    repo,
    conversationId: params.id,
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId,
    requestPage: (cursor, limit) => sendConnectorRequest<ConversationGetResult>(
      session.assistantId,
      PORTAL_TYPES.CONVERSATION_GET,
      {
        userId: session.sub,
        assistantId: session.assistantId,
        instanceId: session.instanceId,
        conversationId: params.id,
        limit,
        cursor
      }
    )
  });

  const refreshedConversation = repo.getConversation(params.id, sessionScope);
  if (!refreshedConversation) {
    if (sync.error?.code === "CONVERSATION_NOT_FOUND") return notFound("会话不存在");
    if (sync.error?.code === "CONNECTOR_OFFLINE") return notFound("会话不存在,且助手离线,无法补齐");
    return badRequest(sync.error?.message ?? "会话历史同步未完成", {
      code: sync.error?.code ?? "SYNC_LIMIT_EXCEEDED"
    });
  }
  if (!sync.complete) {
    console.warn(`[api/conversation] serving cached mirror after incomplete sync conversation=${params.id} code=${sync.error?.code ?? "UNKNOWN"}`);
  }

  try {
    const messages = repo.listMessages({
      conversationId: params.id,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
      before: parsed.data.before,
      latest: !parsed.data.cursor && !parsed.data.before,
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId
    });
    const processingStartedAt = repo.getConversationProcessingStartedAt({
      conversationId: params.id,
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId
    });
    return ok({
      conversationId: params.id,
      title: refreshedConversation.title_override || refreshedConversation.title,
      messages: messages.items.map(mapMessageRow),
      nextCursor: messages.nextCursor,
      nextBeforeCursor: messages.nextBeforeCursor,
      processing: processingStartedAt !== null,
      processingStartedAt
    });
  } catch (error) {
    if (error instanceof InvalidConversationMessageCursorError) {
      return badRequest("消息游标无效");
    }
    throw error;
  }
}

const PatchSchema = z.object({
  title: z.string().trim().min(1).max(64).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  labelId: z.string().trim().min(1).nullable().optional(),
  position: z.number().int().min(0).optional()
}).refine((value) => value.title !== undefined || value.pinned !== undefined || value.archived !== undefined || value.labelId !== undefined || value.position !== undefined);

export async function PATCH(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);
  const sessionScope = {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  };
  const conv = repo.getConversation(params.id, sessionScope);
  if (!conv) return notFound("会话不存在");
  if (conv.deleted_at) return notFound("会话不存在");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) return badRequest("参数错误");

  let refreshed = conv;
  if (parsed.data.title !== undefined) {
    refreshed = repo.renameConversation({
      conversationId: conv.conversation_id,
      userId: conv.user_id,
      assistantId: conv.assistant_id,
      title: parsed.data.title
    }) ?? refreshed;
  }
  if (parsed.data.pinned !== undefined) {
    refreshed = repo.setConversationPinned({
      conversationId: conv.conversation_id,
      userId: conv.user_id,
      assistantId: conv.assistant_id,
      pinned: parsed.data.pinned
    }) ?? refreshed;
  }
  if (parsed.data.archived !== undefined) {
    refreshed = repo.setConversationArchived({
      conversationId: conv.conversation_id,
      userId: conv.user_id,
      assistantId: conv.assistant_id,
      archived: parsed.data.archived
    }) ?? refreshed;
  }
  if (parsed.data.labelId !== undefined || parsed.data.position !== undefined) {
    if (parsed.data.labelId) {
      const label = repo.listLabels({ userId: conv.user_id, assistantId: conv.assistant_id }).find((item) => item.label_id === parsed.data.labelId);
      if (!label) return badRequest("标签不存在");
    }
    refreshed = repo.setConversationLabel({
      conversationId: conv.conversation_id,
      userId: conv.user_id,
      assistantId: conv.assistant_id,
      labelId: parsed.data.labelId ?? conv.label_id,
      position: parsed.data.position
    }) ?? refreshed;
  }
  return ok(mapConversationRow(refreshed));
}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);
  const conv = repo.getConversation(params.id, {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  });
  if (!conv || conv.deleted_at) return notFound("会话不存在");
  repo.softDeleteConversation({
    conversationId: conv.conversation_id,
    userId: session.sub,
    assistantId: session.assistantId
  });
  return ok({ conversationId: params.id, deleted: true });
}
