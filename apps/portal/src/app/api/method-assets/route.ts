import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES, type MethodAssetCardView } from "@/lib/workspace-api";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<{ items: MethodAssetCardView[] }>(session, PORTAL_TYPES.METHOD_ASSET_LIST, {});
  return workspaceResponse(remote);
}
