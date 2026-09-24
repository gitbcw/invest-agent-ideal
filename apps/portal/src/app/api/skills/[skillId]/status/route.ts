import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { skillStatusSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { skillId: string };
}

/** Toggle a skill installation without removing its installation history. */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = skillStatusSchema.safeParse(body);
  if (!parsed.success) return badRequest("Skill 状态参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.SKILL_INSTALLATION_STATUS, {
    skillId: params.skillId,
    enabled: parsed.data.enabled,
    idempotencyKey: parsed.data.idempotencyKey,
  });
  return workspaceResponse(remote);
}
