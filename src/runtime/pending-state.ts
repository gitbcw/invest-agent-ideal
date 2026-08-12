import type { ContextPacket } from "./context-packet.js";
import { DEFAULT_INSTANCE_ID, type UserContext } from "../lib/user-context.js";

export type PendingConfirmationKind = ContextPacket["pendingConfirmations"][number]["kind"];

interface PendingConfirmationRecord {
  userId: string;
  instanceId: string;
  kind: PendingConfirmationKind;
  summary: string;
  expiresAt?: string;
  updatedAt: number;
}

const pendingConfirmations = new Map<string, PendingConfirmationRecord>();

export function pendingStateKey(userContext: Pick<UserContext, "userId" | "instanceId" | "conversationId">, kind?: PendingConfirmationKind) {
  return [
    userContext.userId,
    userContext.instanceId || DEFAULT_INSTANCE_ID,
    kind || "*",
  ].join(":");
}

export function registerPendingConfirmation(
  userContext: Pick<UserContext, "userId" | "instanceId" | "conversationId">,
  input: {
    kind: PendingConfirmationKind;
    summary: string;
    ttlMs?: number;
  }
) {
  const now = Date.now();
  pendingConfirmations.set(pendingStateKey(userContext, input.kind), {
    userId: userContext.userId,
    instanceId: userContext.instanceId || DEFAULT_INSTANCE_ID,
    kind: input.kind,
    summary: input.summary,
    expiresAt: input.ttlMs ? new Date(now + input.ttlMs).toISOString() : undefined,
    updatedAt: now,
  });
}

export function clearPendingConfirmation(
  userContext: Pick<UserContext, "userId" | "instanceId" | "conversationId">,
  kind: PendingConfirmationKind
) {
  pendingConfirmations.delete(pendingStateKey(userContext, kind));
}

export function listPendingConfirmations(
  userContext: Pick<UserContext, "userId" | "instanceId" | "conversationId">
): ContextPacket["pendingConfirmations"] {
  const instanceId = userContext.instanceId || DEFAULT_INSTANCE_ID;
  const now = Date.now();
  const out: ContextPacket["pendingConfirmations"] = [];
  for (const [key, record] of pendingConfirmations) {
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
      pendingConfirmations.delete(key);
      continue;
    }
    if (record.userId !== userContext.userId || record.instanceId !== instanceId) continue;
    out.push({
      kind: record.kind,
      summary: record.summary,
      expiresAt: record.expiresAt,
    });
  }
  return out.sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
}
