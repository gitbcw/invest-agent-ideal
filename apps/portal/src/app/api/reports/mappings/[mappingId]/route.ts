import { getCurrentSession } from "@/lib/auth";
import { badRequest, unauthorized } from "@/lib/http";
import { PORTAL_TYPES } from "@/lib/protocol";
import { sendConnectorRequest } from "@/lib/relay/server";
import { ok } from "@/lib/http";

export async function GET(_request: Request, { params }: { params: { mappingId: string } }) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<{ fileName: string; mimeType: string; sizeBytes: number; base64: string }>(
    session.assistantId,
    PORTAL_TYPES.REPORT_MAPPING_GET,
    { mappingId: params.mappingId },
  );
  if (!remote.ok) return badRequest(remote.message, { code: remote.code });
  const bytes = Buffer.from(remote.data.base64, "base64");
  if (bytes.length !== remote.data.sizeBytes) return badRequest("报告文件内容校验失败");
  return ok({ versionId: params.mappingId, assetId: `report:${params.mappingId}`, versionNumber: 1, fileName: remote.data.fileName, format: formatForMime(remote.data.mimeType), mimeType: remote.data.mimeType, sizeBytes: bytes.length, checksum: "", source: "system", createdAt: new Date().toISOString(), base64: remote.data.base64 });
}

function formatForMime(mimeType: string): "markdown" | "html" | "csv" | "pdf" | "png" | "jpeg" | "webp" | "svg" {
  if (mimeType === "text/html") return "html";
  if (mimeType === "text/csv") return "csv";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpeg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  return "markdown";
}
