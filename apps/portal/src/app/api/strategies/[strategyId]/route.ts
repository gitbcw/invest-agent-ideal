import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { methodAddVersionSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { strategyId: string };
}

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.METHOD_GET, { methodId: params.strategyId });
  return workspaceResponse(remote);
}

/** 编辑策略：新版本（保存即采用）。 */
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
  if (!parsed.success) return badRequest("策略参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.METHOD_ADD_VERSION, { ...parsed.data, methodId: params.strategyId });
  return workspaceResponse(remote);
}

/** 设为主策略。 */
export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.STRATEGY_SET_PRIMARY, { strategyId: params.strategyId });
  return workspaceResponse(remote);
}
