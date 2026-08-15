import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { ok, fail, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type PatrolStatusPayload = {
  status: {
    rulesTotal: number;
    rulesEnabled: number;
    latestRun: {
      runId: string;
      status: string;
      scheduledFor: string;
      claimedAt: string;
      finishedAt: string | null;
      resultSummary: string | null;
      errorMessage: string | null;
      pushed: boolean;
      attempt: number;
      createdAt: string;
    } | null;
    intervalMinutes: number;
  };
  runs: Array<Record<string, unknown>>;
};

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<PatrolStatusPayload>(session.assistantId, PORTAL_TYPES.RULE_PATROL_STATUS, {});
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  return ok(remote.data);
}
