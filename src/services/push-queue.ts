import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { pushJobs } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { hasActiveWeixinComplexTask } from "../channels/weixin-activity.js";

export type PushBackend = "codex" | "hermes";
export type PushChannel = "weixin-mobile";

export interface PushJobInput {
  userId?: string;
  projectId?: string;
  instanceId?: string;
  channel?: PushChannel;
  backend?: PushBackend;
  source?: string;
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
}) => Promise<boolean>;

const RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
];

const USER_ACTIVE_DEFER_MS = 2 * 60 * 1000;
const DEFERABLE_SOURCES = new Set(["scheduler"]);

export async function enqueuePushJob(input: PushJobInput) {
  const now = new Date().toISOString();
  const record = {
    id: randomUUID(),
    userId: input.userId || DEFAULT_USER_ID,
    projectId: input.projectId || DEFAULT_PROJECT_ID,
    instanceId: input.instanceId || DEFAULT_INSTANCE_ID,
    channel: input.channel || "weixin-mobile",
    backend: input.backend || "codex",
    source: input.source || "scheduler",
    message: input.message,
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 5,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(pushJobs).values(record);
  return record;
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
    .where(and(inArray(pushJobs.status, ["pending", "retry"]), lte(pushJobs.nextRetryAt, now.toISOString())))
    .orderBy(asc(pushJobs.nextRetryAt), asc(pushJobs.createdAt))
    .limit(options.limit ?? 20);

  let sent = 0;
  let retried = 0;
  let dead = 0;

  for (const job of due) {
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
      const ok = await sender({
        id: job.id,
        userId: job.userId,
        projectId: job.projectId,
        instanceId: job.instanceId,
        channel: job.channel as PushChannel,
        backend: job.backend as PushBackend,
        message: job.message,
      });
      if (ok) {
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
        sent += 1;
        continue;
      }
      const result = await markFailed(job.id, attempts, job.maxAttempts, "push sender returned false");
      if (result === "dead") dead += 1;
      else retried += 1;
    } catch (error) {
      const result = await markFailed(job.id, attempts, job.maxAttempts, error instanceof Error ? error.message : String(error));
      if (result === "dead") dead += 1;
      else retried += 1;
    }
  }

  if (due.length > 0) {
    logger.info(`推送队列处理完成 due=${due.length} sent=${sent} retry=${retried} dead=${dead}`);
  }
  return { due: due.length, sent, retried, dead };
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

async function markFailed(id: string, attempts: number, maxAttempts: number, errorMessage: string) {
  const now = Date.now();
  const dead = attempts >= maxAttempts;
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  const nextRetryAt = new Date(now + delay).toISOString();
  await db
    .update(pushJobs)
    .set({
      status: dead ? "dead" : "retry",
      attempts,
      nextRetryAt,
      lastAttemptAt: new Date(now).toISOString(),
      lastError: errorMessage.slice(0, 1200),
      updatedAt: new Date(now).toISOString(),
    })
    .where(eq(pushJobs.id, id));
  return dead ? "dead" : "retry";
}
