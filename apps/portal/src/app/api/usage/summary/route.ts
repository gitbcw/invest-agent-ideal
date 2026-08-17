import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { ok, fail, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

export interface UsageSummaryPayload {
  range: { from: string; to: string };
  totals: { calls: number; tokens: number; cost: number; failures: number };
  byModel: Array<{ model: string | null; calls: number; cost: number; tokens: number }>;
  byDay: Array<{ day: string; calls: number; cost: number }>;
}

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const url = new URL(request.url);
  const remote = await sendConnectorRequest<UsageSummaryPayload>(session.assistantId, PORTAL_TYPES.USAGE_SUMMARY, {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  });
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  return ok(remote.data);
}
