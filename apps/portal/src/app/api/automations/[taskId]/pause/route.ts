import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, sanitizeAutomationTask, PORTAL_TYPES } from "@/lib/automation-api";
import { automationActionSchema } from "@/lib/automation-schemas";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationTask } from "@/lib/protocol";

type Params = { params: { taskId: string } };

export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const taskId = params.taskId?.trim();
  if (!taskId) return badRequest("缺少 taskId");
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return badRequest("请求格式错误");
  }
  const raw = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (raw.taskId !== undefined && raw.taskId !== taskId) return badRequest("taskId 与路径不一致");
  const parsed = automationActionSchema.safeParse({ ...raw, taskId });
  if (!parsed.success) return badRequest("自动化任务参数错误", { issues: parsed.error.issues });
  const remote = await forwardAutomation<AutomationTask>(session, PORTAL_TYPES.AUTOMATION_PAUSE, { taskId, expectedRevision: parsed.data.expectedRevision });
  return automationResponse(remote, (data) => sanitizeAutomationTask(data as AutomationTask & Record<string, unknown>));
}
