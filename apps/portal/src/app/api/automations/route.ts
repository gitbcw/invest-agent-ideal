import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, sanitizeAutomationTask, PORTAL_TYPES } from "@/lib/automation-api";
import { automationCreateSchema, automationListQuerySchema } from "@/lib/automation-schemas";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationListResult, AutomationTask } from "@/lib/protocol";

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const parsed = automationListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return badRequest("自动化筛选参数错误", { issues: parsed.error.issues });
  const remote = await forwardAutomation<AutomationListResult>(session, PORTAL_TYPES.AUTOMATION_LIST, parsed.data);
  return automationResponse(remote, (data) => ({
    items: data.items.map((task) => sanitizeAutomationTask(task as AutomationTask & Record<string, unknown>)),
    ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
  }));
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = automationCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest("自动化任务参数错误", { issues: parsed.error.issues });

  const remote = await forwardAutomation<AutomationTask>(session, PORTAL_TYPES.AUTOMATION_CREATE, parsed.data);
  return automationResponse(remote, (data) => sanitizeAutomationTask(data as AutomationTask & Record<string, unknown>));
}
