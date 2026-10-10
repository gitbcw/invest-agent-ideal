import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { methodCreateSchema } from "@/lib/workspace-schemas";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<{ items: unknown[]; agents: unknown[] }>(session, PORTAL_TYPES.METHOD_LIST, {});
  return workspaceResponse(remote);
}

/** 新建策略：创建对象 + 首版本（草稿，需在详情中采用）。 */
export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = methodCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest("策略参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.METHOD_CREATE, parsed.data);
  return workspaceResponse(remote);
}
