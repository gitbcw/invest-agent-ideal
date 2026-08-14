import { ok } from "@/lib/http";
import { getConfig, portalTimeoutSummary } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getConfig();
  return ok({
    status: "ok",
    service: "invest-agent-portal",
    timestamp: new Date().toISOString(),
    timeouts: portalTimeoutSummary(config)
  });
}
