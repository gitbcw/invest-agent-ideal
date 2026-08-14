import { getCurrentSession } from "@/lib/auth";
import { fail, ok, unauthorized } from "@/lib/http";
import { PORTAL_TYPES, type WorkspaceFileListResult } from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

/** Read-only listing of user-owned workspace project files. */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<WorkspaceFileListResult>(
    session.assistantId,
    PORTAL_TYPES.WORKSPACE_FILE_LIST,
    {},
  );
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable });
  return ok(remote.data);
}
