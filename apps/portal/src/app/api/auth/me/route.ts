import { getGlobalRegistry } from "@/lib/relay/registry";
import { ok, unauthorized } from "@/lib/http";
import { getCurrentSession } from "@/lib/auth";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const registry = getGlobalRegistry();
  const connector = registry.getByAssistant(session.assistantId);
  return ok({
    user: {
      id: session.sub,
      username: session.username,
      role: session.role,
      displayName: session.username,
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      mustChangePassword: session.mustChangePassword
    },
    assistant: {
      assistantId: session.assistantId,
      instanceId: session.instanceId,
      online: !!connector,
      mode: connector?.mode,
      lastHeartbeatAt: connector?.lastHeartbeatAt
    }
  });
}
