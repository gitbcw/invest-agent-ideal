import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";

const ACTIVE_COMPLEX_TTL_MS = 5 * 60 * 1000;

interface ActiveWeixinTask {
  userId: string;
  instanceId: string;
  conversationId: string;
  kind: "complex";
  startedAt: number;
  expiresAt: number;
}

const activeTasks = new Map<string, ActiveWeixinTask>();

function taskKey(userId?: string, instanceId?: string, conversationId?: string) {
  return [
    userId || DEFAULT_USER_ID,
    instanceId || DEFAULT_INSTANCE_ID,
    conversationId || "weixin-mobile",
  ].join("\n");
}

function cleanupExpired(now = Date.now()) {
  for (const [key, task] of activeTasks) {
    if (task.expiresAt <= now) activeTasks.delete(key);
  }
}

export function markWeixinComplexTaskActive(input: {
  userId?: string;
  instanceId?: string;
  conversationId?: string;
  ttlMs?: number;
}) {
  const now = Date.now();
  const userId = input.userId || DEFAULT_USER_ID;
  const instanceId = input.instanceId || DEFAULT_INSTANCE_ID;
  const conversationId = input.conversationId || "weixin-mobile";
  activeTasks.set(taskKey(userId, instanceId, conversationId), {
    userId,
    instanceId,
    conversationId,
    kind: "complex",
    startedAt: now,
    expiresAt: now + (input.ttlMs ?? ACTIVE_COMPLEX_TTL_MS),
  });
}

export function clearWeixinComplexTaskActive(input: {
  userId?: string;
  instanceId?: string;
  conversationId?: string;
}) {
  activeTasks.delete(taskKey(input.userId, input.instanceId, input.conversationId));
}

export function hasActiveWeixinComplexTask(input: {
  userId?: string;
  instanceId?: string;
  conversationId?: string;
} = {}) {
  cleanupExpired();
  const userId = input.userId || DEFAULT_USER_ID;
  const instanceId = input.instanceId || DEFAULT_INSTANCE_ID;
  const conversationId = input.conversationId;
  if (conversationId) {
    return activeTasks.has(taskKey(userId, instanceId, conversationId));
  }
  for (const task of activeTasks.values()) {
    if (task.userId === userId && task.instanceId === instanceId) return true;
  }
  return false;
}
