import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, sanitizeAutomationRun, PORTAL_TYPES } from "@/lib/automation-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationTaskRun } from "@/lib/protocol";

type Params = { params: { runId: string } };

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const runId = params.runId?.trim();
  if (!runId) return badRequest("缺少 runId");
  const remote = await forwardAutomation<AutomationTaskRun>(session, PORTAL_TYPES.AUTOMATION_RUN_GET, { runId });
  return automationResponse(remote, (data) => sanitizeAutomationRun(data as AutomationTaskRun & Record<string, unknown>));
}
