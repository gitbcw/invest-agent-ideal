import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type SkillDetailView } from "@/lib/workspace-api";
import { skillEditSchema } from "@/lib/workspace-schemas";

interface Params {
  params: { skillId: string };
}

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<SkillDetailView>(session, PORTAL_TYPES.SKILL_GET, { skillId: params.skillId });
  return workspaceResponse(remote);
}

/** 编辑私有 Skill：形成新草稿版本；明确启用（approve）后才影响助手。 */
export async function PUT(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = skillEditSchema.safeParse(body);
  if (!parsed.success) return badRequest("Skill 版本参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<{ skillId: string; version: { version_id: string; version_number: number; status: string } }>(
    session,
    PORTAL_TYPES.SKILL_EDIT,
    { ...parsed.data, skillId: params.skillId },
  );
  return workspaceResponse(remote);
}

/** 卸载（页面语义=删除）：安装行保留 removed 状态供追溯，运行解析随即拒绝；
 * 私有技能同事务打墓碑彻底从列表/目录消失（2026-10-08 裁决），系统域技能仍可从目录找回。 */
export async function DELETE(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.SKILL_UNINSTALL, { skillId: params.skillId });
  return workspaceResponse(remote);
}
