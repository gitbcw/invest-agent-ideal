import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";

interface Params {
  params: { itemId: string };
}

/** 用户手动关闭关注项（不开问题处理会话直接收口；幂等）。 */
export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (!params.itemId) return badRequest("itemId is required");
  const remote = await forwardWorkspace<{ itemId: string; status: string }>(
    session,
    PORTAL_TYPES.ATTENTION_RESOLVE,
    { itemId: params.itemId },
  );
  return workspaceResponse(remote);
}
