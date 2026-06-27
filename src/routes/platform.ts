import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { renderPlatformPage } from "../admin/platform-page.js";
import { db } from "../db/index.js";
import { alertRules, channelIdentities, channelIdentityInstances, codexAcpTraces, users } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { createInvestAgentInstance, deleteInvestAgentInstance, getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { disposeAcpForWorkspace, ensureHermesRuntimeForWorkspace } from "../acp/stdio-agent.js";

const projectWeixinManagers = new Map<string, WeixinMobileManager>();

function projectWeixinManager(project: AiProjectRuntimeContext) {
  const existing = projectWeixinManagers.get(project.instanceId);
  if (existing) return existing;
  const manager = new WeixinMobileManager({
    stateDir: path.join(config.weixin.stateDir, "project-weixin", project.instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")),
    label: `${project.name}微信`,
    projectBinding: {
      projectId: project.legacyProjectId,
      instanceId: project.instanceId,
      ownerUserId: project.ownerUserId,
      ownerDisplayName: project.name,
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

function deletePlatformWeixinManager(instanceId: string) {
  const manager = projectWeixinManagers.get(instanceId);
  if (!manager) return;
  try {
    manager.stop();
  } catch (error) {
    logger.warn(`Platform 项目微信监听停止失败: ${instanceId} ${(error as Error).message}`);
  }
  projectWeixinManagers.delete(instanceId);
}

function stableSuffix(value?: string | null) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
}

async function safePrivateAssetCount(label: string, project: AiProjectRuntimeContext, loader: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await loader()).length;
  } catch (error) {
    logger.warn(`Platform private asset count skipped label=${label} user=${project.ownerUserId} instance=${project.instanceId}: ${(error as Error).message}`);
    return 0;
  }
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

async function summarizeInstance(project: AiProjectRuntimeContext) {
  const [
    ownerRows,
    channelBindings,
    traceRows,
    recentTraceRows,
    holdingRows,
    watchlistRows,
    planRows,
    alertRuleRows,
  ] = await Promise.all([
    db.select({ id: users.id, displayName: users.displayName, status: users.status }).from(users).where(eq(users.id, project.ownerUserId)).limit(1),
    channelBindingsForProject(project),
    db.select({ count: count() }).from(codexAcpTraces).where(eq(codexAcpTraces.instanceId, project.instanceId)),
    db
      .select({
        id: codexAcpTraces.id,
        channel: codexAcpTraces.channel,
        mode: codexAcpTraces.mode,
        status: codexAcpTraces.status,
        userText: codexAcpTraces.userText,
        elapsedMs: codexAcpTraces.elapsedMs,
        createdAt: codexAcpTraces.createdAt,
      })
      .from(codexAcpTraces)
      .where(eq(codexAcpTraces.instanceId, project.instanceId))
      .orderBy(desc(codexAcpTraces.createdAt))
      .limit(5),
    safePrivateAssetCount("portfolio", project, () => portfolioBackend.listActive(project.ownerUserId, project.instanceId)),
    safePrivateAssetCount("watchlist", project, () => watchlistBackend.list(project.ownerUserId, project.instanceId)),
    safePrivateAssetCount("plan", project, () => planBackend.list(project.ownerUserId, project.instanceId)),
    db.select({ count: count() }).from(alertRules).where(and(eq(alertRules.userId, project.ownerUserId), eq(alertRules.instanceId, project.instanceId))),
  ]);

  const owner = ownerRows[0] || {
    id: project.ownerUserId,
    displayName: project.ownerUserId,
    status: "unknown",
  };
  const workspacePath = resolveWorkspacePath(project.ownerUserId);
  return {
    projectId: project.legacyProjectId,
    aiProjectId: project.projectId,
    instanceId: project.instanceId,
    name: project.name,
    projectType: project.projectType,
    owner,
    backend: project.backend,
    skillBundleId: project.skillBundleId,
    status: project.status,
    dashboardType: project.dashboardType,
    permissions: project.permissions,
    resourceTypes: project.resourceTypes,
    allowedTools: project.allowedTools,
    config: project.config,
    workspace: {
      path: workspacePath,
      exists: existsSync(workspacePath),
      identity: {
        userId: project.ownerUserId,
        tenantId: project.ownerUserId,
        projectId: project.projectId,
        instanceId: project.instanceId,
      },
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    channelBindingCount: channelBindings.length,
    channelBindings,
    traceCount: traceRows[0]?.count ?? 0,
    recentTraces: recentTraceRows,
    holdingCount: holdingRows,
    watchlistCount: watchlistRows,
    planCount: planRows,
    alertRuleCount: alertRuleRows[0]?.count ?? 0,
  };
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

  app.get("/api/platform/instances", safe(async () => {
    const projects = await listProjectRuntimeContexts();
    const instances = await Promise.all(projects.map(summarizeInstance));
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      count: instances.length,
      instances,
    };
  }));

  app.post<{ Body: { userId?: string; displayName?: string; instanceName?: string } }>("/api/platform/instances", safe(async (request, reply) => {
    const userId = request.body?.userId?.trim();
    if (!userId) {
      return reply.status(400).send({ ok: false, error: "userId 必填" });
    }
    try {
      const project = await createInvestAgentInstance({
        userId,
        displayName: request.body?.displayName,
        instanceName: request.body?.instanceName,
        backend: "hermes",
      });
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        instance: await summarizeInstance(project),
      };
    } catch (error) {
      if ((error as Error).message === "INVALID_USER_ID") {
        return reply.status(400).send({ ok: false, error: "userId 只能包含字母、数字、下划线和连字符，长度 2-64" });
      }
      throw error;
    }
  }));

  app.delete<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "实例不存在" });
    if (project.instanceId === "invest-agent-primary") {
      return reply.status(400).send({ ok: false, error: "主实例不能删除" });
    }
    deletePlatformWeixinManager(project.instanceId);
    const workspacePath = resolveWorkspacePath(project.ownerUserId);
    const disposedAcpCount = disposeAcpForWorkspace(workspacePath);
    const deleted = await deleteInvestAgentInstance(project.instanceId);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      disposedAcpCount,
      deleted,
    };
  }));

  app.get<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/status", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档", status: "removed" });
    return projectWeixinManager(project).getState();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/connect/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    return projectWeixinManager(project).startLogin();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/listener/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const manager = projectWeixinManager(project);
    await manager.ensureListenerStarted();
    return manager.getState();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/connect/stop", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "实例不存在" });
    const manager = projectWeixinManager(project);
    manager.stop();
    return manager.getState();
  }));

  app.post<{ Params: { instanceId: string }; Body: { message?: string } }>("/api/platform/instances/:instanceId/weixin/push/test", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const manager = projectWeixinManager(project);
    const text = request.body?.message?.trim() || `测试提醒：${project.name} ${new Date().toLocaleString("zh-CN")}`;
    const pushed = await manager.pushText(text, { userId: project.ownerUserId, instanceId: project.instanceId });
    if (!pushed) {
      return reply.status(409).send({
        ok: false,
        message: "当前没有可用的微信会话，请先让该实例绑定的微信给助手发送一条消息。",
        state: manager.getState(),
      });
    }
    return { ok: true, state: manager.getState() };
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/workspace/ensure", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const workspace = await ensureWorkspace({
      userId: project.ownerUserId,
      tenantId: project.ownerUserId,
      projectId: project.instanceId,
    });
    const hermesHome = await ensureHermesRuntimeForWorkspace(workspace.path);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      workspace,
      hermesHome,
      instance: await summarizeInstance(project),
    };
  }));
}
