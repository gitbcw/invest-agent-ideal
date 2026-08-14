import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeVersionPayload } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAssetVersionPayload } from "@/lib/protocol";

type Params = { params: { assetId: string; versionId: string } };

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  const versionId = assetIdSchema.safeParse(params.versionId?.trim());
  if (!assetId.success || !versionId.success) return badRequest("缺少资产版本标识");
  const remote = await forwardAsset<UserAssetVersionPayload>(session, PORTAL_TYPES.ASSET_VERSION_GET, { assetId: assetId.data, versionId: versionId.data });
  return assetResponse(remote, (data) => sanitizeVersionPayload(data as UserAssetVersionPayload & Record<string, unknown>));
}
