import { z } from "zod";

import { openDatabase } from "@/lib/db";
import { ConversationMirrorRepository } from "@/lib/db/conversations";
import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, notFound, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ConversationChatResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

const RegenerateSchema = z.object({
  messageId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(128).optional()
});

type Params = { params: { id: string } };

/**
 * 重新生成最后一条 assistant 回答（owner 2026-08-26）：旧回答在 runtime 侧标记
 * superseded，并以原 user 消息重放一轮。镜像侧同步移除旧行、写入新回复。
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
  const parsed = RegenerateSchema.safeParse(body);
  if (!parsed.success) return badRequest("参数错误", { issues: parsed.error.issues });

  const scope = {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  };
  const repo = new ConversationMirrorRepository(openDatabase());
  const conversation = repo.getConversation(params.id, scope);
  if (!conversation || conversation.deleted_at) return notFound("会话不存在");

  const remote = await sendConnectorRequest<ConversationChatResult>(
    session.assistantId,
    PORTAL_TYPES.CONVERSATION_REGENERATE,
    {
      ...scope,
      conversationId: params.id,
      messageId: parsed.data.messageId,
      model: parsed.data.model
    }
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }

  // 镜像同步：旧行按 messageId 删除（不存在时为无操作），新回复幂等写入。
  repo.removeMessage({ ...scope, messageId: parsed.data.messageId, conversationId: params.id, updatedAt: remote.data.assistantMessage.createdAt });
  repo.upsertMessage(remote.data.assistantMessage);
  repo.touchConversationPreview(
    params.id,
    remote.data.assistantMessage.content.slice(0, 80),
    remote.data.assistantMessage.createdAt,
    scope
  );
  return ok(remote.data);
}
