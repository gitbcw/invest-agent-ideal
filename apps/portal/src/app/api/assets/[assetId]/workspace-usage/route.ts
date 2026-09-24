import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";

interface Params {
  params: { assetId: string };
}

/** 文件页关联升级：该资产被哪些方法/Skill 引用（只读跳转，不形成第二编辑入口）。 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<{
    methods: Array<{ methodId: string; name: string; currentVersionId: string | null }>;
    skills: Array<{ skillId: string; name: string; slug: string; currentVersionId: string | null }>;
  }>(session, PORTAL_TYPES.ASSET_WORKSPACE_USAGE, { assetId: params.assetId });
  return workspaceResponse(remote);
}
