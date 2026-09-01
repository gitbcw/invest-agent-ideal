import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { pushJobs } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { hasActiveWeixinComplexTask } from "../channels/weixin-activity.js";
import { sanitizeWeixinCustomerText } from "../lib/customer-output.js";
import { recordWeixinDeliveryAttempt, type WeixinDeliveryResult } from "./weixin-delivery.js";

export type PushBackend = "mastra";
export type PushChannel = "weixin-mobile";

export interface PushJobInput {
  userId?: string;
  projectId?: string;
  instanceId?: string;
  channel?: PushChannel;
  backend?: PushBackend;
  source?: string;
  idempotencyKey?: string;
  messageKind?: string;
  expiresAt?: string;
  originTaskKey?: string;
  originRunId?: string;
  retryPolicy?: string;
  message: string;
  maxAttempts?: number;
}

export type PushSender = (job: {
  id: string;
  userId: string;
  projectId: string;
  instanceId: string;
  channel: PushChannel;
  backend: PushBackend;
  message: string;
  /** 该 job 此前已成功发出的分片数；发送方应跳过这些分片（T-452）。 */
  sentChunks: number;
}) => Promise<boolean | WeixinDeliveryResult>;

const RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
];

const USER_ACTIVE_DEFER_MS = 2 * 60 * 1000;
const PUSH_PROCESSING_LEASE_MS = 2 * 60 * 1000;
// automation（typed 自动化任务）与 scheduler/onboarding 一样可安全滞留：撞上
// context_expired 等"等用户来消息"类失败时挂起为 awaiting_user 等会话恢复，
// 而不是烧完重试判死。8-06 引入 automation source 时漏同步本清单与
// weixin-delivery 的 resume 过滤器（T-414：mg 持仓复盘推送 ret=-2 5 连败）。
const DEFERABLE_SOURCES = new Set(["scheduler", "onboarding_commit", "automation"]);
// automation 推送默认业务有效期：awaiting_user 只恢复"明确未过期"的 job
// （resumeAwaitingWeixinDeliveries 的 gt(expiresAt, now) 谓词），无窗口会永远滞留。
const envAutomationValidityMs = Number(process.env.AUTOMATION_PUSH_VALIDITY_MS);
const AUTOMATION_PUSH_VALIDITY_MS = Number.isFinite(envAutomationValidityMs) && envAutomationValidityMs > 0
  ? envAutomationValidityMs
  : 24 * 60 * 60 * 1000;

export async function enqueuePushJob(input: PushJobInput) {
  if (input.idempotencyKey) {
    const [existing] = await db.select().from(pushJobs).where(eq(pushJobs.idempotencyKey, input.idempotencyKey)).limit(1);
    if (existing) return existing;
  }
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    userId: input.userId || DEFAULT_USER_ID,
    projectId: input.projectId || DEFAULT_PROJECT_ID,
    instanceId: input.instanceId || DEFAULT_INSTANCE_ID,
    channel: input.channel || "weixin-mobile",
    backend: input.backend || "mastra",
    source: input.source || "scheduler",
    idempotencyKey: input.idempotencyKey,
    messageKind: input.messageKind,
    expiresAt: input.expiresAt ?? (input.source === "automation"
      ? new Date(Date.now() + AUTOMATION_PUSH_VALIDITY_MS).toISOString()
      : undefined),
    originTaskKey: input.originTaskKey,
    originRunId: input.originRunId,
    retryPolicy: input.retryPolicy,
    terminalReason: null,
    message: input.channel === undefined || input.channel === "weixin-mobile"
      ? sanitizeWeixinCustomerText(input.message)
      : input.message,
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 5,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.insert(pushJobs).values(record);
    return record;
  } catch (error) {
    if (!input.idempotencyKey) throw error;
    const [existing] = await db.select().from(pushJobs).where(eq(pushJobs.idempotencyKey, input.idempotencyKey)).limit(1);
    if (existing) return existing;
    throw error;
  }
}

export async function getPushJob(id: string) {
  const [job] = await db.select().from(pushJobs).where(eq(pushJobs.id, id)).limit(1);
  return job;
}

export async function getPushQueueSummary() {
  const rows = await db
    .select({ status: pushJobs.status, count: count() })
    .from(pushJobs)
    .groupBy(pushJobs.status);
  return Object.fromEntries(rows.map((row) => [row.status, row.count])) as Record<string, number>;
}

export async function processDuePushJobs(sender: PushSender, options: { limit?: number } = {}) {
  const now = new Date();
  const due = await db
    .select()
    .from(pushJobs)
    .where(and(inArray(pushJobs.status, ["pending", "retry", "processing"]), lte(pushJobs.nextRetryAt, now.toISOString())))
    .orderBy(asc(pushJobs.nextRetryAt), asc(pushJobs.createdAt))
    .limit(options.limit ?? 20);

  let sent = 0;
  let retried = 0;
  let dead = 0;
  let awaitingUser = 0;
  let expired = 0;

  for (const job of due) {
    // A job can be observed by the immediate enqueue drain and the interval worker at once.
    // Only the worker that successfully acquires this lease may call the external channel.
    const claimed = await claimDuePushJob(job.id, now);
    if (!claimed) continue;

    if (isExpired(job.expiresAt, now)) {
      await markExpired(job.id, "expired_before_delivery", now);
      await syncAutomationDelivery(job, "failed");
      expired += 1;
      continue;
    }

    if (
      DEFERABLE_SOURCES.has(job.source) &&
      hasActiveWeixinComplexTask({ userId: job.userId, instanceId: job.instanceId })
    ) {
      await deferJob(job.id, USER_ACTIVE_DEFER_MS, "user has active complex analysis");
      retried += 1;
      continue;
    }
    const attempts = job.attempts + 1;
    const attemptAt = new Date().toISOString();
    try {
      const senderResult = await sender({
        id: job.id,
        userId: job.userId,
        projectId: job.projectId,
        instanceId: job.instanceId,
        channel: job.channel as PushChannel,
        backend: job.backend as PushBackend,
        message: job.message,
        sentChunks: job.sentChunks ?? 0,
      });
      const result: WeixinDeliveryResult = typeof senderResult === "boolean"
        ? { ok: senderResult, reason: senderResult ? "sent" : "wechat_api_error" }
        : senderResult;
      await recordWeixinDeliveryAttempt({
        userId: job.userId,
        instanceId: job.instanceId,
        pushJobId: job.id,
        source: job.source,
        result,
      });
      if (result.ok) {
        await db
          .update(pushJobs)
          .set({
            status: "sent",
            attempts,
            lastAttemptAt: attemptAt,
            sentAt: attemptAt,
            lastError: null,
            updatedAt: attemptAt,
          })
          .where(eq(pushJobs.id, job.id));
        await syncAutomationDelivery(job, "sent");
        sent += 1;
        continue;
      }
      if (isWaitingExternal(result.reason) && DEFERABLE_SOURCES.has(job.source)) {
        await markAwaitingUser(job.id, attempts, result.errorMessage || result.reason, result.sentChunks ?? job.sentChunks ?? 0);
        awaitingUser += 1;
        continue;
      }
      const outcome = await markFailed({
        id: job.id,
        attempts,
        maxAttempts: job.maxAttempts,
        expiresAt: job.expiresAt,
        errorClass: classifyDeliveryFailure(result.reason),
        errorMessage: result.errorMessage || result.reason,
        sentChunks: typeof result.sentChunks === "number"
          ? result.sentChunks
          : (job.sentChunks ?? 0),
      });
      if (outcome === "dead") dead += 1;
      else if (outcome === "expired") expired += 1;
      else retried += 1;
      await syncAutomationDelivery(job, outcome === "retry" ? "pending" : "failed");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await recordWeixinDeliveryAttempt({
        userId: job.userId,
        instanceId: job.instanceId,
        pushJobId: job.id,
        source: job.source,
        result: { ok: false, reason: "wechat_api_error", errorMessage },
      });
      const outcome = await markFailed({
        id: job.id,
        attempts,
        maxAttempts: job.maxAttempts,
        expiresAt: job.expiresAt,
        errorClass: "unknown",
        errorMessage,
      });
      if (outcome === "dead") dead += 1;
      else if (outcome === "expired") expired += 1;
      else retried += 1;
      await syncAutomationDelivery(job, outcome === "retry" ? "pending" : "failed");
    }
  }

  if (due.length > 0) {
    logger.info(`推送队列处理完成 due=${due.length} sent=${sent} retry=${retried} awaitingUser=${awaitingUser} expired=${expired} dead=${dead}`);
  }
  return { due: due.length, sent, retried, awaitingUser, expired, dead };
}

async function claimDuePushJob(id: string, now: Date): Promise<boolean> {
  const claimedAt = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + PUSH_PROCESSING_LEASE_MS).toISOString();
  const result = await db
    .update(pushJobs)
    .set({
      status: "processing",
      nextRetryAt: leaseExpiresAt,
      updatedAt: claimedAt,
    })
    .where(and(
      eq(pushJobs.id, id),
      inArray(pushJobs.status, ["pending", "retry", "processing"]),
      lte(pushJobs.nextRetryAt, claimedAt),
    ));
  return result.changes > 0;
}

async function deferJob(id: string, delayMs: number, reason: string) {
  const now = new Date();
  const nextRetryAt = new Date(now.getTime() + delayMs).toISOString();
  await db
    .update(pushJobs)
    .set({
      status: "retry",
      nextRetryAt,
      lastError: reason,
      updatedAt: now.toISOString(),
    })
    .where(eq(pushJobs.id, id));
}

type DeliveryErrorClass = "transient" | "permanent" | "unknown";

function classifyDeliveryFailure(reason: WeixinDeliveryResult["reason"]): DeliveryErrorClass {
  if (reason === "no_connected_account") return "permanent";
  return reason === "wechat_api_error" ? "transient" : "unknown";
}

function isWaitingExternal(reason: WeixinDeliveryResult["reason"]): boolean {
  return ["context_expired", "session_expired", "no_recent_conversation", "account_mismatch"].includes(reason);
}

function isExpired(expiresAt: string | null, now: Date): boolean {
  return Boolean(expiresAt && Date.parse(expiresAt) <= now.getTime());
}

async function markExpired(id: string, reason: string, now = new Date()) {
  const nowIso = now.toISOString();
  await db
    .update(pushJobs)
    .set({ status: "expired", terminalReason: reason, nextRetryAt: nowIso, updatedAt: nowIso })
    .where(eq(pushJobs.id, id));
}

async function markFailed(input: {
  id: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: string | null;
  errorClass: DeliveryErrorClass;
  errorMessage: string;
  sentChunks?: number;
}): Promise<"retry" | "dead" | "expired"> {
  const now = Date.now();
  const dead = input.errorClass === "permanent" || input.attempts >= input.maxAttempts;
  const delay = RETRY_DELAYS_MS[Math.min(input.attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const nextRetryAt = new Date(now + delay).toISOString();
  const expired = input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.parse(nextRetryAt);
  const status = expired ? "expired" : dead ? "dead" : "retry";
  const terminalReason = expired ? "expired_before_next_delivery_retry" : dead ? input.errorClass === "permanent" ? "permanent_error" : "max_attempts" : null;
  await db
    .update(pushJobs)
    .set({
      status,
      attempts: input.attempts,
      nextRetryAt: expired ? input.expiresAt as string : nextRetryAt,
      lastAttemptAt: new Date(now).toISOString(),
      lastError: input.errorMessage.slice(0, 1200),
      sentChunks: input.sentChunks ?? 0,
      terminalReason,
      updatedAt: new Date(now).toISOString(),
    })
    .where(eq(pushJobs.id, input.id));
  return expired ? "expired" : dead ? "dead" : "retry";
}

async function markAwaitingUser(id: string, attempts: number, errorMessage: string, sentChunks = 0) {
  const now = new Date().toISOString();
  await db
    .update(pushJobs)
    .set({
      status: "awaiting_user",
      attempts,
      lastAttemptAt: now,
      lastError: errorMessage.slice(0, 1200),
      sentChunks,
      updatedAt: now,
    })
    .where(eq(pushJobs.id, id));
}

async function syncAutomationDelivery(
  job: { originRunId?: string | null; userId: string; projectId: string; instanceId: string },
  status: "pending" | "sent" | "failed",
): Promise<void> {
  if (!job.originRunId) return;
  try {
    const { updateAutomationTaskRunDelivery } = await import("./automation-tasks.js");
    await updateAutomationTaskRunDelivery({
      userId: job.userId, projectId: job.projectId, instanceId: job.instanceId,
      runId: job.originRunId, status,
    });
  } catch (error) {
    logger.warn(`automation delivery status sync failed run=${job.originRunId}: ${(error as Error).message}`);
  }
}
