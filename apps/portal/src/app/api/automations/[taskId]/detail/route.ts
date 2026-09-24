import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";

interface Params {
  params: { taskId: string };
}

/** 任务详情四块聚合：目标 / 依赖与产物 / 最近结果（执行·产物·投递分层）/ 需要注意。 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  if (!params.taskId) return badRequest("taskId is required");
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.AUTOMATION_DETAIL, { taskId: params.taskId });
  return workspaceResponse(remote);
}
