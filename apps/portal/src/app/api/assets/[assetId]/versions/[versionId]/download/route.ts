import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema } from "@/lib/asset-schemas";
import { forwardAsset, PORTAL_TYPES } from "@/lib/asset-api";
import { badRequest, fail, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import type { UserAssetVersionPayload } from "@/lib/protocol";

type Params = { params: { assetId: string; versionId: string } };

/**
 * Click-to-open target for asset links rendered inside chat messages: streams
 * the stored version bytes with the original file name. Same-origin relative
 * URL, so the browser sends the Portal session cookie automatically.
 */
export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  const versionId = assetIdSchema.safeParse(params.versionId?.trim());
  if (!assetId.success || !versionId.success) return badRequest("缺少资产版本标识");
  const remote = await forwardAsset<UserAssetVersionPayload>(session, PORTAL_TYPES.ASSET_VERSION_GET, {
    assetId: assetId.data,
    versionId: versionId.data,
  });
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  const bytes = Buffer.from(remote.data.base64, "base64");
  // Header-safe file name: keep CJK and common word characters, drop control
  // and separator characters that could break or inject the disposition header.
  const fileName = (remote.data.fileName || "asset").replace(/[\r\n"\\/]+/g, "_").slice(0, 200) || "asset";
  const asciiFallback = fileName.replace(/[^\x20-\x7e]+/g, "_") || "asset";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": remote.data.mimeType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
