import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  platformAdminAuditLogs,
  platformLoginEvents,
  platformRoles,
  platformSessions,
  platformUserRoles,
  platformUsers,
} from "../db/schema.js";
import { hasServiceApiAuthorization } from "./service-auth.js";
import { hasPlatformSession } from "./platform-session.js";
import { hashPlatformPassword, verifyPlatformPassword } from "./platform-password.js";

export const PLATFORM_AUTH_COOKIE = "invest_agent_platform_auth";
export const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export type PlatformRole = "owner" | "partner";
export type PlatformPermission =
  | "overview.read"
  | "customers.read"
  | "quality.read"
  | "operations.read"
  | "customers.sensitive.read"
  | "conversations.raw.read"
  | "cost.read"
  | "admin_audit.read"
  | "instances.create"
  | "instances.archive"
  | "instances.reset_test"
  | "weixin.connect"
  | "weixin.disconnect"
  | "weixin.test_push"
  | "portal.credential.issue"
  | "access.manage";

export interface PlatformAuthContext {
  userId: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  permissions: string[];
  mustChangePassword: boolean;
  sessionId?: string;
  authType: "account" | "service_token" | "legacy_local";
}

function cookieValue(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined;
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(name + "="))
    ?.slice(name.length + 1);
}

function userAgent(request: any) {
  const value = request?.headers?.["user-agent"];
  return Array.isArray(value) ? value[0] : value || null;
}

function requestIp(request: any) {
  return typeof request?.ip === "string" ? request.ip : null;
}

function parseRole(value: string | null | undefined): PlatformRole {
  return value === "partner" ? "partner" : "owner";
}

function rolePermissions(role: PlatformRole, raw: string | null | undefined) {
  if (role === "owner") return ["*"];
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function accountContext(row: any, authType: "account" | "service_token" | "legacy_local", sessionId?: string): PlatformAuthContext {
  const role = parseRole(row.roleId || row.roleName);
  return {
    userId: row.userId,
    username: row.username || row.userId,
    displayName: row.displayName || row.username || row.userId,
    role,
    permissions: rolePermissions(role, row.permissionsJson),
    mustChangePassword: Boolean(row.mustChangePassword),
    ...(sessionId ? { sessionId } : {}),
    authType,
  };
}

function serviceContext(): PlatformAuthContext {
  return {
    userId: "service-token",
    username: "service-token",
    displayName: "Service Token",
    role: "owner",
    permissions: ["*"],
    mustChangePassword: false,
    authType: "service_token",
  };
}

function legacyLocalContext(): PlatformAuthContext {
  return {
    userId: "legacy-local",
    username: "legacy-local",
    displayName: "Legacy Local Platform",
    role: "owner",
    permissions: ["*"],
    mustChangePassword: false,
    authType: "legacy_local",
  };
}

async function findSessionContext(sessionId: string) {
  const now = new Date().toISOString();
  const rows = await db
    .select({
      sessionId: platformSessions.id,
      userId: platformUsers.id,
      username: platformUsers.username,
      displayName: platformUsers.displayName,
      mustChangePassword: platformUsers.mustChangePassword,
      roleId: platformRoles.id,
      roleName: platformRoles.name,
      permissionsJson: platformRoles.permissionsJson,
    })
    .from(platformSessions)
    .innerJoin(platformUsers, eq(platformUsers.id, platformSessions.platformUserId))
    .innerJoin(platformUserRoles, eq(platformUserRoles.platformUserId, platformUsers.id))
    .innerJoin(platformRoles, eq(platformRoles.id, platformUserRoles.roleId))
    .where(and(
      eq(platformSessions.id, sessionId),
      isNull(platformSessions.revokedAt),
      gt(platformSessions.expiresAt, now),
      eq(platformUsers.status, "active"),
    ))
    .orderBy(desc(platformRoles.id))
    .limit(8);
  const row = rows.find((item) => item.roleId === "owner") || rows[0];
  if (!row) return null;
  await db
    .update(platformSessions)
    .set({ lastSeenAt: now })
    .where(eq(platformSessions.id, sessionId));
  return accountContext(row, "account", sessionId);
}

export async function getPlatformAuthContext(request: any): Promise<PlatformAuthContext | null> {
  if (hasServiceApiAuthorization(request?.headers || {})) return serviceContext();
  const cookie = cookieValue(request?.headers?.cookie, PLATFORM_AUTH_COOKIE);
  if (cookie) {
    const context = await findSessionContext(cookie);
    if (context) return context;
  }
  if (hasPlatformSession(request?.headers?.cookie)) return legacyLocalContext();
  return null;
}

export async function hasPersistentPlatformSession(cookieHeader: string | undefined) {
  const cookie = cookieValue(cookieHeader, PLATFORM_AUTH_COOKIE);
  if (!cookie) return false;
  const now = new Date().toISOString();
  const row = await db
    .select({ id: platformSessions.id })
    .from(platformSessions)
    .innerJoin(platformUsers, eq(platformUsers.id, platformSessions.platformUserId))
    .where(and(
      eq(platformSessions.id, cookie),
      isNull(platformSessions.revokedAt),
      gt(platformSessions.expiresAt, now),
      eq(platformUsers.status, "active"),
    ))
    .limit(1);
  return Boolean(row[0]);
}

export function hasPlatformPermission(context: PlatformAuthContext | null, permission: PlatformPermission) {
  if (!context) return false;
  return context.permissions.includes("*") || context.permissions.includes(permission);
}

export function platformSessionCookie(sessionId: string) {
  const maxAge = Math.floor(PLATFORM_SESSION_TTL_MS / 1000);
  return PLATFORM_AUTH_COOKIE + "=" + sessionId + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge;
}

export function clearPlatformSessionCookie() {
  return PLATFORM_AUTH_COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

async function recordLoginEvent(input: {
  username: string;
  platformUserId?: string;
  result: string;
  reason?: string;
  request: any;
}) {
  await db.insert(platformLoginEvents).values({
    username: input.username,
    platformUserId: input.platformUserId,
    result: input.result,
    reason: input.reason,
    ipAddress: requestIp(input.request),
    userAgent: userAgent(input.request),
    createdAt: new Date().toISOString(),
  });
}

async function createSession(user: typeof platformUsers.$inferSelect, request: any, roleRow: any) {
  const now = new Date();
  const id = randomBytes(32).toString("base64url");
  await db.insert(platformSessions).values({
    id,
    platformUserId: user.id,
    expiresAt: new Date(now.getTime() + PLATFORM_SESSION_TTL_MS).toISOString(),
    lastSeenAt: now.toISOString(),
    ipAddress: requestIp(request),
    userAgent: userAgent(request),
    createdAt: now.toISOString(),
  });
  return {
    id,
    context: accountContext({
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      mustChangePassword: user.mustChangePassword,
      roleId: roleRow.roleId,
      roleName: roleRow.roleName,
      permissionsJson: roleRow.permissionsJson,
    }, "account", id),
  };
}

export async function authenticatePlatformUser(input: { username: string; password: string; request: any }) {
  const username = input.username.trim();
  const userRows = await db
    .select()
    .from(platformUsers)
    .where(eq(platformUsers.username, username))
    .limit(1);
  const user = userRows[0];
  if (!user) {
    await recordLoginEvent({ username, result: "failure", reason: "invalid_credentials", request: input.request });
    return { ok: false as const, error: "INVALID_CREDENTIALS" };
  }

  const now = new Date();
  if (user.status !== "active") {
    await recordLoginEvent({ username, platformUserId: user.id, result: "failure", reason: "account_disabled", request: input.request });
    return { ok: false as const, error: "ACCOUNT_DISABLED" };
  }
  if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
    await recordLoginEvent({ username, platformUserId: user.id, result: "failure", reason: "account_locked", request: input.request });
    return { ok: false as const, error: "ACCOUNT_LOCKED" };
  }
  if (!verifyPlatformPassword(input.password, user.passwordHash)) {
    const failedLoginCount = user.failedLoginCount + 1;
    const lockedUntil = failedLoginCount >= 5
      ? new Date(now.getTime() + 15 * 60 * 1000).toISOString()
      : null;
    await db
      .update(platformUsers)
      .set({ failedLoginCount, lockedUntil, updatedAt: now.toISOString() })
      .where(eq(platformUsers.id, user.id));
    await recordLoginEvent({
      username,
      platformUserId: user.id,
      result: "failure",
      reason: lockedUntil ? "too_many_attempts" : "invalid_credentials",
      request: input.request,
    });
    return { ok: false as const, error: lockedUntil ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS" };
  }

  const roleRows = await db
    .select({
      roleId: platformRoles.id,
      roleName: platformRoles.name,
      permissionsJson: platformRoles.permissionsJson,
    })
    .from(platformUserRoles)
    .innerJoin(platformRoles, eq(platformRoles.id, platformUserRoles.roleId))
    .where(eq(platformUserRoles.platformUserId, user.id))
    .orderBy(desc(platformRoles.id))
    .limit(8);
  const roleRow = roleRows.find((row) => row.roleId === "owner") || roleRows[0];
  if (!roleRow) {
    await recordLoginEvent({ username, platformUserId: user.id, result: "failure", reason: "role_missing", request: input.request });
    return { ok: false as const, error: "ROLE_MISSING" };
  }

  await db
    .update(platformUsers)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(platformUsers.id, user.id));
  const session = await createSession(user, input.request, roleRow);
  await recordLoginEvent({ username, platformUserId: user.id, result: "success", reason: "login", request: input.request });
  return { ok: true as const, ...session, mustChangePassword: user.mustChangePassword };
}

export async function revokePlatformSession(request: any) {
  const cookie = cookieValue(request?.headers?.cookie, PLATFORM_AUTH_COOKIE);
  if (!cookie) return false;
  const result = await db
    .update(platformSessions)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(platformSessions.id, cookie), isNull(platformSessions.revokedAt)));
  return Number(result.changes || 0) > 0;
}

export async function recordPlatformAudit(input: {
  request: any;
  context: PlatformAuthContext | null;
  action: string;
  route: string;
  permission?: PlatformPermission;
  targetCustomerKey?: string;
  status: "allowed" | "denied" | "failure";
  summary?: Record<string, unknown>;
}) {
  await db.insert(platformAdminAuditLogs).values({
    id: randomUUID(),
    platformUserId: input.context?.userId,
    role: input.context?.role,
    action: input.action,
    route: input.route,
    permission: input.permission,
    targetCustomerKey: input.targetCustomerKey,
    requestId: input.request?.id,
    ipAddress: requestIp(input.request),
    userAgent: userAgent(input.request),
    status: input.status,
    summaryJson: JSON.stringify(input.summary || {}),
    createdAt: new Date().toISOString(),
  });
}
