import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeReferences } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAssetReferencesResult } from "@/lib/protocol";

type Params = { params: { assetId: string } };

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  const remote = await forwardAsset<UserAssetReferencesResult>(session, PORTAL_TYPES.ASSET_REFERENCES_LIST, { assetId: assetId.data });
  return assetResponse(remote, sanitizeReferences);
}
