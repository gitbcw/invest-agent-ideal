import { getCurrentSession } from "@/lib/auth";
import { assetFolderRenameSchema, assetIdSchema } from "@/lib/asset-schemas";
import { assetResponse, forwardAsset, PORTAL_TYPES } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { UserAssetFolder } from "@/lib/protocol";

function parseFolderId(value: string) {
  return assetIdSchema.safeParse(value?.trim());
}

export async function PATCH(request: Request, { params }: { params: { folderId: string } }) {
  const session = await getCurrentSession(); if (!session) return unauthorized();
  const folderId = parseFolderId(params.folderId); if (!folderId.success) return badRequest("缺少 folderId");
  let body: unknown; try { body = await request.json(); } catch { return badRequest("请求格式错误"); }
  const parsed = assetFolderRenameSchema.safeParse(body); if (!parsed.success) return badRequest("文件夹参数错误", { issues: parsed.error.issues });
  const remote = await forwardAsset<UserAssetFolder>(session, PORTAL_TYPES.ASSET_FOLDER_RENAME, { folderId: folderId.data, name: parsed.data.name });
  return assetResponse(remote);
}

export async function DELETE(_request: Request, { params }: { params: { folderId: string } }) {
  const session = await getCurrentSession(); if (!session) return unauthorized();
  const folderId = parseFolderId(params.folderId); if (!folderId.success) return badRequest("缺少 folderId");
  const remote = await forwardAsset<{ folderId: string }>(session, PORTAL_TYPES.ASSET_FOLDER_DELETE, { folderId: folderId.data });
  return assetResponse(remote);
}
