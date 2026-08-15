import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { fail, ok, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type PatrolRunNowPayload = {
  ranAt: string;
  items: Array<{ stockCode: string; stockName: string; message: string; severity: string }>;
  error?: string;
};

export async function POST() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<PatrolRunNowPayload>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RUN_NOW, {});
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  return ok(remote.data);
}
