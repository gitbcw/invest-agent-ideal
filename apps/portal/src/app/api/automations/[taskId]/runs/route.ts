import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, sanitizeAutomationRun, PORTAL_TYPES } from "@/lib/automation-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationRunsListResult, AutomationTaskRun } from "@/lib/protocol";

type Params = { params: { taskId: string } };

export async function GET(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const taskId = params.taskId?.trim();
  if (!taskId) return badRequest("缺少 taskId");
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return badRequest("limit 参数无效");
  const remote = await forwardAutomation<AutomationRunsListResult>(session, PORTAL_TYPES.AUTOMATION_RUNS_LIST, { taskId, ...(limit === undefined ? {} : { limit }) });
  return automationResponse(remote, (data) => ({
    items: data.items.map((run) => sanitizeAutomationRun(run as AutomationTaskRun & Record<string, unknown>)),
  }));
}
