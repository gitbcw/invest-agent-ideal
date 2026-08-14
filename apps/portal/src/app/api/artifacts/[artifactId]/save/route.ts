import { getCurrentSession } from "@/lib/auth";
import { assetResponse, PORTAL_TYPES, sanitizeAsset } from "@/lib/asset-api";
import { badRequest, unauthorized } from "@/lib/http";
import { sendConnectorRequest } from "@/lib/relay/server";
import type { UserAsset } from "@/lib/protocol";

export async function POST(request: Request, { params }: { params: { artifactId: string } }) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: { name?: string } = {};
  try { body = await request.json() as { name?: string }; } catch { return badRequest("请求格式错误"); }
  const remote = await sendConnectorRequest<UserAsset>(session.assistantId, PORTAL_TYPES.ASSET_CONVERSATION_SAVE, {
    artifactId: params.artifactId,
    name: body.name,
    idempotencyKey: `portal:conversation-save:${params.artifactId}`,
  });
  return assetResponse(remote, (data) => sanitizeAsset(data as UserAsset & Record<string, unknown>));
}
