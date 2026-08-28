import { z } from "zod";

import { openDatabase } from "@/lib/db";
import { ConversationMirrorRepository } from "@/lib/db/conversations";
import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, notFound, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ConversationMessage
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

const FeedbackSchema = z.object({
  messageId: z.string().trim().min(1).max(128),
  rating: z.union([z.literal("like"), z.literal("dislike"), z.null()]),
  // 点踩弹窗文字反馈（owner 2026-08-28）：缺省 = 不动；null/空 = 清除；否则覆盖。
  comment: z.string().max(500).nullish()
});

type Params = { params: { id: string } };

/**
 * 用户对 assistant 回答的【喜欢/不喜欢】标注（owner 2026-08-26）：
 * 写入 runtime 权威库的 message metadata；镜像同步更新，返回最新消息。
 */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (!params.id.trim()) return badRequest("会话 ID 不能为空");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = FeedbackSchema.safeParse(body);
  if (!parsed.success) return badRequest("参数错误", { issues: parsed.error.issues });

  const scope = {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  };
  const repo = new ConversationMirrorRepository(openDatabase());
  const conversation = repo.getConversation(params.id, scope);
  if (!conversation || conversation.deleted_at) return notFound("会话不存在");

  const remote = await sendConnectorRequest<{ message: ConversationMessage }>(
    session.assistantId,
    PORTAL_TYPES.CONVERSATION_FEEDBACK,
    {
      ...scope,
      conversationId: params.id,
      messageId: parsed.data.messageId,
      rating: parsed.data.rating,
      ...(parsed.data.comment === undefined ? {} : { comment: parsed.data.comment })
    }
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }
  repo.upsertMessage(remote.data.message);
  return ok({ message: remote.data.message });
}
