import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { channelIdentities, channelIdentityInstances, users } from "../db/schema.js";
import type { UserContext } from "./user-context.js";
import { DEFAULT_PROJECT_ID } from "./user-context.js";
import { ensureDefaultProjectForUser, getProjectRuntimeContext } from "../platform/project-registry.js";
import { mastraWorkspaceRegistry } from "../mastra/workspace-registry.js";
import { ensureWorkspace, resolveWorkspacePath } from "./workspace.js";

function suffix(value: string) {
  const normalized = value.trim();
  if (!normalized) return String(Date.now()).slice(-6);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 10);
}

function makeUserId(channel: string, externalUserId: string) {
  return `${channel}-${suffix(externalUserId)}`.toLowerCase();
}

function makeInstanceId(userId: string) {
  return `${DEFAULT_PROJECT_ID}-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

export async function ensureDefaultAiInstanceForUser(userId: string, backend: "mastra" = "mastra", displayName?: string) {
  const context = await ensureDefaultProjectForUser(userId, backend, displayName);
  if (backend === "mastra") {
    await mastraWorkspaceRegistry.bootstrap({ userId, projectId: context.projectId, instanceId: context.instanceId });
  }
  return { projectId: context.projectId, instanceId: context.instanceId };
}

export async function resolveOrCreateChannelUser(params: {
  channel: "weixin-mobile";
  backend: "mastra";
  externalUserId: string;
  externalAccountId?: string;
  conversationId?: string;
  contextToken?: string;
  projectBinding?: {
    projectId: string;
    instanceId: string;
    ownerUserId?: string;
    ownerDisplayName?: string;
    sharedUsers?: boolean;
  };
}): Promise<UserContext> {
  const now = new Date().toISOString();
  const projectBinding = params.projectBinding;
  const existing = await db
    .select()
    .from(channelIdentities)
    .where(and(eq(channelIdentities.channel, params.channel), eq(channelIdentities.externalUserId, params.externalUserId)))
    .limit(1);

  if (existing[0]) {
    const bindingUserId = projectBinding?.sharedUsers ? existing[0].userId : projectBinding?.ownerUserId || existing[0].userId;
    await db
      .update(channelIdentities)
      .set({
        userId: bindingUserId,
        backend: params.backend,
        externalAccountId: params.externalAccountId ?? existing[0].externalAccountId,
        lastConversationId: params.conversationId ?? existing[0].lastConversationId,
        lastContextToken: params.contextToken ?? existing[0].lastContextToken,
        updatedAt: now,
      })
      .where(eq(channelIdentities.id, existing[0].id));
    const instance = await ensureDefaultInstanceForChannelIdentity(existing[0].id, bindingUserId, params.backend, projectBinding);
    if (params.backend === "mastra") {
      await mastraWorkspaceRegistry.bootstrap({ userId: bindingUserId, projectId: instance.projectId, instanceId: instance.instanceId });
    }
    return {
      userId: bindingUserId,
      projectId: instance.projectId,
      instanceId: instance.instanceId,
      instanceExpansionPath: instance.instanceExpansionPath,
      projectName: instance.name,
      channel: params.channel,
      backend: params.backend,
      conversationId: params.conversationId,
      externalUserId: params.externalUserId,
      channelAccountId: params.externalAccountId,
      workspacePath: params.backend === "mastra"
        ? (await mastraWorkspaceRegistry.resolve({ userId: bindingUserId, projectId: instance.projectId, instanceId: instance.instanceId }))?.realProjectRoot
        : resolveWorkspacePath(bindingUserId),
      welcomedAt: existing[0].welcomedAt,
    };
  }

  const channelUserId = makeUserId(params.channel, params.externalUserId);
  const userId = projectBinding?.sharedUsers ? channelUserId : projectBinding?.ownerUserId || channelUserId;
  const displayName = projectBinding?.ownerDisplayName || `微信用户 ${suffix(params.externalUserId)}`;
  let instanceId: string;
  if (projectBinding) {
    await db.insert(users).values({
      id: userId,
      displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    instanceId = projectBinding.instanceId;
  } else {
    const ensured = await ensureDefaultAiInstanceForUser(userId, params.backend, displayName);
    instanceId = ensured.instanceId;
  }

  const insertedIdentity = await db.insert(channelIdentities).values({
    userId,
    channel: params.channel,
    backend: params.backend,
    externalUserId: params.externalUserId,
    externalAccountId: params.externalAccountId,
    lastConversationId: params.conversationId,
    lastContextToken: params.contextToken,
    createdAt: now,
    updatedAt: now,
  }).returning({ id: channelIdentities.id });
  const channelIdentityId = insertedIdentity[0]?.id;
  if (channelIdentityId) {
    await ensureChannelIdentityInstance(channelIdentityId, instanceId, projectBinding?.projectId ?? DEFAULT_PROJECT_ID);
  }
  const context = await getProjectRuntimeContext(instanceId);

  return {
    userId,
    projectId: context.projectId,
    instanceId,
    instanceExpansionPath: context.instanceExpansionPath,
    projectName: context.name,
    channel: params.channel,
    backend: params.backend,
    conversationId: params.conversationId,
    externalUserId: params.externalUserId,
    channelAccountId: params.externalAccountId,
    workspacePath: params.backend === "mastra"
      ? (await mastraWorkspaceRegistry.resolve({ userId, projectId: context.projectId, instanceId: context.instanceId }))?.realProjectRoot
      : resolveWorkspacePath(userId),
    welcomedAt: null,
  };
}

export async function markChannelIdentityWelcomed(
  userId: string,
  channel: string,
  externalUserId: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(channelIdentities)
    .set({ welcomedAt: now, updatedAt: now })
    .where(and(eq(channelIdentities.userId, userId), eq(channelIdentities.channel, channel), eq(channelIdentities.externalUserId, externalUserId)));
}

async function ensureDefaultInstanceForChannelIdentity(
  channelIdentityId: number,
  userId: string,
  backend: "mastra",
  projectBinding?: {
    projectId: string;
    instanceId: string;
    ownerUserId?: string;
    ownerDisplayName?: string;
    sharedUsers?: boolean;
  }
) {
  const targetProjectId = projectBinding?.projectId ?? DEFAULT_PROJECT_ID;
  const targetInstanceId = projectBinding?.instanceId;
  const existing = await db
    .select()
    .from(channelIdentityInstances)
    .where(and(eq(channelIdentityInstances.channelIdentityId, channelIdentityId), eq(channelIdentityInstances.projectId, targetProjectId), eq(channelIdentityInstances.isDefault, true)))
    .limit(1);
  if (existing[0]) {
    if (targetInstanceId && existing[0].instanceId !== targetInstanceId) {
      await db
        .update(channelIdentityInstances)
        .set({
          instanceId: targetInstanceId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(channelIdentityInstances.id, existing[0].id));
      const context = await getProjectRuntimeContext(targetInstanceId);
      return context;
    }
    const context = await getProjectRuntimeContext(existing[0].instanceId);
    return context;
  }
  const instanceId = targetInstanceId ?? makeInstanceId(userId);
  if (!projectBinding?.sharedUsers && !targetInstanceId) {
    await ensureDefaultAiInstanceForUser(userId, backend);
  }
  await ensureChannelIdentityInstance(channelIdentityId, instanceId, targetProjectId);
  const context = await getProjectRuntimeContext(instanceId);
  return context;
}

async function ensureChannelIdentityInstance(channelIdentityId: number, instanceId: string, projectId = DEFAULT_PROJECT_ID) {
  const now = new Date().toISOString();
  await db.insert(channelIdentityInstances).values({
    channelIdentityId,
    projectId,
    instanceId,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}
