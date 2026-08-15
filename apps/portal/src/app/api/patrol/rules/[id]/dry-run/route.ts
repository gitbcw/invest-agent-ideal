import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { id: string } };

export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("规则 id 无效");
  const remote = await sendConnectorRequest<Record<string, unknown>>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RULES_DRY_RUN, { id });
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  return ok(remote.data);
}
