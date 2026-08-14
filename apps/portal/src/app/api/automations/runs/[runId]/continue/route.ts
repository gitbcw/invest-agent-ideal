import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, sanitizeAutomationRun, sanitizeAutomationTask, PORTAL_TYPES } from "@/lib/automation-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationContinueInChatResult, AutomationTask, AutomationTaskRun } from "@/lib/protocol";

type Params = { params: { runId: string } };

export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const runId = params.runId?.trim();
  if (!runId) return badRequest("缺少 runId");
  const remote = await forwardAutomation<AutomationContinueInChatResult>(session, PORTAL_TYPES.AUTOMATION_CONTINUE_IN_CHAT, { runId });
  return automationResponse(remote, (data) => ({
    ...data,
    run: sanitizeAutomationRun(data.run as AutomationTaskRun & Record<string, unknown>),
    task: sanitizeAutomationTask(data.task as AutomationTask & Record<string, unknown>),
  }));
}
