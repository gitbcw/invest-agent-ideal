import { openDatabase } from "@/lib/db";
import { ConversationMirrorRepository } from "@/lib/db/conversations";
import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, notFound, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ConversationCancelResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { id: string } };

/**
 * Request cancellation through the authenticated connector. The connector
 * derives user/instance/project scope from its registration; the browser can
 * only address the conversation id in the URL.
 */
export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (!params.id.trim()) return badRequest("会话 ID 不能为空");

  const repo = new ConversationMirrorRepository(openDatabase());
  const conversation = repo.getConversation(params.id, {
    userId: session.sub,
    assistantId: session.assistantId,
    instanceId: session.instanceId
  });
  if (!conversation || conversation.deleted_at) return notFound("会话不存在");

  const remote = await sendConnectorRequest<ConversationCancelResult>(
    session.assistantId,
    PORTAL_TYPES.CONVERSATION_CANCEL,
    { conversationId: params.id }
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }
  return ok(remote.data);
}
