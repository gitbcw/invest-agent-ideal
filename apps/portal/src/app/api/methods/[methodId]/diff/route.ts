import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type MethodDiffView } from "@/lib/workspace-api";

interface Params {
  params: { methodId: string };
}

/** 版本 Diff：双版本正文并排（服务层已做同方法校验）。 */
export async function GET(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const url = new URL(request.url);
  const fromVersionId = url.searchParams.get("from") || "";
  const toVersionId = url.searchParams.get("to") || "";
  if (!fromVersionId || !toVersionId) return badRequest("缺少 from/to 版本参数");
  const remote = await forwardWorkspace<MethodDiffView>(session, PORTAL_TYPES.METHOD_DIFF, { fromVersionId, toVersionId });
  return workspaceResponse(remote);
}
