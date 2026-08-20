import "./load-env.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, type UserContext } from "./user-context.js";
import { DEFAULT_SANDBOX_PERMISSIONS } from "../platform/project-registry.js";

export type SandboxRole = "admin" | "user" | "system" | "test";
export type SandboxChannel = "dashboard" | "weixin-mobile" | "scheduler" | "api";
export type SandboxPermission =
  | "read:self"
  | "write:self"
  | "review:self"
  | "alert:self"
  | "push:self"
  | "admin:users"
  | "admin:global-settings"
  | "admin:weixin"
  | "admin:debug";

export interface SandboxContext {
  userId: string;
  projectId: string;
  instanceId: string;
  projectType?: string;
  skillBundleId?: string;
  strategySkillId?: string;
  instanceExpansionPath?: string;
  role: SandboxRole;
  channel: SandboxChannel;
  backend?: UserContext["backend"];
  conversationId?: string;
  externalUserId?: string;
  channelAccountId?: string;
  permissions: SandboxPermission[];
  tokenId?: string;
  expiresAt?: string;
}

type SandboxTokenPayload = SandboxContext & {
  tokenId: string;
  issuedAt: string;
  expiresAt: string;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000;
// Automation file maintenance writes through its task-owned asset path. Its
// ACP session must not inherit the normal interactive sandbox write/push
// permissions, otherwise a prompt-level restriction could be bypassed by a
// service endpoint that mutates investment state.
const AUTOMATION_SANDBOX_PERMISSIONS: SandboxPermission[] = ["read:self"];
const localSandboxSecret = loadLocalSandboxSecret();
const secret = process.env.INVEST_AGENT_SANDBOX_SECRET || localSandboxSecret;

if (!process.env.INVEST_AGENT_SANDBOX_SECRET) {
  console.warn("[sandbox] INVEST_AGENT_SANDBOX_SECRET 未设置，当前进程使用本地持久 sandbox secret；生产环境请显式配置环境变量");
}

function loadLocalSandboxSecret() {
  const filePath = path.resolve(process.env.INVEST_AGENT_SANDBOX_SECRET_FILE || "data/.sandbox-secret");
  try {
    if (existsSync(filePath)) {
      const value = readFileSync(filePath, "utf-8").trim();
      if (value) return value;
    }
    mkdirSync(path.dirname(filePath), { recursive: true });
    const value = randomBytes(32).toString("hex");
    try {
      writeFileSync(filePath, `${value}\n`, { mode: 0o600, flag: "wx" });
    } catch {
      const existing = readFileSync(filePath, "utf-8").trim();
      if (existing) return existing;
      writeFileSync(filePath, `${value}\n`, { mode: 0o600 });
    }
    chmodSync(filePath, 0o600);
    return value;
  } catch {
    return randomBytes(32).toString("hex");
  }
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function validSignature(data: string, signature: string) {
  if (safeEqual(signature, createHmac("sha256", secret).update(data).digest("base64url"))) {
    return true;
  }
  return process.env.NODE_ENV !== "production"
    && localSandboxSecret !== secret
    && safeEqual(signature, createHmac("sha256", localSandboxSecret).update(data).digest("base64url"));
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createSandboxToken(context: SandboxContext, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const payload: SandboxTokenPayload = {
    ...context,
    tokenId: context.tokenId || randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifySandboxToken(token: string, now = new Date()): SandboxContext {
  const [body, signature] = token.split(".");
  if (!body || !signature || !validSignature(body, signature)) {
    throw new Error("SANDBOX_TOKEN_INVALID");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8")) as SandboxTokenPayload;
  if (!payload.userId || !payload.role || !payload.channel || !Array.isArray(payload.permissions)) {
    throw new Error("SANDBOX_TOKEN_INVALID_PAYLOAD");
  }
  if (new Date(payload.expiresAt).getTime() <= now.getTime()) {
    throw new Error("SANDBOX_TOKEN_EXPIRED");
  }

  return {
    userId: payload.userId,
    projectId: payload.projectId || DEFAULT_PROJECT_ID,
    instanceId: payload.instanceId || DEFAULT_INSTANCE_ID,
    projectType: payload.projectType,
    skillBundleId: payload.skillBundleId,
    strategySkillId: payload.strategySkillId,
    instanceExpansionPath: payload.instanceExpansionPath,
    role: payload.role,
    channel: payload.channel,
    backend: payload.backend,
    conversationId: payload.conversationId,
    externalUserId: payload.externalUserId,
    channelAccountId: payload.channelAccountId,
    permissions: payload.permissions,
    tokenId: payload.tokenId,
    expiresAt: payload.expiresAt,
  };
}

export function sandboxContextFromUserContext(
  userContext: UserContext,
  permissions?: SandboxPermission[]
): SandboxContext {
  const defaultPermissions = userContext.taskType === "scheduled-automation"
    ? AUTOMATION_SANDBOX_PERMISSIONS
    : DEFAULT_SANDBOX_PERMISSIONS;
  return {
    userId: userContext.userId,
    projectId: userContext.projectId || DEFAULT_PROJECT_ID,
    instanceId: userContext.instanceId || DEFAULT_INSTANCE_ID,
    instanceExpansionPath: userContext.instanceExpansionPath,
    role: "user",
    channel: userContext.channel === "weixin-mobile" ? "weixin-mobile" : "api",
    backend: userContext.backend,
    conversationId: userContext.conversationId,
    externalUserId: userContext.externalUserId,
    channelAccountId: userContext.channelAccountId,
    permissions: permissions || [...defaultPermissions],
  };
}

export function bearerTokenFromHeaders(headers: unknown) {
  const record = headers && typeof headers === "object" ? headers as Record<string, string | string[] | undefined> : {};
  const raw = record.authorization || record.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export function sandboxContextFromRequest(
  request: { headers?: unknown },
  required: SandboxPermission[] = []
): SandboxContext {
  const token = bearerTokenFromHeaders(request.headers);
  if (!token) {
    throw new Error("SANDBOX_TOKEN_REQUIRED");
  }
  const context = verifySandboxToken(token);
  for (const permission of required) {
    if (!context.permissions.includes(permission)) {
      throw new Error("SANDBOX_PERMISSION_DENIED");
    }
  }
  return context;
}
