import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";

/**
 * 初始化状态查询（2026-10-08 冷启动引导闭环）：转发 runtime 的
 * wizard/status 端点；按 instanceId 反查 owner，镜像等 username !=
 * runtime userId 的部署不会错位。
 */
export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const runtimeBase = process.env.PORTAL_RUNTIME_URL ?? "http://127.0.0.1:23656";
  const token = process.env.PORTAL_RUNTIME_API_TOKEN?.trim() || undefined;
  try {
    const res = await fetch(
      `${runtimeBase}/api/onboarding/wizard/status?instanceId=${encodeURIComponent(session.instanceId)}`,
      { cache: "no-store", headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return Response.json({ ok: false, error: data?.error ?? `runtime ${res.status}` }, { status: 502 });
    }
    return Response.json({ ok: true, data: { needsOnboarding: Boolean(data.needsOnboarding), state: data.state ?? null } });
  } catch (error) {
    return Response.json({ ok: false, error: `runtime unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}
