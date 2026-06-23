import type { FastifyInstance } from "fastify";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { renderPlatformPage } from "../admin/platform-page.js";
import { db } from "../db/index.js";
import { channelIdentities, channelIdentityInstances, codexAcpTraces, pushJobs, sandboxAuditLogs, users } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { createInvestAgentInstance, getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { listSkillBundles, summarizeSkillBundle } from "../platform/skill-bundles.js";
import { listToolDefinitions } from "../platform/tool-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";

type CountMap = Record<string, number>;
const projectWeixinManagers = new Map<string, WeixinMobileManager>();

function toCountMap(rows: Array<{ status: string; count: number }>): CountMap {
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function stableSuffix(value: string) {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 10);
}

async function channelBindingsForProject(project: AiProjectRuntimeContext) {
  const bindings = await db
    .select({
      id: channelIdentityInstances.id,
      channelIdentityId: channelIdentityInstances.channelIdentityId,
      userId: channelIdentities.userId,
      userDisplayName: users.displayName,
      channel: channelIdentities.channel,
      backend: channelIdentities.backend,
      externalAccountId: channelIdentities.externalAccountId,
      externalUserId: channelIdentities.externalUserId,
      isDefault: channelIdentityInstances.isDefault,
      updatedAt: channelIdentities.updatedAt,
    })
    .from(channelIdentityInstances)
    .innerJoin(channelIdentities, eq(channelIdentityInstances.channelIdentityId, channelIdentities.id))
    .leftJoin(users, eq(channelIdentities.userId, users.id))
    .where(eq(channelIdentityInstances.instanceId, project.instanceId))
    .orderBy(desc(channelIdentities.updatedAt));

  return bindings.map((binding) => ({
    id: binding.id,
    channelIdentityId: binding.channelIdentityId,
    userId: binding.userId,
    userDisplayName: binding.userDisplayName,
    channel: binding.channel,
    backend: binding.backend,
    externalAccountId: binding.externalAccountId,
    externalUserIdSuffix: stableSuffix(binding.externalUserId),
    isDefault: binding.isDefault,
    updatedAt: binding.updatedAt,
  }));
}

async function summarizeProject(project: AiProjectRuntimeContext) {
  const [ownerRows, channelBindings, traceRows, recentTraceRows, pushRows, auditRows, recentAuditRows] = await Promise.all([
    db.select({ id: users.id, displayName: users.displayName, status: users.status }).from(users).where(eq(users.id, project.ownerUserId)).limit(1),
    channelBindingsForProject(project),
    db.select({ count: count() }).from(codexAcpTraces).where(eq(codexAcpTraces.instanceId, project.instanceId)),
    db
      .select({
        id: codexAcpTraces.id,
        channel: codexAcpTraces.channel,
        mode: codexAcpTraces.mode,
        status: codexAcpTraces.status,
        elapsedMs: codexAcpTraces.elapsedMs,
        sandboxTokenId: codexAcpTraces.sandboxTokenId,
        createdAt: codexAcpTraces.createdAt,
      })
      .from(codexAcpTraces)
      .where(eq(codexAcpTraces.instanceId, project.instanceId))
      .orderBy(desc(codexAcpTraces.createdAt))
      .limit(5),
    db
      .select({ status: pushJobs.status, count: count() })
      .from(pushJobs)
      .where(eq(pushJobs.instanceId, project.instanceId))
      .groupBy(pushJobs.status),
    db
      .select({ status: sandboxAuditLogs.status, count: count() })
      .from(sandboxAuditLogs)
      .where(eq(sandboxAuditLogs.instanceId, project.instanceId))
      .groupBy(sandboxAuditLogs.status),
    db
      .select({
        id: sandboxAuditLogs.id,
        operation: sandboxAuditLogs.operation,
        resourceType: sandboxAuditLogs.resourceType,
        status: sandboxAuditLogs.status,
        createdAt: sandboxAuditLogs.createdAt,
      })
      .from(sandboxAuditLogs)
      .where(eq(sandboxAuditLogs.instanceId, project.instanceId))
      .orderBy(desc(sandboxAuditLogs.createdAt))
      .limit(5),
  ]);

  const owner = ownerRows[0] || {
    id: project.ownerUserId,
    displayName: project.ownerUserId,
    status: "unknown",
  };

  return {
    projectId: project.projectId,
    instanceId: project.instanceId,
    legacyProjectId: project.legacyProjectId,
    name: project.name,
    projectType: project.projectType,
    projectTypeManifest: project.projectTypeManifest,
    owner,
    backend: project.backend,
    skillBundleId: project.skillBundleId,
    skillBundle: summarizeSkillBundle(project.skillBundleId),
    hermesProfile: project.hermesProfile,
    status: project.status,
    dashboardType: project.dashboardType,
    channelBindings,
    recentTraceCount: traceRows[0]?.count ?? 0,
    recentTraces: recentTraceRows,
    pushQueueSummary: toCountMap(pushRows),
    auditSummary: toCountMap(auditRows),
    recentAuditLogs: recentAuditRows,
    allowedTools: project.allowedTools,
    permissions: project.permissions,
    resourceTypes: project.resourceTypes,
  };
}

function projectWeixinManager(project: AiProjectRuntimeContext) {
  const existing = projectWeixinManagers.get(project.instanceId);
  if (existing) return existing;
  const manager = new WeixinMobileManager({
    backend: project.backend,
    stateDir: path.join(config.weixin.stateDir, "project-weixin", project.instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")),
    label: `${project.name}微信`,
    projectBinding: {
      projectId: project.legacyProjectId,
      instanceId: project.instanceId,
      ownerUserId: project.ownerUserId,
      ownerDisplayName: project.name,
      hermesProfile: project.hermesProfile,
      sharedUsers: project.projectType !== "invest-agent",
    },
  });
  projectWeixinManagers.set(project.instanceId, manager);
  return manager;
}

export async function projectWeixinManagerForInstance(instanceId: string) {
  const project = await getProjectRuntimeContext(instanceId);
  return projectWeixinManager(project);
}

export async function autoStartPlatformWeixinListeners() {
  if (process.env.PLATFORM_WEIXIN_AUTO_START === "false") {
    logger.info("Platform 项目微信监听自动恢复已关闭");
    return;
  }

  const projects = await listProjectRuntimeContexts();
  let startedProjects = 0;
  for (const project of projects) {
    const manager = projectWeixinManager(project);
    const state = manager.getState();
    if (!state.accounts?.length) {
      continue;
    }
    try {
      await manager.ensureListenerStarted();
      startedProjects += 1;
      logger.info(`Platform 项目微信监听已恢复: ${project.instanceId} accounts=${state.accounts.length}`);
    } catch (error) {
      logger.warn(`Platform 项目微信监听恢复失败: ${project.instanceId} ${(error as Error).message}`);
    }
  }
  logger.info(`Platform 项目微信监听自动恢复完成: projects=${startedProjects}`);
}

export function stopPlatformWeixinListeners() {
  for (const [instanceId, manager] of projectWeixinManagers.entries()) {
    try {
      manager.stop();
    } catch (error) {
      logger.warn(`Platform 项目微信监听停止失败: ${instanceId} ${(error as Error).message}`);
    }
  }
}

export function registerPlatformRoutes(app: FastifyInstance) {
  const safe = (handler: (request: any, reply: any) => Promise<any>) =>
    async (request: any, reply: any) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logger.error("Platform API 操作失败:", error);
        return reply.status(500).send({ ok: false, error: "平台接口操作失败" });
      }
    };

  app.get("/platform", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderPlatformPage());
  });

  app.get("/api/platform/projects", safe(async () => {
    const projects = await listProjectRuntimeContexts();
    const summaries = await Promise.all(projects.map(summarizeProject));
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      count: summaries.length,
      projects: summaries,
    };
  }));

  app.get("/api/platform/tools", safe(async () => ({
    ok: true,
    updatedAt: new Date().toISOString(),
    tools: listToolDefinitions(),
  })));

  app.get<{ Querystring: { projectType?: string } }>("/api/platform/skill-bundles", safe(async (request) => ({
    ok: true,
    updatedAt: new Date().toISOString(),
    bundles: listSkillBundles(request.query.projectType),
  })));

  app.post<{ Body: { userId?: string; displayName?: string; instanceName?: string; backend?: "codex" | "hermes"; skillBundleId?: string } }>("/api/platform/projects/invest-agent/instances", safe(async (request, reply) => {
    const userId = request.body?.userId?.trim();
    const displayName = request.body?.displayName?.trim();
    if (!userId || !displayName) {
      return reply.status(400).send({ ok: false, error: "userId 和 displayName 必填" });
    }
    try {
      const project = await createInvestAgentInstance({
        userId,
        displayName,
        instanceName: request.body?.instanceName,
        backend: request.body?.backend || "hermes",
        skillBundleId: request.body?.skillBundleId,
      });
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        project: await summarizeProject(project),
      };
    } catch (error) {
      if ((error as Error).message === "INVALID_USER_ID") {
        return reply.status(400).send({ ok: false, error: "userId 只能包含字母、数字、下划线和连字符，长度 2-64" });
      }
      if ((error as Error).message.includes("UNIQUE")) {
        return reply.status(409).send({ ok: false, error: "该用户的投资助手实例已存在" });
      }
      throw error;
    }
  }));

  app.get<{ Params: { projectId: string } }>("/api/platform/projects/:projectId/weixin/status", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.projectId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "PROJECT_NOT_FOUND", status: "removed" });
    return projectWeixinManager(project).getState();
  }));

  app.post<{ Params: { projectId: string } }>("/api/platform/projects/:projectId/weixin/connect/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.projectId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "PROJECT_NOT_FOUND" });
    return projectWeixinManager(project).startLogin();
  }));

  app.post<{ Params: { projectId: string } }>("/api/platform/projects/:projectId/weixin/listener/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.projectId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "PROJECT_NOT_FOUND" });
    const manager = projectWeixinManager(project);
    await manager.ensureListenerStarted();
    return manager.getState();
  }));

  app.post<{ Params: { projectId: string } }>("/api/platform/projects/:projectId/weixin/connect/stop", safe(async (request) => {
    const project = await getProjectRuntimeContext(request.params.projectId);
    const manager = projectWeixinManager(project);
    manager.stop();
    return manager.getState();
  }));

  app.get<{ Params: { traceId: string } }>("/api/platform/traces/:traceId", safe(async (request, reply) => {
    const traceId = Number(request.params.traceId);
    if (!Number.isInteger(traceId) || traceId <= 0) {
      return reply.status(400).send({ ok: false, error: "traceId 无效" });
    }

    const rows = await db
      .select()
      .from(codexAcpTraces)
      .where(eq(codexAcpTraces.id, traceId))
      .limit(1);

    if (rows.length === 0) {
      return reply.status(404).send({ ok: false, error: "trace 不存在" });
    }

    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      trace: rows[0],
    };
  }));

  app.get<{ Params: { projectId: string } }>("/api/platform/projects/:projectId", safe(async (request, reply) => {
    let project: AiProjectRuntimeContext;
    try {
      project = await getProjectRuntimeContext(request.params.projectId);
    } catch {
      return reply.status(404).send({ ok: false, error: "AI 项目不存在" });
    }

    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      project: await summarizeProject(project),
    };
  }));
}
