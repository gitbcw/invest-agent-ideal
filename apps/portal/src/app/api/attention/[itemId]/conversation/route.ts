import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";

interface Params {
  params: { itemId: string };
}

/** 打开（或复用）绑定失败事项的问题处理会话。 */
export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (!params.itemId) return badRequest("itemId is required");
  const remote = await forwardWorkspace<{ conversationId: string; itemId: string; reused: boolean }>(
    session,
    PORTAL_TYPES.ATTENTION_OPEN_CONVERSATION,
    { itemId: params.itemId },
  );
  return workspaceResponse(remote);
}
