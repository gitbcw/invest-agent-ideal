import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import {
  forwardWorkspace,
  workspaceResponse,
  PORTAL_TYPES,
  type CatalogSkillCardView,
  type InstalledSkillCardView,
  type PrivateSkillCardView,
  type ProjectSkillPreviewView,
} from "@/lib/workspace-api";
import { skillCreateSchema } from "@/lib/workspace-schemas";

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const view = new URL(request.url).searchParams.get("view") || "private";
  if (view === "private") {
    const remote = await forwardWorkspace<{ items: PrivateSkillCardView[] }>(session, PORTAL_TYPES.SKILL_LIST_PRIVATE, {});
    return workspaceResponse(remote);
  }
  if (view === "installed") {
    const remote = await forwardWorkspace<{ agent: { agentId: string; name: string; status: string }; items: InstalledSkillCardView[] }>(
      session,
      PORTAL_TYPES.SKILL_LIST_INSTALLED,
      {},
    );
    return workspaceResponse(remote);
  }
  if (view === "catalog") {
    const remote = await forwardWorkspace<{ items: CatalogSkillCardView[] }>(session, PORTAL_TYPES.SKILL_LIST_CATALOG, {});
    return workspaceResponse(remote);
  }
  if (view === "project-files") {
    const remote = await forwardWorkspace<{ items: ProjectSkillPreviewView[] }>(session, PORTAL_TYPES.SKILL_LIST_PROJECT_FILES, {});
    return workspaceResponse(remote);
  }
  return badRequest("view 必须是 private、installed、catalog 或 project-files");
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = skillCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest("Skill 参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<{ skillId: string; version: { versionId: string; status: string } }>(
    session,
    PORTAL_TYPES.SKILL_CREATE,
    parsed.data,
  );
  return workspaceResponse(remote);
}
