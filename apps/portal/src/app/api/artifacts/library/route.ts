import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactLibraryListRequest,
  type ArtifactLibraryListResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

/**
 * GET /api/artifacts/library?cursor=&limit=
 *
 * Pages through the curated, read-only document library for the authenticated
 * session. Scope (userId/instanceId) is injected by the connector from the
 * registered session; the browser only sends `cursor` and `limit`. The result
 * is a virtual tree built by the runtime from the authoritative artifact
 * index — never a workspace directory listing.
 */
export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor")?.trim() || undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    return badRequest("limit 必须是正整数");
  }

  const payload: ArtifactLibraryListRequest = {
    cursor,
    limit: limit ? Math.min(Math.floor(limit), 500) : undefined
  };
  const remote = await sendConnectorRequest<ArtifactLibraryListResult>(
    session.assistantId,
    PORTAL_TYPES.ARTIFACT_LIBRARY_LIST,
    payload
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }
  return ok(remote.data);
}
