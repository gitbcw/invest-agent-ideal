import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { access, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// E8: the mastra registry is the only storage root. Pin MASTRA_PROJECTS_ROOT
// to an isolated temp dir BEFORE any project module captures it at import.
const TEST_ROOT = mkdtempSync(path.join(os.tmpdir(), "invest-agent-project-registry-"));
process.env.MASTRA_PROJECTS_ROOT = path.join(TEST_ROOT, "projects");
process.once("exit", () => rmSync(TEST_ROOT, { recursive: true, force: true }));

const USER_ID = "test-delete-instance-cleanup";
const INSTANCE_ID = "invest-agent-test-delete-instance-cleanup";
const CONVERSATION_ID = "test-delete-instance-cleanup-conversation";
const LEGACY_USER_ID = "test-deleted-user";
const LEGACY_INSTANCE_ID = "invest-agent-test-deleted-user";

interface Modules {
  db: import("../src/db/index.js").db;
  schema: typeof import("../src/db/schema.js");
  registry: typeof import("../src/platform/project-registry.js");
  workspace: typeof import("../src/lib/workspace.js");
  mastraProject: typeof import("./helpers/mastra-project.js");
}

let modulesPromise: Promise<Modules> | null = null;
function load(): Promise<Modules> {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const dbModule = await import("../src/db/index.js");
      dbModule.initDb();
      const modules: Modules = {
        db: dbModule.db,
        schema: await import("../src/db/schema.js"),
        registry: await import("../src/platform/project-registry.js"),
        workspace: await import("../src/lib/workspace.js"),
        mastraProject: await import("./helpers/mastra-project.js"),
      };
      return modules;
    })();
  }
  return modulesPromise;
}

async function clearFixtures(): Promise<void> {
  const { db, schema, workspace } = await load();
  const { and, eq } = await import("drizzle-orm");
  await rm(workspace.resolveWorkspacePath(USER_ID), { recursive: true, force: true });
  await db.delete(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, CONVERSATION_ID));
  await db.delete(schema.conversationSessions).where(eq(schema.conversationSessions.conversationId, CONVERSATION_ID));
  await db.delete(schema.scheduledTaskRuns).where(eq(schema.scheduledTaskRuns.userId, USER_ID));
  await db.delete(schema.weixinDeliveryAttempts).where(eq(schema.weixinDeliveryAttempts.userId, USER_ID));
  await db.delete(schema.aiInstances).where(eq(schema.aiInstances.id, INSTANCE_ID));
  await db.delete(schema.users).where(eq(schema.users.id, USER_ID));
  void and;
}

async function seedInstanceWithScheduledRun(): Promise<void> {
  const { db, schema } = await load();
  const now = new Date().toISOString();
  await db.insert(schema.users).values({
    id: USER_ID,
    displayName: USER_ID,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.aiInstances).values({
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
  await db.insert(schema.scheduledTaskRuns).values({
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
  await db.insert(schema.weixinDeliveryAttempts).values({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    source: "scheduler",
    probe: false,
    result: "sent",
    reason: "sent",
    createdAt: now,
  });
}

describe("project registry instance deletion", { concurrency: false }, () => {
  beforeEach(async () => { await clearFixtures(); });
  afterEach(async () => { await clearFixtures(); });

  it("cleans scheduled task runs for the deleted instance", async () => {
    const { db, schema } = await load();
    const { and, eq } = await import("drizzle-orm");
    await seedInstanceWithScheduledRun();

    const { registry } = await load();
    await registry.deleteInvestAgentInstance(INSTANCE_ID);

    const leftovers = await db
      .select()
      .from(schema.scheduledTaskRuns)
      .where(and(eq(schema.scheduledTaskRuns.userId, USER_ID), eq(schema.scheduledTaskRuns.instanceId, INSTANCE_ID)));
    assert.equal(leftovers.length, 0);
    assert.equal((await db.select().from(schema.weixinDeliveryAttempts).where(eq(schema.weixinDeliveryAttempts.instanceId, INSTANCE_ID))).length, 0);
  });

  it("removes the deleted instance workspace", async () => {
    const { registry, mastraProject } = await load();
    await seedInstanceWithScheduledRun();
    // E8: instance storage is the registered mastra project root; deletion
    // removes that project directory instead of the legacy workspace path.
    const projectRoot = await mastraProject.registerTestProject({
      userId: USER_ID,
      projectId: "invest-agent",
      instanceId: INSTANCE_ID,
    });
    await writeFile(path.join(projectRoot, "eval-artifact.txt"), "temporary evaluation data");

    await registry.deleteInvestAgentInstance(INSTANCE_ID);

    await assert.rejects(access(projectRoot));
  });

  it("cleans evaluation conversation records", async () => {
    const { db, schema } = await load();
    const { eq } = await import("drizzle-orm");
    await seedInstanceWithScheduledRun();
    const now = new Date().toISOString();
    await db.insert(schema.conversationSessions).values({
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
    await db.insert(schema.conversationMessages).values({
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

    const { registry } = await load();
    await registry.deleteInvestAgentInstance(INSTANCE_ID);

    assert.equal((await db.select().from(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, CONVERSATION_ID))).length, 0);
    assert.equal((await db.select().from(schema.conversationSessions).where(eq(schema.conversationSessions.conversationId, CONVERSATION_ID))).length, 0);
  });

  it("deletes an instance without removing another scope's colliding legacy conversation", async () => {
    const { db, schema } = await load();
    const { eq } = await import("drizzle-orm");
    await seedInstanceWithScheduledRun();
    const now = new Date().toISOString();
    await db.insert(schema.conversationSessions).values({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      projectId: "invest-agent",
      instanceId: INSTANCE_ID,
      assistantId: INSTANCE_ID,
      channel: "weixin",
      title: "shared legacy conversation",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.conversationMessages).values([
      {
        messageId: `${CONVERSATION_ID}-target`,
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        projectId: "invest-agent",
        instanceId: INSTANCE_ID,
        assistantId: INSTANCE_ID,
        channel: "weixin",
        role: "user",
        content: "待删除实例的消息",
        createdAt: now,
      },
      {
        messageId: `${CONVERSATION_ID}-legacy`,
        conversationId: CONVERSATION_ID,
        userId: LEGACY_USER_ID,
        projectId: "invest-agent",
        instanceId: LEGACY_INSTANCE_ID,
        assistantId: LEGACY_INSTANCE_ID,
        channel: "weixin",
        role: "user",
        content: "已删除用户留下的消息",
        createdAt: now,
      },
    ]);

    const { registry } = await load();
    await registry.deleteInvestAgentInstance(INSTANCE_ID);

    const messages = await db.select().from(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, CONVERSATION_ID));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.userId, LEGACY_USER_ID);
    assert.equal((await db.select().from(schema.conversationSessions).where(eq(schema.conversationSessions.conversationId, CONVERSATION_ID))).length, 1);
  });
});
