import path from "node:path";
import { db } from "../db/index.js";
import { logger } from "../lib/logger.js";
import { getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";

const projectWeixinManagers = new Map<string, WeixinMobileManager>();

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
