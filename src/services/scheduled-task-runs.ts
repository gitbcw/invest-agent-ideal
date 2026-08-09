import { and, eq, isNull, lte, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { scheduledTaskRuns } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { logger } from "../lib/logger.js";

export const DEFAULT_SCHEDULED_TASK_LEASE_MS = 15 * 60 * 1000;
export const LEGACY_SCHEDULED_TASK_CLAIM_GRACE_MS = 30 * 60 * 1000;

export interface ScheduledTaskRunScope {
  userId?: string;
  projectId?: string;
  instanceId?: string;
}

export interface ScheduledTaskRunClaimInput extends ScheduledTaskRunScope {
  taskKey: string;
  taskType: string;
  scheduledFor: string;
  leaseMs?: number;
}

export interface ScheduledTaskRunState {
  taskKey: string;
  status: string;
  claimedAt: string;
  finishedAt: string | null;
  leaseExpiresAt: string | null;
  errorClass: string | null;
}

function normalizedLeaseMs(value: number | undefined) {
  if (!Number.isFinite(value) || (value ?? 0) < 1_000) return DEFAULT_SCHEDULED_TASK_LEASE_MS;
  return Math.floor(value as number);
}

export async function claimScheduledTaskRun(input: ScheduledTaskRunClaimInput): Promise<boolean> {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const leaseExpiresAt = new Date(nowDate.getTime() + normalizedLeaseMs(input.leaseMs)).toISOString();
  const result = await db
    .insert(scheduledTaskRuns)
    .values({
      taskKey: input.taskKey,
      taskType: input.taskType,
      userId: input.userId || DEFAULT_USER_ID,
      projectId: input.projectId || DEFAULT_PROJECT_ID,
      instanceId: input.instanceId || DEFAULT_INSTANCE_ID,
      scheduledFor: input.scheduledFor,
      status: "claimed",
      claimedAt: now,
      attempts: 1,
      leaseExpiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: scheduledTaskRuns.taskKey });
  return result.changes > 0;
}

export async function finishScheduledTaskRun(
  taskKey: string,
  input: { status: "success" | "skipped" | "error"; errorMessage?: string; pushJobId?: string } = { status: "success" },
) {
  const now = new Date().toISOString();
  const result = await db
    .update(scheduledTaskRuns)
    .set({
      status: input.status,
      finishedAt: now,
      errorMessage: input.errorMessage?.slice(0, 1200) ?? null,
      pushJobId: input.pushJobId ?? null,
      leaseExpiresAt: null,
      nextRetryAt: null,
      updatedAt: now,
    })
    .where(and(eq(scheduledTaskRuns.taskKey, taskKey), eq(scheduledTaskRuns.status, "claimed")));
  if (result.changes === 0) {
    logger.warn(`scheduled task finish ignored because claim is no longer active task=${taskKey} target=${input.status}`);
  }
  return result.changes > 0;
}

export async function getScheduledTaskRunState(taskKey: string): Promise<ScheduledTaskRunState | null> {
  const rows = await db
    .select({
      taskKey: scheduledTaskRuns.taskKey,
      status: scheduledTaskRuns.status,
      claimedAt: scheduledTaskRuns.claimedAt,
      finishedAt: scheduledTaskRuns.finishedAt,
      leaseExpiresAt: scheduledTaskRuns.leaseExpiresAt,
      errorClass: scheduledTaskRuns.errorClass,
    })
    .from(scheduledTaskRuns)
    .where(eq(scheduledTaskRuns.taskKey, taskKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function reconcileExpiredScheduledTaskRuns(now = new Date()): Promise<number> {
  const nowIso = now.toISOString();
  const legacyCutoff = new Date(now.getTime() - LEGACY_SCHEDULED_TASK_CLAIM_GRACE_MS).toISOString();
  const result = await db
    .update(scheduledTaskRuns)
    .set({
      status: "error",
      finishedAt: nowIso,
      errorMessage: "scheduler claim lease expired before terminal state",
      errorClass: "lease_expired",
      leaseExpiresAt: null,
      nextRetryAt: null,
      updatedAt: nowIso,
    })
    .where(and(
      eq(scheduledTaskRuns.status, "claimed"),
      or(
        lte(scheduledTaskRuns.leaseExpiresAt, nowIso),
        and(isNull(scheduledTaskRuns.leaseExpiresAt), lte(scheduledTaskRuns.claimedAt, legacyCutoff)),
      ),
    ));
  if (result.changes > 0) {
    logger.warn(`reconciled expired scheduled task claims count=${result.changes}`);
  }
  return result.changes;
}
