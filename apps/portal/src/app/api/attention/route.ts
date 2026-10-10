import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";
import { forwardWorkspace, workspaceResponse, PORTAL_TYPES } from "@/lib/workspace-api";

interface AttentionItemApiView {
  itemId: string;
  kind: string;
  taskId: string | null;
  runId: string | null;
  title: string;
  impactSummary: string;
  systemStatus: string;
  errorCategory: string | null;
  status: string;
  failureCount: number;
  wechatNotified: boolean;
  firstFailedAt: string;
  lastFailedAt: string;
  resolvedAt: string | null;
  resolvedRunId: string | null;
}

/** 全局待处理（首版仅失败告知）：open 列表 + 未处理计数；?status=resolved 查收口历史；limit 控制条数（分页/加载更多）。 */
export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const search = new URL(request.url).searchParams;
  const status = search.get("status") === "resolved" ? "resolved" : "open";
  const rawLimit = Number(search.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : undefined;
  const remote = await forwardWorkspace<{ status: string; items: AttentionItemApiView[]; openCount: number }>(
    session,
    PORTAL_TYPES.ATTENTION_LIST,
    { status, ...(limit ? { limit } : {}) },
  );
  return workspaceResponse(remote);
}
