import { getCurrentSession } from "@/lib/auth";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import {
  PORTAL_TYPES,
  type ArtifactGetResult
} from "@/lib/protocol";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";
import { parseWorkbookPreview } from "@/lib/workbook-preview";
import { isXlsxFile } from "@/lib/xlsx";

type Params = { params: { artifactId: string } };

/**
 * Returns a descriptor + base64 payload for an artifact. The runtime enforces
 * user/instance scope and sanitizes SVG before returning; we map connector
 * error codes to stable HTTP status codes so the client can render
 * not-found / forbidden / unsupported / expired / deleted states cleanly.
 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const artifactId = params.artifactId?.trim();
  if (!artifactId) return badRequest("缺少 artifactId");

  const remote = await sendConnectorRequest<ArtifactGetResult>(
    session.assistantId,
    PORTAL_TYPES.ARTIFACT_GET,
    {
      userId: session.sub,
      instanceId: session.instanceId,
      artifactId
    }
  );
  if (!remote.ok) {
    return fail(remote.code, remote.message, {
      status: statusForCode(remote.code),
      retryable: remote.retryable,
      details: remote.details
    });
  }

  const data = remote.data;
  let workbook;
  let workbookPreviewError;
  if (isXlsxFile(data.fileName, data.mimeType)) {
    try {
      workbook = await parseWorkbookPreview(Buffer.from(data.base64, "base64"));
    } catch (error) {
      workbookPreviewError = error instanceof Error && error.message === "Excel 文件超过预览大小限制"
        ? error.message
        : "Excel 工作簿无法读取";
    }
  }
  return ok({
    artifactId: data.artifactId,
    title: data.title,
    fileName: data.fileName,
    mimeType: data.mimeType,
    sizeBytes: data.sizeBytes,
    kind: data.kind,
    previewMode: data.previewMode,
    createdAt: data.createdAt,
    checksum: data.checksum,
    sanitized: data.sanitized,
    base64: data.base64,
    workbook,
    workbookPreviewError
  });
}
