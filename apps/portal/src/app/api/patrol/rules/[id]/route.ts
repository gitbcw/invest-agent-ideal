import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { id: string } };

export async function PATCH(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("规则 id 无效");
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const input = body as { stockName?: string; operator?: string; value?: number; period?: number; direction?: string; enabled?: boolean; priority?: string };
  const payload: Record<string, unknown> = {};
  if (typeof input.stockName === "string" && input.stockName.trim()) payload.stockName = input.stockName.trim();
  if (input.operator === ">=" || input.operator === "<=") {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return badRequest("阈值必须是正数");
    payload.operator = input.operator;
    payload.value = value;
  }
  if (input.period !== undefined || input.direction !== undefined) {
    const period = Math.trunc(Number(input.period));
    if (!Number.isInteger(period) || period < 2 || period > 250) return badRequest("均线周期必须是 2 到 250 之间的整数");
    payload.period = period;
    payload.direction = input.direction === "break_below" ? "break_below" : "break_above";
  }
  if (input.enabled === true || input.enabled === false) payload.enabled = input.enabled;
  if (input.priority === "P0" || input.priority === "P1" || input.priority === "P2") payload.priority = input.priority;
  if (Object.keys(payload).length === 0) return badRequest("没有可更新的字段");
  const remote = await sendConnectorRequest<{ rule: unknown }>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RULES_UPDATE, { id, ...payload });
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  return ok(remote.data);
}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("规则 id 无效");
  const remote = await sendConnectorRequest<{ removed: boolean }>(session.assistantId, PORTAL_TYPES.RULE_PATROL_RULES_DELETE, { id });
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  return ok(remote.data);
}
