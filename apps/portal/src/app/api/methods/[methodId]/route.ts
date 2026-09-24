import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type MethodCardView, type MethodDetailView } from "@/lib/workspace-api";
import { methodAddVersionSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { methodId: string };
}

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<MethodDetailView>(session, PORTAL_TYPES.METHOD_GET, { methodId: params.methodId });
  return workspaceResponse(remote);
}

/** 编辑方法：形成新内容版本（草稿，待确认）；不改当前采用版本。 */
export async function PUT(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = methodAddVersionSchema.safeParse(body);
  if (!parsed.success) return badRequest("方法版本参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<{ method: MethodCardView; version: { versionId: string; versionNumber: number; status: string; createdAt: string } }>(
    session,
    PORTAL_TYPES.METHOD_ADD_VERSION,
    { ...parsed.data, methodId: params.methodId },
  );
  return workspaceResponse(remote);
}
