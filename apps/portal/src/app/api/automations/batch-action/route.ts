import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, PORTAL_TYPES, sanitizeAutomationTask } from "@/lib/automation-api";
import { automationBatchActionSchema } from "@/lib/automation-schemas";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationBatchActionResult, AutomationTask } from "@/lib/protocol";

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = automationBatchActionSchema.safeParse(body);
  if (!parsed.success) return badRequest("批量操作参数错误", { issues: parsed.error.issues });
  const remote = await forwardAutomation<AutomationBatchActionResult>(session, PORTAL_TYPES.AUTOMATION_BATCH_ACTION, parsed.data);
  return automationResponse(remote, (data) => ({
    correlationId: data.correlationId,
    results: data.results.map((item) => item.ok
      ? { ...item, task: sanitizeAutomationTask(item.task as AutomationTask & Record<string, unknown>) }
      : item),
  }));
}
