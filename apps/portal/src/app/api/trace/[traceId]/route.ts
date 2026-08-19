import { ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES, type PortalError } from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";

/**
 * T-199 历史回看：按 traceId/messageId 拉取一轮的工具调用时间线与计量摘要。
 * 摘要级数据（无 prompt/reply 正文），scope 由 connector 注册身份强制。
 */
export interface TraceToolCallSummary {
  toolCallId?: string;
  toolName?: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
  errorExcerpt?: string;
}

export interface TraceSummaryResult {
  trace: {
    traceId: string;
    messageId: string | null;
    conversationId: string | null;
    createdAt: string;
    channel: string;
    mode: string;
    model: string | null;
    status: string;
    elapsedMs: number | null;
    firstTokenMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cost: number | null;
    costCurrency: string | null;
    errorMessage: string | null;
    toolCalls: TraceToolCallSummary[];
  } | null;
}

type Params = { params: { traceId: string } };

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();

  const remote = await sendConnectorRequest<TraceSummaryResult>(
    session.assistantId,
    PORTAL_TYPES.TRACE_GET,
    {
      userId: session.sub,
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      traceId: params.traceId
    }
  );

  if (!remote.ok) {
    const err: PortalError = {
      code: remote.code as PortalError["code"],
      message: remote.message,
      retryable: remote.retryable
    };
    return ok({ ok: false, error: err });
  }
  return ok({ ok: true, trace: remote.data.trace });
}
