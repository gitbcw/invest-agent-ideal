import { readFileSync } from "node:fs";
import path from "node:path";
import { getCurrentSession } from "@/lib/auth";
import { unauthorized, badRequest } from "@/lib/http";

/** Candidate topology: the runtime's local service token (env override first). */
function runtimeServiceToken(): string | undefined {
  const fromEnv = process.env.PORTAL_RUNTIME_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    // Candidate stack: run-mastra-local.sh points the token file at the
    // isolated state root (data/mastra-portal-local/runtime).
    path.resolve(process.cwd(), "../../data/mastra-portal-local/runtime/.service-api-token"),
    path.resolve(process.cwd(), "../../data/.service-api-token"),
  ];
  for (const file of candidates) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch { /* try next */ }
  }
  return undefined;
}

/**
 * O1 onboarding wizard completion. Forwards to the runtime's local
 * wizard/complete endpoint (same-machine candidate topology; the connector
 * envelope path lands with the B2 protocol extension).
 */
export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (!session) return unauthorized();
  let body: { userId?: string; projectId?: string; instanceId?: string; strategyPackId?: string; portfolioText?: string } = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  if (body.userId && body.userId !== session.username) return badRequest("userId 不匹配当前会话");
  const runtimeBase = process.env.PORTAL_RUNTIME_URL ?? "http://127.0.0.1:23656";
  const token = runtimeServiceToken();
  try {
    const res = await fetch(`${runtimeBase}/api/onboarding/wizard/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ userId: session.username, projectId: body.projectId, instanceId: body.instanceId, strategyPackId: body.strategyPackId, portfolioText: body.portfolioText }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      return Response.json({ ok: false, error: data?.error ?? `runtime ${res.status}` }, { status: 502 });
    }
    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: `runtime unreachable: ${(error as Error).message}` }, { status: 502 });
  }
}
