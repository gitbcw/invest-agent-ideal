import { rm } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentTraces,
  aiInstances,
  aiProjects,
  alertEvents,
  alertRules,
  alertSignalStates,
  alerts,
  channelIdentities,
  channelIdentityInstances,
  chatHistory,
  codexAcpTraces,
  conversationTasks,
  dailyPlans,
  indicatorResults,
  investmentProfiles,
  methodChangeCandidates,
  methodologyProfiles,
  pendingSandboxConfirmations,
  portfolio,
  pushJobs,
  reviewViewpoints,
  sandboxAuditLogs,
  stockPlans,
  tradeActions,
  users,
  watchlist,
} from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import type { SandboxPermission } from "../lib/sandbox-context.js";
import { ensureHermesRuntimeForWorkspace, ensureCodexRuntimeForWorkspace } from "../acp/stdio-agent.js";

export const INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID = "invest-agent-default";

export const ALLOWED_SANDBOX_TOOLS = [
  "invest.dashboard.read",
  "invest.portfolio.read",
  "invest.portfolio.write",
  "invest.watchlist.read",
  "invest.watchlist.write",
  "invest.plan.read",
  "invest.plan.write",
  "invest.profile.read",
  "invest.profile.write",
  "invest.review.read",
  "invest.review.write",
  "invest.alert.read",
  "invest.alert.write",
  "invest.alert.check",
  "invest.strategy.read",
  "invest.strategy.write",
  "push.weixin.send",
] as const;

export const DEFAULT_SANDBOX_PERMISSIONS: SandboxPermission[] = [
  "read:self",
  "write:self",
  "review:self",
  "alert:self",
  "push:self",
];

export const DEFAULT_RESOURCE_TYPES = [
  "portfolio",
  "watchlist",
  "stock_plan",
  "investment_profile",
  "methodology_profile",
  "method_change_candidate",
  "alert_rule",
  "alert_event",
  "daily_review",
  "indicator_result",
  "conversation_trace",
  "trading_strategy",
];

export interface AiProjectRuntimeContext {
  projectId: string;
  instanceId: string;
  legacyProjectId: string;
  projectType: string;
  ownerUserId: string;
  name: string;
  status: string;
  backend: "hermes" | "codex";
  skillBundleId: string;
  permissions: SandboxPermission[];
  dashboardType: string;
  allowedTools: readonly string[];
  resourceTypes: string[];
  config: Record<string, unknown>;
  strategySkillId?: string;
  instanceExpansionPath?: string;
  createdAt: string;
  updatedAt: string;
}

function suffix(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || String(Date.now()).slice(-6);
}

function makeInstanceId(userId: string) {
  if (userId === DEFAULT_USER_ID) return DEFAULT_INSTANCE_ID;
  return `${DEFAULT_PROJECT_ID}-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function parseBackend(value: string): "hermes" | "codex" {
  return value === "codex" ? "codex" : "hermes";
}

function parseConfig(value?: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function runtimeContextFromInstance(instance: typeof aiInstances.$inferSelect): AiProjectRuntimeContext {
  const config = parseConfig(instance.config);
  return {
    projectId: instance.id,
    instanceId: instance.id,
    legacyProjectId: instance.projectId,
    projectType: "invest-agent",
    ownerUserId: instance.ownerUserId,
    name: instance.name,
    status: instance.status,
    backend: parseBackend(instance.backend),
    skillBundleId: instance.skillBundleId || INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID,
    permissions: [...DEFAULT_SANDBOX_PERMISSIONS],
    dashboardType: "invest-agent",
    allowedTools: ALLOWED_SANDBOX_TOOLS,
    resourceTypes: [...DEFAULT_RESOURCE_TYPES],
    config,
    strategySkillId: typeof config.strategySkillId === "string" ? String(config.strategySkillId) : undefined,
    instanceExpansionPath: typeof config.instanceExpansionPath === "string" ? String(config.instanceExpansionPath) : undefined,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

export async function ensureDefaultProjectForUser(
  userId: string,
  backend: "hermes" | "codex" = "codex",
  displayName?: string
): Promise<AiProjectRuntimeContext> {
  const instanceId = makeInstanceId(userId);
  const now = new Date().toISOString();
  await db.insert(users).values({
    id: userId,
    displayName: displayName || userId,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(aiProjects).values({
    id: DEFAULT_PROJECT_ID,
    name: "投资助手",
    type: "investment-assistant",
    status: "active",
    description: "默认投资助手项目类型",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db.insert(aiInstances).values({
    id: instanceId,
    projectId: DEFAULT_PROJECT_ID,
    ownerUserId: userId,
    name: `投资助手 ${suffix(userId)}`,
    status: "active",
    backend,
    skillBundleId: INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID,
    config: JSON.stringify({ autoCreated: true }),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();

  await db
    .update(aiInstances)
    .set({ backend, updatedAt: now })
    .where(eq(aiInstances.id, instanceId));

  await ensureWorkspace({ userId, tenantId: userId, projectId: instanceId });
  if (backend === "codex") {
    await ensureCodexRuntimeForWorkspace(resolveWorkspacePath(userId));
  } else {
    await ensureHermesRuntimeForWorkspace(resolveWorkspacePath(userId));
  }

  return getProjectRuntimeContext(instanceId);
}

export async function createInvestAgentInstance(input: {
  userId: string;
  displayName?: string;
  instanceName?: string;
  backend?: "hermes" | "codex";
}) {
  const userId = input.userId.trim();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(userId)) {
    throw new Error("INVALID_USER_ID");
  }
  const instanceId = makeInstanceId(userId);
  const [existingUser, existingInstance] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1),
    db.select({ id: aiInstances.id }).from(aiInstances).where(eq(aiInstances.id, instanceId)).limit(1),
  ]);
  try {
    const displayName = input.displayName?.trim() || userId;
    const project = await ensureDefaultProjectForUser(userId, input.backend || "codex", displayName);
    const workspacePath = resolveWorkspacePath(userId);
    if ((input.backend || "hermes") === "codex") {
      await ensureCodexRuntimeForWorkspace(workspacePath);
    } else {
      await ensureHermesRuntimeForWorkspace(workspacePath);
    }
    const instanceName = input.instanceName?.trim();
    if (instanceName && instanceName !== project.name) {
      const now = new Date().toISOString();
      await db
        .update(aiInstances)
        .set({ name: instanceName, updatedAt: now })
        .where(eq(aiInstances.id, project.instanceId));
      return getProjectRuntimeContext(project.instanceId);
    }
    return project;
  } catch (error) {
    await rollbackCreatedInvestAgentInstance({
      userId,
      instanceId,
      createdUser: existingUser.length === 0,
      createdInstance: existingInstance.length === 0,
    }).catch((rollbackError) => {
      // 如果补偿也失败,保留原始错误,把补偿失败写日志便于人工清理。
      console.warn(`rollbackCreatedInvestAgentInstance failed user=${userId}:`, rollbackError);
    });
    throw error;
  }
}

export async function syncInstanceBackend(instanceId: string, backend: "hermes" | "codex") {
  const now = new Date().toISOString();
  await db
    .update(aiInstances)
    .set({ backend, updatedAt: now })
    .where(eq(aiInstances.id, instanceId));
  return getProjectRuntimeContext(instanceId);
}

async function rollbackCreatedInvestAgentInstance(input: {
  userId: string;
  instanceId: string;
  createdUser: boolean;
  createdInstance: boolean;
}) {
  await db.transaction((tx) => {
    if (input.createdInstance) {
      tx.delete(aiInstances).where(eq(aiInstances.id, input.instanceId)).run();
    }
    if (input.createdUser) {
      tx.delete(users).where(eq(users.id, input.userId)).run();
    }
  });
  if (input.createdInstance && input.createdUser) {
    await rm(resolveWorkspacePath(input.userId), { recursive: true, force: true });
  }
}

export async function deleteInvestAgentInstance(instanceId: string) {
  if (!instanceId || instanceId === DEFAULT_INSTANCE_ID) {
    throw new Error("CANNOT_DELETE_PRIMARY_INSTANCE");
  }
  const project = await getProjectRuntimeContext(instanceId);
  const userId = project.ownerUserId;
  const instanceIdValue = project.instanceId;

  const identityRows = await db
    .select({ id: channelIdentities.id })
    .from(channelIdentities)
    .where(eq(channelIdentities.userId, userId));
  const identityIds = identityRows.map((row) => row.id);

  await db.transaction((tx) => {
    tx.delete(channelIdentityInstances).where(eq(channelIdentityInstances.instanceId, instanceIdValue)).run();
    for (const id of identityIds) {
      tx.delete(channelIdentityInstances).where(eq(channelIdentityInstances.channelIdentityId, id)).run();
    }
    tx.delete(channelIdentities).where(eq(channelIdentities.userId, userId)).run();

    tx.delete(portfolio).where(and(eq(portfolio.userId, userId), eq(portfolio.instanceId, instanceIdValue))).run();
    tx.delete(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.instanceId, instanceIdValue))).run();
    tx.delete(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceIdValue))).run();
    tx.delete(stockPlans).where(and(eq(stockPlans.userId, userId), eq(stockPlans.instanceId, instanceIdValue))).run();
    tx.delete(chatHistory).where(and(eq(chatHistory.userId, userId), eq(chatHistory.instanceId, instanceIdValue))).run();
    tx.delete(dailyPlans).where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceIdValue))).run();
    tx.delete(investmentProfiles).where(and(eq(investmentProfiles.userId, userId), eq(investmentProfiles.instanceId, instanceIdValue))).run();
    tx.delete(methodologyProfiles).where(and(eq(methodologyProfiles.userId, userId), eq(methodologyProfiles.instanceId, instanceIdValue))).run();
    tx.delete(methodChangeCandidates).where(and(eq(methodChangeCandidates.userId, userId), eq(methodChangeCandidates.instanceId, instanceIdValue))).run();
    tx.delete(reviewViewpoints).where(and(eq(reviewViewpoints.userId, userId), eq(reviewViewpoints.instanceId, instanceIdValue))).run();
    tx.delete(alertEvents).where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceIdValue))).run();
    tx.delete(alertSignalStates).where(and(eq(alertSignalStates.userId, userId), eq(alertSignalStates.instanceId, instanceIdValue))).run();
    tx.delete(tradeActions).where(and(eq(tradeActions.userId, userId), eq(tradeActions.instanceId, instanceIdValue))).run();
    tx.delete(codexAcpTraces).where(and(eq(codexAcpTraces.userId, userId), eq(codexAcpTraces.instanceId, instanceIdValue))).run();
    tx.delete(indicatorResults).where(and(eq(indicatorResults.userId, userId), eq(indicatorResults.instanceId, instanceIdValue))).run();
    tx.delete(alertRules).where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceIdValue))).run();
    tx.delete(sandboxAuditLogs).where(and(eq(sandboxAuditLogs.userId, userId), eq(sandboxAuditLogs.instanceId, instanceIdValue))).run();
    tx.delete(pendingSandboxConfirmations).where(and(eq(pendingSandboxConfirmations.userId, userId), eq(pendingSandboxConfirmations.instanceId, instanceIdValue))).run();
    tx.delete(conversationTasks).where(and(eq(conversationTasks.userId, userId), eq(conversationTasks.instanceId, instanceIdValue))).run();
    tx.delete(pushJobs).where(and(eq(pushJobs.userId, userId), eq(pushJobs.instanceId, instanceIdValue))).run();
    tx.delete(agentTraces).where(eq(agentTraces.userId, userId)).run();

    tx.delete(aiInstances).where(eq(aiInstances.id, instanceIdValue)).run();
    tx.delete(users).where(eq(users.id, userId)).run();
  });

  await rm(resolveWorkspacePath(userId), { recursive: true, force: true });

  return { userId, instanceId: instanceIdValue };
}

export async function ensureBuiltInAiProjects() {
  const now = new Date().toISOString();

  await db.insert(aiProjects).values({
    id: DEFAULT_PROJECT_ID,
    name: "投资助手",
    type: "investment-assistant",
    status: "active",
    description: "默认投资助手项目类型",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing();
}

export async function getProjectRuntimeContext(projectIdOrInstanceId: string): Promise<AiProjectRuntimeContext> {
  const rows = await db.select().from(aiInstances).where(eq(aiInstances.id, projectIdOrInstanceId)).limit(1);
  if (rows[0]) return runtimeContextFromInstance(rows[0]);
  throw new Error(`AI_PROJECT_NOT_FOUND:${projectIdOrInstanceId}`);
}

export async function listProjectRuntimeContexts(params: { ownerUserId?: string; includeArchived?: boolean } = {}): Promise<AiProjectRuntimeContext[]> {
  const rows = params.ownerUserId
    ? await db.select().from(aiInstances).where(eq(aiInstances.ownerUserId, params.ownerUserId)).orderBy(aiInstances.name)
    : await db.select().from(aiInstances).orderBy(aiInstances.name);
  return rows
    .filter((row) => params.includeArchived || row.status !== "archived")
    .map(runtimeContextFromInstance);
}
