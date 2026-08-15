import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<{ items: unknown[] }>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RULES_LIST, {});
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  return ok(remote.data);
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const input = body as { stockCode?: string; stockName?: string; ruleType?: string; operator?: string; value?: number; period?: number; direction?: string; priority?: string };
  const stockCode = (input.stockCode ?? "").trim();
  if (!/^\d{6}$/.test(stockCode)) return badRequest("股票代码必须是 6 位数字");
  const ruleType = input.ruleType === "ma_cross" ? "ma_cross" : "price_cross";
  const payload: Record<string, unknown> = {
    stockCode,
    stockName: (input.stockName ?? "").trim(),
    ruleType,
    priority: input.priority,
  };
  if (ruleType === "ma_cross") {
    const period = Math.trunc(Number(input.period));
    if (!Number.isInteger(period) || period < 2 || period > 250) return badRequest("均线周期必须是 2 到 250 之间的整数");
    payload.period = period;
    payload.direction = input.direction === "break_below" ? "break_below" : "break_above";
  } else {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return badRequest("阈值必须是正数");
    payload.operator = input.operator === "<=" ? "<=" : ">=";
    payload.value = value;
  }
  const remote = await sendConnectorRequest<{ rule: unknown }>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RULES_CREATE, payload);
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  return ok(remote.data);
}
