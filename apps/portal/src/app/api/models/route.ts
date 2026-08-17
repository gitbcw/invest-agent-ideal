import { getCurrentSession } from "@/lib/auth";
import { PORTAL_TYPES } from "@/lib/protocol";
import { ok, fail, unauthorized } from "@/lib/http";
import { statusForCode } from "@/lib/protocol/error-status";
import { sendConnectorRequest } from "@/lib/relay/server";

export interface ModelsStateOption {
  model: string;
  description: string;
  inputPrice: number | null;
  outputPrice: number | null;
  timeTiered: { peak: { input: number; output: number }; offPeak: { input: number; output: number } } | null;
}

export interface ModelsStatePayload {
  auto: { textModel: string; imageModel: string };
  chain: Array<Record<string, unknown>>;
  thresholds: Record<string, number>;
  options: ModelsStateOption[];
}

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const remote = await sendConnectorRequest<ModelsStatePayload>(session.assistantId, PORTAL_TYPES.MODELS_STATE, {});
  if (!remote.ok) {
    return fail(remote.code, remote.message, { status: statusForCode(remote.code), retryable: remote.retryable, details: remote.details });
  }
  return ok(remote.data);
}
