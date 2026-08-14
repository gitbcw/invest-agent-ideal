import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAsset } from "@/lib/protocol";

type Params = { params: { assetId: string } };

export async function POST(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  const remote = await forwardAsset<UserAsset>(session, PORTAL_TYPES.ASSET_ARCHIVE, { assetId: assetId.data });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
