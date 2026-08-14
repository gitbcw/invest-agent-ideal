import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";

/**
 * Edge-safe session utilities。
 *
 * 不引入任何 `node:*` 模块,且不依赖 getConfig,以便 middleware 能直接 import。
 * 全部直接读 process.env。
 */

const ISSUER = "invest-agent-portal";
const AUDIENCE = "portal-user";
const DEV_JWT_SECRET = "dev-secret-change-me-please-32-chars-min";

export interface SessionPayload {
  sub: string;
  username: string;
  role: "user" | "admin";
  assistantId: string;
  instanceId: string;
  mustChangePassword: boolean;
}

function readSecret(): string {
  const production = process.env.NODE_ENV === "production" && process.env.PORTAL_DEV !== "1";
  const secret = process.env.PORTAL_JWT_SECRET ?? (production ? "" : DEV_JWT_SECRET);
  if (!secret || secret.length < 16) {
    throw new Error("PORTAL_JWT_SECRET 必须至少 16 个字符");
  }
  if (production && secret === DEV_JWT_SECRET) {
    throw new Error("生产环境不能使用默认 PORTAL_JWT_SECRET");
  }
  return secret;
}

function readCookieName(): string {
  return process.env.PORTAL_COOKIE_NAME ?? "portal_session";
}

function readSessionTtlSec(): number {
  const raw = process.env.PORTAL_SESSION_TTL_SEC;
  if (!raw) return 60 * 60 * 24 * 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 60 * 60 * 24 * 30;
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(readSecret());
}

function isDev(): boolean {
  return process.env.PORTAL_DEV === "1" || process.env.NODE_ENV !== "production";
}

function readCookieSecure(): boolean {
  const raw = process.env.PORTAL_COOKIE_SECURE;
  if (raw !== undefined) {
    return raw === "1" || raw.toLowerCase() === "true";
  }
  return !isDev();
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(payload.sub)
    .setExpirationTime(`${readSessionTtlSec()}sec`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE
    });
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(readCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: readCookieSecure(),
    path: "/",
    maxAge: readSessionTtlSec()
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(readCookieName());
}

export async function getCurrentSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(readCookieName())?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/**
 * 供 middleware 在请求边同步读取(Edge runtime 兼容)。
 */
export async function readSessionFromRequest(
  token: string | undefined
): Promise<SessionPayload | null> {
  if (!token) return null;
  return verifySessionToken(token);
}
