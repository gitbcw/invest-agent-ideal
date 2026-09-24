import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { skillInstallSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { skillId: string };
}

/** 安装或显式升级（body 可带 releaseId/versionId 目标；缺省解析当前可装版本）。 */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const parsed = skillInstallSchema.safeParse(body ?? {});
  if (!parsed.success) return badRequest("安装参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.SKILL_INSTALL, {
    skillId: params.skillId,
    ...parsed.data,
  });
  return workspaceResponse(remote);
}
