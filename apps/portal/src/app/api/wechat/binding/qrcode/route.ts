import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";

export async function POST() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  const runtimeBase = process.env.PORTAL_RUNTIME_URL ?? "http://127.0.0.1:23656";
  const token = process.env.PORTAL_RUNTIME_API_TOKEN?.trim() || undefined;
  try {
    const res = await fetch(`${runtimeBase}/api/wechat/binding/qrcode?instanceId=${encodeURIComponent(session.instanceId)}`, {
      method: "POST",
      cache: "no-store",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) return Response.json({ ok: false, error: data?.error ?? `runtime ${res.status}` }, { status: 502 });
    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: `runtime unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}
