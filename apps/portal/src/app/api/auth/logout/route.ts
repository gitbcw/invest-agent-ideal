import { openDatabase } from "@/lib/db";
import { AuditRepository } from "@/lib/db/users";
import { ok, getIp, getUserAgent } from "@/lib/http";
import { clearSessionCookie, getCurrentSession } from "@/lib/auth";

export async function POST(request: Request) {
  const session = await getCurrentSession();
  if (session) {
    const db = openDatabase();
    const audit = new AuditRepository(db);
    audit.recordAuthEvent({
      userId: session.sub,
      username: session.username,
      event: "logout",
      ip: getIp(request as never),
      userAgent: getUserAgent(request as never)
    });
  }
  await clearSessionCookie();
  return ok({ loggedOut: true });
}

/**
 * GET /api/auth/logout 也可以直接登出(便于调试)。
 */
export async function GET(request: Request) {
  return POST(request);
}
