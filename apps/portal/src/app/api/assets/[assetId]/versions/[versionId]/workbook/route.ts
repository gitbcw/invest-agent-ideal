import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema } from "@/lib/asset-schemas";
import { forwardAsset, PORTAL_TYPES } from "@/lib/asset-api";
import { badRequest, fail, ok, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import type { UserAssetVersionPayload } from "@/lib/protocol";
import { parseWorkbookPreview } from "@/lib/workbook-preview";

export async function GET(_request: Request, { params }: { params: { assetId: string; versionId: string } }) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  const versionId = assetIdSchema.safeParse(params.versionId?.trim());
  if (!assetId.success || !versionId.success) return badRequest("缺少资产版本标识");
  const remote = await forwardAsset<UserAssetVersionPayload>(session, PORTAL_TYPES.ASSET_VERSION_GET, { assetId: assetId.data, versionId: versionId.data });
  if (!remote.ok) return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  if (remote.data.format !== "xlsx" && !remote.data.fileName.toLowerCase().endsWith(".xlsx")) return fail("ASSET_UNSUPPORTED_FORMAT", "该版本不是 Excel 工作簿", { status: 415 });
  try {
    return ok(await parseWorkbookPreview(Buffer.from(remote.data.base64, "base64")));
  } catch (error) {
    return fail("ASSET_INVALID_CONTENT", error instanceof Error ? error.message : "Excel 工作簿无法读取", { status: 422 });
  }
}
