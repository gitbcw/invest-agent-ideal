export const DEFAULT_USER_ID = "primary";
export const DEFAULT_PROJECT_ID = "invest-agent";
export const DEFAULT_INSTANCE_ID = "invest-agent-primary";
export type RuntimeBackend = "mastra";

export interface UserContext {
  userId: string;
  projectId?: string;
  instanceId?: string;
  instanceExpansionPath?: string;
  projectName?: string;
  channel?: "weixin-mobile" | "dashboard" | "api" | "web";
  backend?: RuntimeBackend;
  conversationId?: string;
  externalUserId?: string;
  channelAccountId?: string;
  workspacePath?: string;
  /** Optional MCP tool allowlist for isolated service-owned task phases. */
  mcpAllowedTools?: string[];
  /** F1: scheduled task type, drives least-privilege service tool grant (e.g. "scheduled-daily-review"). */
  taskType?: string;
  /** Scheduled reviews bind reviews.save to one service-enforced publication target. */
  expectedReviewKind?: "daily" | "weekly" | "monthly";
  expectedReviewKey?: string;
  welcomedAt?: string | null;
}

export function normalizeUserId(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_USER_ID;
}

export function defaultInstanceIdForUser(userId: string) {
  if (userId === DEFAULT_USER_ID) return DEFAULT_INSTANCE_ID;
  return `${DEFAULT_PROJECT_ID}-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

export function defaultUserContext(patch: Partial<UserContext> = {}): UserContext {
  return {
    userId: DEFAULT_USER_ID,
    projectId: DEFAULT_PROJECT_ID,
    instanceId: DEFAULT_INSTANCE_ID,
    ...patch,
  };
}

export function userIdFromRequest(request: { query?: unknown; body?: unknown; headers?: unknown }) {
  const headers = request.headers && typeof request.headers === "object" ? request.headers as Record<string, string | string[] | undefined> : undefined;
  const header = headers?.["x-invest-user-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const queryUserId =
    request.query && typeof request.query === "object" && "userId" in request.query
      ? String((request.query as { userId?: unknown }).userId ?? "")
      : undefined;
  const bodyUserId =
    request.body && typeof request.body === "object" && "userId" in request.body
      ? String((request.body as { userId?: unknown }).userId ?? "")
      : undefined;
  return normalizeUserId(queryUserId || bodyUserId || headerValue);
}

export function instanceIdFromRequest(request: { query?: unknown; body?: unknown; headers?: unknown }, userId = DEFAULT_USER_ID) {
  const headers = request.headers && typeof request.headers === "object" ? request.headers as Record<string, string | string[] | undefined> : undefined;
  const header = headers?.["x-invest-instance-id"];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const queryInstanceId =
    request.query && typeof request.query === "object" && "instanceId" in request.query
      ? String((request.query as { instanceId?: unknown }).instanceId ?? "")
      : undefined;
  const bodyInstanceId =
    request.body && typeof request.body === "object" && "instanceId" in request.body
      ? String((request.body as { instanceId?: unknown }).instanceId ?? "")
      : undefined;
  return (queryInstanceId || bodyInstanceId || headerValue || defaultInstanceIdForUser(userId)).trim();
}
