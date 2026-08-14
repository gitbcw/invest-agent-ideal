import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import { PORTAL_TYPES, type WorkspaceFileGetResult } from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

/** Read-only bytes endpoint. The runtime validates the relative path against
 * the connector's bound workspace and never receives a browser-supplied scope. */
export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const relativePath = new URL(request.url).searchParams.get("path")?.trim();
  if (!relativePath) return badRequest("缺少文件路径");
  const remote = await sendConnectorRequest<WorkspaceFileGetResult>(
    session.assistantId,
    PORTAL_TYPES.WORKSPACE_FILE_GET,
    { relativePath },
  );
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable });
  return ok(remote.data);
}
