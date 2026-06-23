import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { aiInstances, aiProjects, users } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import {
  DIET_RECOMMENDATION_DEFAULT_SKILL_BUNDLE_ID,
  DIET_RECOMMENDATION_PROJECT_TYPE_ID,
  getProjectTypeManifest,
  INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID,
  INVEST_AGENT_PROJECT_TYPE_ID,
  summarizeProjectTypeManifest,
  type ProjectTypeManifestSummary,
} from "./project-types.js";
import {
  INVEST_AGENT_MG_CUSTOM_SKILL_BUNDLE_ID,
  INVEST_AGENT_JR_IDEAL_SKILL_BUNDLE_ID,
  INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE_ID,
} from "./skill-bundles.js";
import type { SandboxPermission } from "../lib/sandbox-context.js";

export type AgentBackend = "codex" | "hermes";

export const DIET_RECOMMENDATION_PROJECT_ID = DIET_RECOMMENDATION_PROJECT_TYPE_ID;
export const DIET_RECOMMENDATION_SHARED_INSTANCE_ID = "diet-recommendation-shared";
export const INVEST_AGENT_JR_IDEAL_INSTANCE_ID = "invest-agent-jr-ideal";
const PLATFORM_OWNER_USER_ID = "platform";
const JR_IDEAL_OWNER_USER_ID = "jr-ideal-tester";

export interface AiProjectRuntimeContext {
  projectId: string;
  instanceId: string;
  legacyProjectId: string;
  projectType: string;
  projectTypeManifest: ProjectTypeManifestSummary;
  ownerUserId: string;
  name: string;
  status: string;
  backend: AgentBackend;
  skillBundleId: string;
  hermesProfile: string;
  permissions: SandboxPermission[];
  dashboardType: string;
  allowedTools: string[];
  resourceTypes: string[];
  config: Record<string, unknown>;
  strategySkillId?: string;
  instanceExpansionPath?: string;
}

function suffix(value: string) {
  return value.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || String(Date.now()).slice(-6);
}

function makeInstanceId(userId: string) {
  if (userId === DEFAULT_USER_ID) return DEFAULT_INSTANCE_ID;
  return `${DEFAULT_PROJECT_ID}-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function makeNamedInstanceId(projectType: string, userId: string) {
  return `${projectType}-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function parseBackend(value: string): AgentBackend {
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
  const manifest = getProjectTypeManifest(instance.projectId);
  const summary = summarizeProjectTypeManifest(manifest);
  const config = parseConfig(instance.config);
  return {
    projectId: instance.id,
    instanceId: instance.id,
    legacyProjectId: instance.projectId,
    projectType: manifest.id,
    projectTypeManifest: summary,
    ownerUserId: instance.ownerUserId,
    name: instance.name,
    status: instance.status,
    backend: parseBackend(instance.backend),
    skillBundleId: instance.skillBundleId || manifest.defaultSkillBundleId,
    hermesProfile: String(config.hermesProfile || manifest.defaultHermesProfile),
    permissions: [...manifest.defaultPermissions],
    dashboardType: manifest.dashboardType,
    allowedTools: [...manifest.allowedTools],
    resourceTypes: [...manifest.resourceTypes],
    config,
    strategySkillId: typeof config.strategySkillId === "string" ? String(config.strategySkillId) : undefined,
    instanceExpansionPath: typeof config.instanceExpansionPath === "string" ? String(config.instanceExpansionPath) : undefined,
  };
}

export async function ensureDefaultProjectForUser(
  userId: string,
  backend: AgentBackend = "hermes",
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

  return getProjectRuntimeContext(instanceId);
}

export async function createInvestAgentInstance(input: {
  userId: string;
  displayName: string;
  instanceName?: string;
  backend?: AgentBackend;
  skillBundleId?: string;
}) {
  const userId = input.userId.trim();
  if (!userId || !/^[a-zA-Z0-9_-]{2,64}$/.test(userId)) {
    throw new Error("INVALID_USER_ID");
  }
  const now = new Date().toISOString();
  const instanceId = makeNamedInstanceId(DEFAULT_PROJECT_ID, userId);
  const backend = input.backend || "hermes";
  const skillBundleId = input.skillBundleId?.trim() || INVEST_AGENT_DEFAULT_SKILL_BUNDLE_ID;
  const displayName = input.displayName.trim() || userId;

  await db.insert(users).values({
    id: userId,
    displayName,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: users.id,
    set: {
      displayName,
      status: "active",
      updatedAt: now,
    },
  });

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
    name: input.instanceName?.trim() || `${displayName}的投资助手`,
    status: "active",
    backend,
    skillBundleId,
    config: JSON.stringify({
      distributionMode: "dedicated",
      createdFrom: "platform",
    }),
    createdAt: now,
    updatedAt: now,
  });

  return getProjectRuntimeContext(instanceId);
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

  await db
    .update(aiInstances)
    .set({ skillBundleId: INVEST_AGENT_PRIMARY_CUSTOM_SKILL_BUNDLE_ID, updatedAt: now })
    .where(eq(aiInstances.id, DEFAULT_INSTANCE_ID));
}

export async function getProjectRuntimeContext(projectIdOrInstanceId: string): Promise<AiProjectRuntimeContext> {
  const rows = await db.select().from(aiInstances).where(eq(aiInstances.id, projectIdOrInstanceId)).limit(1);
  if (rows[0]) return runtimeContextFromInstance(rows[0]);
  throw new Error(`AI_PROJECT_NOT_FOUND:${projectIdOrInstanceId}`);
}

export async function listProjectRuntimeContexts(params: { ownerUserId?: string } = {}): Promise<AiProjectRuntimeContext[]> {
  const rows = params.ownerUserId
    ? await db.select().from(aiInstances).where(eq(aiInstances.ownerUserId, params.ownerUserId)).orderBy(aiInstances.name)
    : await db.select().from(aiInstances).orderBy(aiInstances.name);
  return rows.map(runtimeContextFromInstance);
}
