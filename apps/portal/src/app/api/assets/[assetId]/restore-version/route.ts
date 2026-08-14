import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema, assetRestoreSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAsset } from "@/lib/protocol";

type Params = { params: { assetId: string } };

export async function POST(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetRestoreSchema.safeParse(body);
  if (!parsed.success) return badRequest("恢复版本参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAsset>(session, PORTAL_TYPES.ASSET_RESTORE_VERSION, { assetId: assetId.data, ...parsed.data });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
