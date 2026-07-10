import { randomBytes } from "node:crypto";

export const PLATFORM_SESSION_COOKIE = "invest_agent_platform_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, number>();

function pruneExpiredSessions(now = Date.now()) {
  for (const [id, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(id);
  }
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined;
  return cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function createPlatformSession() {
  pruneExpiredSessions();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(id, expiresAt);
  return { id, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

export function hasPlatformSession(cookieHeader: string | undefined) {
  pruneExpiredSessions();
  const id = cookieValue(cookieHeader, PLATFORM_SESSION_COOKIE);
  return Boolean(id && (sessions.get(id) || 0) > Date.now());
}

export function platformSessionCookie(id: string, maxAgeSeconds: number) {
  return `${PLATFORM_SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function isLoopbackAddress(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
