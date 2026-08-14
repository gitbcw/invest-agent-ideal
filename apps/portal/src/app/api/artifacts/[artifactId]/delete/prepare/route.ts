import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactDeletePrepareRequest,
  type ArtifactDeletePrepareResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { artifactId: string } };

/**
 * POST /api/artifacts/:artifactId/delete/prepare
 *
 * Step 1 of the two-step delete flow. The runtime validates that the artifact
 * is deletable under the caller's scope and returns a single-use confirmation
 * token bound to user/instance/artifact/path/checksum plus the impact notes
 * the Portal MUST show in its confirmation dialog. The browser never submits
 * a path or trash target.
 */
export async function POST(_request: Request, { params }: Params) {
  return new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "网页端不支持删除 workspace 文件" } }), {
    status: 405,
    headers: { "content-type": "application/json" }
  });
}
