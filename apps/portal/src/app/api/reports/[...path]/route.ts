import { getCurrentSession } from "@/lib/auth";
import { badRequest, notFound, unauthorized } from "@/lib/http";
import { PORTAL_TYPES, type ReportAssetGetResult } from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";

type Params = { params: { path: string[] } };

/**
 * Reports are surfaced only as forced downloads. Inline rendering of SVG/HTML
 * from runtime workspaces via this same-origin route is intentionally removed
 * — previewable artifacts must go through the descriptor-gated /api/artifacts/*
 * flow so the runtime can sanitize SVG and enforce scope.
 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const relativePath = `reports/${params.path.join("/")}`;
  const remote = await sendConnectorRequest<ReportAssetGetResult>(
    session.assistantId,
    PORTAL_TYPES.REPORT_ASSET_GET,
    { relativePath },
  );
  if (!remote.ok) {
    if (remote.code === "REPORT_ASSET_NOT_FOUND") return notFound("报告文件不存在或已过期");
    return badRequest("无法读取该报告文件", { code: remote.code });
  }
  const bytes = Buffer.from(remote.data.base64, "base64");
  if (bytes.length !== remote.data.sizeBytes) return badRequest("报告文件内容校验失败");
  const fileName = encodeURIComponent(remote.data.fileName);
  return new Response(bytes, {
    headers: {
      "content-type": remote.data.mimeType,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename*=UTF-8''${fileName}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
