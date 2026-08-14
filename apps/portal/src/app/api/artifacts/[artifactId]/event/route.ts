import { z } from "zod";

import { getCurrentSession } from "@/lib/auth";
import { badRequest, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactEventRequest,
  type ArtifactEventResult
} from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { artifactId: string } };

const Body = z.object({
  event: z.enum(["open", "success", "failure", "download"]),
  status: z.enum(["success", "failure", "denied"]).optional(),
  reason: z.string().trim().max(200).optional()
});

/**
 * Forwards a lightweight artifact telemetry event to the runtime so preview
 * open / success / failure / download interactions can be audited without
 * persisting content or absolute paths. Best-effort: failures are surfaced
 * but do not block the UI.
 */
export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const artifactId = params.artifactId?.trim();
  if (!artifactId) return badRequest("缺少 artifactId");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) return badRequest("参数错误", { issues: parsed.error.issues });

  const payload: ArtifactEventRequest = {
    artifactId,
    event: parsed.data.event,
    status: parsed.data.status,
    reason: parsed.data.reason
  };
  const remote = await sendConnectorRequest<ArtifactEventResult>(
    session.assistantId,
    PORTAL_TYPES.ARTIFACT_EVENT,
    payload
  );
  if (!remote.ok) {
    // Telemetry must never block the UI; report a graceful accepted=false so
    // the client can move on without surfacing the failure to the user.
    return ok({ accepted: false, ignored: true, code: remote.code });
  }
  return ok(remote.data);
}
