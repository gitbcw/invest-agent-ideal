import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { aiInstances, conversationMessages, conversationSessions, scheduledTaskRuns, users } from "../src/db/schema.js";
import { deleteInvestAgentInstance } from "../src/platform/project-registry.js";
import { resolveWorkspacePath } from "../src/lib/workspace.js";

const USER_ID = "test-delete-instance-cleanup";
const INSTANCE_ID = "invest-agent-test-delete-instance-cleanup";
const CONVERSATION_ID = "test-delete-instance-cleanup-conversation";

async function clearFixtures(): Promise<void> {
  await rm(resolveWorkspacePath(USER_ID), { recursive: true, force: true });
  await db.delete(conversationMessages).where(eq(conversationMessages.conversationId, CONVERSATION_ID));
  await db.delete(conversationSessions).where(eq(conversationSessions.conversationId, CONVERSATION_ID));
  await db.delete(scheduledTaskRuns).where(eq(scheduledTaskRuns.userId, USER_ID));
  await db.delete(aiInstances).where(eq(aiInstances.id, INSTANCE_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}

async function seedInstanceWithScheduledRun(): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: USER_ID,
    displayName: USER_ID,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(aiInstances).values({
    id: INSTANCE_ID,
    projectId: "invest-agent",
    ownerUserId: USER_ID,
    name: "delete cleanup test",
    status: "active",
    backend: "codex",
    skillBundleId: "invest-agent-default",
    config: "{}",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scheduledTaskRuns).values({
    taskKey: "2026-07-03:market-watch:test-delete-instance-cleanup:09:55",
    taskType: "market-watch",
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    scheduledFor: "2026-07-03:09:55",
    status: "success",
    claimedAt: now,
    finishedAt: now,
    pushJobId: "stale-push-job-id",
    createdAt: now,
    updatedAt: now,
  });
}

describe("project registry instance deletion", { concurrency: false }, () => {
  beforeEach(async () => { await clearFixtures(); });
  afterEach(async () => { await clearFixtures(); });

  it("cleans scheduled task runs for the deleted instance", async () => {
    await seedInstanceWithScheduledRun();

    await deleteInvestAgentInstance(INSTANCE_ID);

    const leftovers = await db
      .select()
      .from(scheduledTaskRuns)
      .where(and(eq(scheduledTaskRuns.userId, USER_ID), eq(scheduledTaskRuns.instanceId, INSTANCE_ID)));
    assert.equal(leftovers.length, 0);
  });

  it("removes the deleted instance workspace", async () => {
    await seedInstanceWithScheduledRun();
    const workspacePath = resolveWorkspacePath(USER_ID);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(`${workspacePath}/eval-artifact.txt`, "temporary evaluation data");

    await deleteInvestAgentInstance(INSTANCE_ID);

    await assert.rejects(access(workspacePath));
  });

  it("cleans evaluation conversation records", async () => {
    await seedInstanceWithScheduledRun();
    const now = new Date().toISOString();
    await db.insert(conversationSessions).values({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      projectId: "invest-agent",
      instanceId: INSTANCE_ID,
      assistantId: INSTANCE_ID,
      channel: "weixin",
      title: "evaluation",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(conversationMessages).values({
      messageId: `${CONVERSATION_ID}-message`,
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      projectId: "invest-agent",
      instanceId: INSTANCE_ID,
      assistantId: INSTANCE_ID,
      channel: "weixin",
      role: "user",
      content: "评测消息",
      createdAt: now,
    });

    await deleteInvestAgentInstance(INSTANCE_ID);

    assert.equal((await db.select().from(conversationMessages).where(eq(conversationMessages.conversationId, CONVERSATION_ID))).length, 0);
    assert.equal((await db.select().from(conversationSessions).where(eq(conversationSessions.conversationId, CONVERSATION_ID))).length, 0);
  });
});
