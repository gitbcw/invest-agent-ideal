import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type MethodCardView } from "@/lib/workspace-api";
import { methodAdoptSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { methodId: string };
}

/** 显式采用（adopt 草稿 / readopt 历史正式版本）。带默认采用约束的版本会被服务层拒绝并提示需 owner 决策。 */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = methodAdoptSchema.safeParse(body);
  if (!parsed.success) return badRequest("采用参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.METHOD_ADOPT, {
    methodId: params.methodId,
    versionId: parsed.data.versionId,
    mode: parsed.data.mode,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return workspaceResponse(remote);
}
