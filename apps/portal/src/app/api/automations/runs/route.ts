import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, PORTAL_TYPES, sanitizeAutomationRun } from "@/lib/automation-api";
import { automationRunsListQuerySchema } from "@/lib/automation-schemas";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationRunsListResult, AutomationTaskRun } from "@/lib/protocol";

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const parsed = automationRunsListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return badRequest("运行记录筛选参数错误", { issues: parsed.error.issues });
  const remote = await forwardAutomation<AutomationRunsListResult>(session, PORTAL_TYPES.AUTOMATION_RUNS_LIST, parsed.data);
  return automationResponse(remote, (data) => ({
    items: data.items.map((run) => sanitizeAutomationRun(run as AutomationTaskRun & Record<string, unknown>)),
    ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
  }));
}
