import { getCurrentSession } from "@/lib/auth";
import { unauthorized } from "@/lib/http";

async function forward(session: { instanceId: string }, method: "GET" | "DELETE") {
  const runtimeBase = process.env.PORTAL_RUNTIME_URL ?? "http://127.0.0.1:23656";
  const token = process.env.PORTAL_RUNTIME_API_TOKEN?.trim() || undefined;
  const res = await fetch(`${runtimeBase}/api/wechat/binding?instanceId=${encodeURIComponent(session.instanceId)}`, {
    method,
    cache: "no-store",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) return Response.json({ ok: false, error: data?.error ?? `runtime ${res.status}` }, { status: 502 });
  return Response.json({ ok: true, data });
}

export async function GET() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  try {
    return await forward(session, "GET");
  } catch (error) {
    return Response.json({ ok: false, error: `runtime unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}

export async function DELETE() {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  try {
    return await forward(session, "DELETE");
  } catch (error) {
    return Response.json({ ok: false, error: `runtime unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}
