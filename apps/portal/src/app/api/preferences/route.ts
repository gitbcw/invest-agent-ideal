import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { z } from "zod";

const preferencePatchSchema = z
  .object({
    wechatFailureEnabled: z.boolean().optional(),
    wechatRecoveryEnabled: z.boolean().optional(),
    quietHoursStart: z.string().regex(/^[0-2]\d:[0-5]\d$/, "时间格式 HH:mm").nullable().optional(),
    quietHoursEnd: z.string().regex(/^[0-2]\d:[0-5]\d$/, "时间格式 HH:mm").nullable().optional(),
    categories: z.array(z.enum(["failure", "recovery"])).nullable().optional(),
    defaultDeliveryMode: z.enum(["wechat", "none"]).optional(),
  })
  .strict();

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.PREFERENCE_GET, {});
  return workspaceResponse(remote);
}

/** 偏好只影响提醒投递：不改变事项事实、任务状态、运行或授权。 */
export async function PUT(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = preferencePatchSchema.safeParse(body);
  if (!parsed.success) return badRequest("偏好参数错误", { issues: parsed.error.issues });
  const remote = await forwardWorkspace<unknown>(session, PORTAL_TYPES.PREFERENCE_SET, parsed.data);
  return workspaceResponse(remote);
}
