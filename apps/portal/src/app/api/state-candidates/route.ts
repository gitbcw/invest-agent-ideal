import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";
import { z } from "zod";

/** 待审阅候选列表（draft）；?includeHistory=true 含已批准/拒绝历史。 */
export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const includeHistory = new URL(request.url).searchParams.get("includeHistory") === "true";
  const remote = await forwardWorkspace<{
    items: Array<{
      objectId: string;
      kind: "lesson" | "workflow";
      title: string;
      status: string;
      surface: "conversation" | "task";
      versionId: string;
      content: Record<string, unknown>;
      previouslyRejected: boolean;
      createdAt: string;
      updatedAt: string;
    }>;
  }>(session, PORTAL_TYPES.STATE_CANDIDATES_LIST, { includeHistory });
  return workspaceResponse(remote);
}

const approveSchema = z
  .object({
    action: z.literal("approve"),
    objectId: z.string().min(1),
    kind: z.enum(["lesson", "workflow"]),
    versionId: z.string().min(1),
  })
  .strict();

const rejectSchema = z
  .object({
    action: z.literal("reject"),
    objectId: z.string().min(1),
    kind: z.enum(["lesson", "workflow"]),
    reason: z.string().max(500).optional(),
  })
  .strict();

/** 批准（唯一生效口，经 portal 凭证消耗）或拒绝（终态，无新事实不重复打扰）。 */
export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("请求格式错误");
  }
  const parsed = z.union([approveSchema, rejectSchema]).safeParse(body);
  if (!parsed.success) return badRequest("候选参数错误", { issues: parsed.error.issues });
  const input = parsed.data;
  const remote = await forwardWorkspace<unknown>(
    session,
    input.action === "approve" ? PORTAL_TYPES.STATE_CANDIDATE_APPROVE : PORTAL_TYPES.STATE_CANDIDATE_REJECT,
    input.action === "approve"
      ? { objectId: input.objectId, kind: input.kind, versionId: input.versionId }
      : { objectId: input.objectId, kind: input.kind, reason: input.reason },
  );
  return workspaceResponse(remote);
}
