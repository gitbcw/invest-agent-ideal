import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { scheduledTaskRuns } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";

export interface ScheduledTaskRunScope {
  userId?: string;
  projectId?: string;
  instanceId?: string;
}

export interface ScheduledTaskRunClaimInput extends ScheduledTaskRunScope {
  taskKey: string;
  taskType: string;
  scheduledFor: string;
}

export async function claimScheduledTaskRun(input: ScheduledTaskRunClaimInput): Promise<boolean> {
  const now = new Date().toISOString();
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
  await db
    .update(scheduledTaskRuns)
    .set({
      status: input.status,
      finishedAt: now,
      errorMessage: input.errorMessage?.slice(0, 1200) ?? null,
      pushJobId: input.pushJobId ?? null,
      updatedAt: now,
    })
    .where(eq(scheduledTaskRuns.taskKey, taskKey));
}
