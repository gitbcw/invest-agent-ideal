import { getCurrentSession } from "@/lib/auth";
import { assetIdSchema, assetRenameSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAsset } from "@/lib/protocol";

type Params = { params: { assetId: string } };

export async function GET(_request: Request, { params }: Params) {
  return handle(params, "get");
}

export async function PATCH(request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetRenameSchema.safeParse(body);
  if (!parsed.success) return badRequest("重命名参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAsset>(session, PORTAL_TYPES.ASSET_RENAME, { assetId: assetId.data, name: parsed.data.name });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}

export async function DELETE(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  const remote = await forwardAsset<{ assetId: string; deletedVersions: number }>(session, PORTAL_TYPES.ASSET_DELETE, { assetId: assetId.data });
  return assetResponse(remote);
}

async function handle(params: { assetId: string }, mode: "get") {
  void mode;
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = assetIdSchema.safeParse(params.assetId?.trim());
  if (!assetId.success) return badRequest("缺少 assetId");
  const remote = await forwardAsset<UserAsset>(session, PORTAL_TYPES.ASSET_GET, { assetId: assetId.data });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
