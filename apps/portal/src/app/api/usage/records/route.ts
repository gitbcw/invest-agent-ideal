import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { ok, fail, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

export interface UsageRecordsPayload {
  items: Array<{
    id: number;
    created_at: string;
    model: string | null;
    modelSource: string | null;
    conversationId: string;
    channel: string;
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
    elapsedMs: number | null;
    firstTokenMs: number | null;
  }>;
  nextCursor: string | null;
}

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const url = new URL(request.url);
  const remote = await sendConnectorRequest<UsageRecordsPayload>(session.assistantId, PORTAL_TYPES.USAGE_RECORDS, {
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  return ok(remote.data);
}
