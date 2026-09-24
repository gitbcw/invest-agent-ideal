import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { skillEnableSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { skillId: string };
}

/** 启用私有 Skill 的指定版本（approve → current）。停用走卸载。 */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = skillEnableSchema.safeParse(body);
  if (!parsed.success) return badRequest("启用参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.SKILL_SET_ENABLED, {
    skillId: params.skillId,
    versionId: parsed.data.versionId,
    enabled: true,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return workspaceResponse(remote);
}
