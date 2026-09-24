import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type MethodWorkingCopyView } from "@/lib/workspace-api";
import { methodWorkingCopySaveSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { assetId: string };
}

/** 工作副本（未发布修改）：普通保存写这里，不进版本链、不影响采用态。 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<MethodWorkingCopyView>(session, PORTAL_TYPES.METHOD_WORKING_COPY_GET, { assetId: params.assetId });
  return workspaceResponse(remote);
}

export async function PUT(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = methodWorkingCopySaveSchema.safeParse(body);
  if (!parsed.success) return badRequest("工作副本参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<{ assetId: string; baseVersionId: string | null; updatedAt: string }>(
    session,
    PORTAL_TYPES.METHOD_WORKING_COPY_SAVE,
    { ...parsed.data, assetId: params.assetId },
  );
  return workspaceResponse(remote);
}

/** 清除工作副本（保存为新版本后的收尾，或用户主动放弃修改）。 */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<{ assetId: string; cleared: boolean }>(
    session,
    PORTAL_TYPES.METHOD_WORKING_COPY_CLEAR,
    { assetId: params.assetId },
  );
  return workspaceResponse(remote);
}
