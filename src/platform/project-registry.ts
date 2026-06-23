import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { aiInstances, aiProjects, users } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import type { SandboxPermission } from "../lib/sandbox-context.js";

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
  backend: "codex" | "hermes";
  skillBundleId: string;
  hermesProfile: string;
  permissions: SandboxPermission[];
  dashboardType: string;
  allowedTools: readonly string[];
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

function parseBackend(value: string): "codex" | "hermes" {
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
    hermesProfile: String(config.hermesProfile || "invest-agent"),
    permissions: [...DEFAULT_SANDBOX_PERMISSIONS],
    dashboardType: "invest-agent",
    allowedTools: ALLOWED_SANDBOX_TOOLS,
    resourceTypes: [...DEFAULT_RESOURCE_TYPES],
    config,
    strategySkillId: typeof config.strategySkillId === "string" ? String(config.strategySkillId) : undefined,
    instanceExpansionPath: typeof config.instanceExpansionPath === "string" ? String(config.instanceExpansionPath) : undefined,
  };
}

export async function ensureDefaultProjectForUser(
  userId: string,
  backend: "codex" | "hermes" = "hermes",
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

export async function listProjectRuntimeContexts(params: { ownerUserId?: string } = {}): Promise<AiProjectRuntimeContext[]> {
  const rows = params.ownerUserId
    ? await db.select().from(aiInstances).where(eq(aiInstances.ownerUserId, params.ownerUserId)).orderBy(aiInstances.name)
    : await db.select().from(aiInstances).orderBy(aiInstances.name);
  return rows.map(runtimeContextFromInstance);
}
