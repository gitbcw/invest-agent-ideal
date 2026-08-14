import { getCurrentSession } from "@/lib/auth";
import { assetListQuerySchema, assetUploadSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAsset, UserAssetListResult } from "@/lib/protocol";

export async function GET(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const parsed = assetListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return badRequest("产物筛选参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAssetListResult>(session, PORTAL_TYPES.ASSET_LIST, parsed.data);
  return assetResponse(remote, (data) => ({
    items: data.items.map((item) => sanitizeAsset(item as UserAsset & Record<string, unknown>)),
    catalog: data.catalog?.map((item) => ({
      ...sanitizeAsset(item as unknown as UserAsset & Record<string, unknown>),
      catalogId: item.catalogId,
      catalogKind: item.catalogKind,
      sources: item.sources,
      reportMappingId: item.reportMappingId,
      reportId: item.reportId,
    })),
    reportMappings: data.reportMappings,
    storageUsage: data.storageUsage,
    folders: data.folders,
  }));
}

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetUploadSchema.safeParse(body);
  if (!parsed.success) return badRequest("产物上传参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAsset | { items: Array<{ index: number; fileName: string; ok: boolean; asset?: UserAsset; error?: unknown }> }>(session, PORTAL_TYPES.ASSET_UPLOAD, parsed.data);
  return assetResponse(remote, (data) => "items" in data
    ? { items: data.items.map((item) => item.ok && item.asset ? { ...item, asset: sanitizeAsset(item.asset as UserAsset & Record<string, unknown>) } : item) }
    : sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
