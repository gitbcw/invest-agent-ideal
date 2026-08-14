import { getCurrentSession } from "@/lib/auth";
import { automationResponse, forwardAutomation, PORTAL_TYPES, sanitizeAutomationAsset } from "@/lib/automation-api";
import { badRequest, unauthorized } from "@/lib/http";
import type { AutomationAssetGetResult } from "@/lib/protocol";

type Params = { params: { assetId: string } };

export async function GET(_request: Request, { params }: Params) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const assetId = params.assetId?.trim();
  if (!assetId) return badRequest("缺少 assetId");
  const remote = await forwardAutomation<AutomationAssetGetResult>(session, PORTAL_TYPES.AUTOMATION_ASSET_GET, { assetId });
  return automationResponse(remote, (data) => ({
    ...sanitizeAutomationAsset(data as AutomationAssetGetResult & Record<string, unknown>),
    base64: data.base64,
  }));
}
