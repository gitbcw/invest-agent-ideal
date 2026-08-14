import { getCurrentSession } from "@/lib/auth";
import { assetFolderCreateSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAssetFolder } from "@/lib/protocol";

export async function GET() {
  const session = await getCurrentSession(); if (!session) return unauthorized();
  const remote = await forwardAsset<{ items: UserAssetFolder[] }>(session, PORTAL_TYPES.ASSET_FOLDER_LIST, {});
  return assetResponse(remote);
}
export async function POST(request: Request) {
  const session = await getCurrentSession(); if (!session) return unauthorized();
  let body: unknown; try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetFolderCreateSchema.safeParse(body); if (!parsed.success) return badRequest("文件夹参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAssetFolder>(session, PORTAL_TYPES.ASSET_FOLDER_CREATE, parsed.data);
  return assetResponse(remote);
}
