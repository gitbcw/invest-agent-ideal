import { and, desc, eq, gt, inArray, isNull, like, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { channelIdentities, pushJobs, weixinDeliveryAttempts } from "../db/schema.js";

export type WeixinDeliveryReason =
  | "sent"
  | "no_connected_account"
  | "no_recent_conversation"
  | "account_mismatch"
  | "context_expired"
  | "session_expired"
  | "wechat_api_error";

export type WeixinDeliveryResult = {
  ok: boolean;
  reason: WeixinDeliveryReason;
  errorMessage?: string;
  conversationId?: string;
};

export type PendingWeixinDelivery = {
  id: string;
  source: string;
  message: string;
  createdAt: string;
  summary: string;
};

export async function recordWeixinDeliveryAttempt(input: {
  userId: string;
  instanceId: string;
  pushJobId?: string;
  source: string;
  probe?: boolean;
  result: WeixinDeliveryResult;
}) {
  const now = new Date();
  const [identity] = await db
    .select({ externalAccountId: channelIdentities.externalAccountId, lastConversationId: channelIdentities.lastConversationId, lastInboundAt: channelIdentities.updatedAt })
    .from(channelIdentities)
    .where(and(eq(channelIdentities.userId, input.userId), eq(channelIdentities.channel, "weixin-mobile")))
    .orderBy(desc(channelIdentities.updatedAt))
    .limit(1);
  const lastInboundAt = identity?.lastInboundAt ?? null;
  const parsedInbound = lastInboundAt ? Date.parse(lastInboundAt) : Number.NaN;
  const elapsedSinceLastInboundMs = Number.isFinite(parsedInbound) ? Math.max(0, now.getTime() - parsedInbound) : null;
  await db.insert(weixinDeliveryAttempts).values({
    userId: input.userId,
    instanceId: input.instanceId,
    externalAccountId: identity?.externalAccountId ?? null,
    pushJobId: input.pushJobId,
    source: input.source,
    probe: input.probe ?? false,
    result: input.result.ok ? "sent" : "failed",
    reason: input.result.reason,
    errorMessage: input.result.errorMessage,
    conversationId: input.result.conversationId ?? identity?.lastConversationId ?? null,
    lastInboundAt,
    elapsedSinceLastInboundMs,
    createdAt: now.toISOString(),
  });
}

export async function getWeixinDeliveryHealth(userId: string, instanceId: string) {
  const [identity] = await db
    .select({ externalAccountId: channelIdentities.externalAccountId, lastConversationId: channelIdentities.lastConversationId, lastInboundAt: channelIdentities.updatedAt })
    .from(channelIdentities)
    .where(and(eq(channelIdentities.userId, userId), eq(channelIdentities.channel, "weixin-mobile")))
    .orderBy(desc(channelIdentities.updatedAt))
    .limit(1);
  const attempts = await db
    .select()
    .from(weixinDeliveryAttempts)
    .where(and(eq(weixinDeliveryAttempts.userId, userId), eq(weixinDeliveryAttempts.instanceId, instanceId)))
    .orderBy(desc(weixinDeliveryAttempts.createdAt))
    .limit(60);
  const lastInboundAt = identity?.lastInboundAt ?? null;
  const parsedInbound = lastInboundAt ? Date.parse(lastInboundAt) : Number.NaN;
  const pendingDeliveries = await listPendingWeixinDeliveries(userId, instanceId);
  return {
    lastInboundAt,
    inboundAgeMs: Number.isFinite(parsedInbound) ? Math.max(0, Date.now() - parsedInbound) : null,
    estimatedExpiryAt: Number.isFinite(parsedInbound) ? new Date(parsedInbound + 24 * 60 * 60 * 1000).toISOString() : null,
    hasConversation: Boolean(identity?.lastConversationId),
    externalAccountId: identity?.externalAccountId ?? null,
    latestAttempt: attempts[0] ? summarize(attempts[0]) : null,
    recentAttempts: attempts.map(summarize),
    observedContextWindow: observedContextWindow(attempts, lastInboundAt),
    pendingDeliveries: pendingDeliveries.map(({ message: _message, ...delivery }) => delivery),
  };
}

export async function listPendingWeixinDeliveries(userId: string, instanceId: string, limit = 5): Promise<PendingWeixinDelivery[]> {
  const now = new Date().toISOString();
  // Awaiting-user jobs are not selected by the delivery worker. Expire them here
  // before a newly restored conversation can offer stale reports for recovery.
  await db
    .update(pushJobs)
    .set({ status: "expired", terminalReason: "expired_while_awaiting_user", updatedAt: now })
    .where(and(
      eq(pushJobs.userId, userId),
      eq(pushJobs.instanceId, instanceId),
      inArray(pushJobs.status, ["awaiting_user", "dead"]),
      lte(pushJobs.expiresAt, now),
    ));
  const rows = await db
    .select({
      id: pushJobs.id,
      source: pushJobs.source,
      message: pushJobs.message,
      createdAt: pushJobs.createdAt,
    })
    .from(pushJobs)
    .where(and(
      eq(pushJobs.userId, userId),
      eq(pushJobs.instanceId, instanceId),
      inArray(pushJobs.source, ["scheduler", "onboarding_commit"]),
      or(
        eq(pushJobs.status, "awaiting_user"),
        and(eq(pushJobs.status, "dead"), like(pushJobs.lastError, "%ret=-2%")),
      ),
      or(isNull(pushJobs.expiresAt), gt(pushJobs.expiresAt, now)),
    ))
    .orderBy(desc(pushJobs.createdAt))
    .limit(Math.max(1, Math.min(limit, 10)));
  return rows.map((row) => ({ ...row, summary: summarizePendingMessage(row.message) }));
}

export async function markPendingWeixinDeliveriesRecovered(ids: string[]) {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  await db
    .update(pushJobs)
    .set({
      status: "recovered_after_user_message",
      sentAt: now,
      lastError: "用户恢复微信会话后已请求补发",
      updatedAt: now,
    })
    .where(inArray(pushJobs.id, ids));
}

function observedContextWindow(attempts: Array<typeof weixinDeliveryAttempts.$inferSelect>, lastInboundAt: string | null) {
  if (!lastInboundAt) return null;
  const cycle = attempts.filter((attempt) => attempt.lastInboundAt === lastInboundAt && attempt.elapsedSinceLastInboundMs !== null);
  const accepted = cycle
    .filter((attempt) => attempt.result === "sent")
    .map((attempt) => attempt.elapsedSinceLastInboundMs as number);
  const rejected = cycle
    .filter((attempt) => attempt.reason === "context_expired")
    .map((attempt) => attempt.elapsedSinceLastInboundMs as number);
  if (accepted.length === 0 && rejected.length === 0) return null;
  return {
    lastAcceptedAfterInboundMs: accepted.length > 0 ? Math.max(...accepted) : null,
    firstContextRejectedAfterInboundMs: rejected.length > 0 ? Math.min(...rejected) : null,
  };
}

function summarize(attempt: typeof weixinDeliveryAttempts.$inferSelect) {
  return {
    result: attempt.result,
    reason: attempt.reason,
    probe: attempt.probe,
    elapsedSinceLastInboundMs: attempt.elapsedSinceLastInboundMs,
    createdAt: attempt.createdAt,
  };
}

function summarizePendingMessage(message: string) {
  const firstLine = String(message || "")
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean) || "定时提醒";
  return firstLine.slice(0, 80);
}
