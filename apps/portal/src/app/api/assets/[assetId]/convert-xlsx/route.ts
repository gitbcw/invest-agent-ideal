import { getCurrentSession } from "@/lib/auth";
import { assetConvertToXlsxSchema, assetIdSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAsset } from "@/lib/protocol";

export async function POST(request: Request, { params }: { params: { assetId: string } }) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少资产标识");
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetConvertToXlsxSchema.safeParse(body);
  if (!parsed.success) return badRequest("转换参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAsset>(session, PORTAL_TYPES.ASSET_CONVERT_TO_XLSX, { assetId: assetId.data, ...parsed.data });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
