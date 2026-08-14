import { z } from "zod";
import { nanoid } from "nanoid";

import { getConfig } from "@/lib/config";
import { openDatabase } from "@/lib/db";
import { mapConversationRow, ConversationMirrorRepository } from "@/lib/db/conversations";
import { badRequest, getIp, ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";
import {
  PORTAL_TYPES,
  type ConversationListResult
} from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";

const ListSchema = z.object({
  channel: z.enum(["web", "weixin-mobile"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(15),
  cursor: z.string().optional(),
  query: z.string().trim().max(64).optional(),
  archived: z.coerce.boolean().default(false)
});

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const parsed = ListSchema.safeParse({
    channel: url.searchParams.get("channel") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    query: url.searchParams.get("query") ?? undefined,
    archived: url.searchParams.get("archived") ?? undefined
  });
  if (!parsed.success) {
    return badRequest("参数错误", { issues: parsed.error.issues });
  }

  const db = openDatabase();
  const repo = new ConversationMirrorRepository(db);

  // 1. connector 在线 -> 先用 connector 返回的列表同步 mirror。
  // 用户级重命名/归档/删除/置顶只保存在 portal mirror 上,最终列表从本地视图生成。
  const remote = await sendConnectorRequest<ConversationListResult>(
    session.assistantId,
    PORTAL_TYPES.CONVERSATION_LIST,
    {
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      channel: parsed.data.channel,
      limit: 50
    }
  );

  if (remote.ok) {
    for (const conv of remote.data.items) {
      repo.upsertConversation({
        conversationId: conv.conversationId,
        userId: session.sub,
        assistantId: session.assistantId,
        instanceId: session.instanceId,
        channel: conv.channel,
        title: conv.title,
        lastMessagePreview: conv.lastMessagePreview,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt
      });
    }
  }

  // 2. 用 mirror 生成用户视图:支持搜索、归档、删除过滤、置顶排序和离线缓存。
  const local = repo.listConversations({
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId,
    channel: parsed.data.channel,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
    query: parsed.data.query,
    archived: parsed.data.archived
  });

  return ok({
    items: local.items.map((row) => ({
      ...mapConversationRow(row),
      processing: repo.isConversationProcessing({
        conversationId: row.conversation_id,
        userId: session.sub,
        assistantId: session.assistantId,
        instanceId: session.instanceId
      })
    })),
    nextCursor: local.nextCursor
  });
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  // 创建一个空会话(只写云端镜像,本地 connector 会在第一次 chat 时同步)
  // 简化设计:不做"预创建",让前端直接以新建 conversationId 发起 chat。
  // 这里保留 POST 接口,返回一个未持久化的 conversationId,客户端把它作为 placeholder。
  const cfg = getConfig();
  const conversationId = `web_${nanoid(16)}`;
  void getIp(request as never); // 暂不审计
  void cfg;

  return ok({
    conversationId,
    title: "新的对话",
    createdAt: new Date().toISOString()
  });
}
