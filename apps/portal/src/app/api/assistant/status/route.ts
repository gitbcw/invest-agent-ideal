import { getGlobalRegistry } from "@/lib/relay/registry";
import { ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";

/**
 * 轻量状态接口:前端轮询 connector 是否在线。
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const registry = getGlobalRegistry();
  const all = registry.list();
  const connector = registry.getByAssistant(session.assistantId);
  console.log(
    `[api/assistant/status] assistant=${session.assistantId} allConnectors=${all.length} found=${connector?.connectorId ?? "none"}`
  );
  return ok({
    online: !!connector,
    mode: connector?.mode ?? null,
    status: connector?.status ?? "offline",
    lastHeartbeatAt: connector?.lastHeartbeatAt ?? null,
    capabilities: connector?.capabilities ?? [],
    displayName: connector?.displayName ?? null,
    version: connector?.version ?? null,
    startedAt: connector?.startedAt ?? null
  });
}
