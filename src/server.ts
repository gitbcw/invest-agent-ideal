import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAgent } from "./acp/agent.js";
import type { AcpMessage, AcpResponse } from "./acp/protocol.js";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { listSchedulableScopes, registerPush, triggerScheduledMarketWatchNow, triggerScheduledReviewNow } from "./scheduler/index.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import { registerWatchRuleRoutes } from "./routes/watch-rules.js";
import { assertPlatformPartnerKeySafety, autoStartPlatformWeixinListeners, projectWeixinManagerForInstance, registerPlatformRoutes } from "./routes/platform.js";
import { ensureBuiltInIndicatorDefinitions } from "./handlers/indicator-definitions.js";
import { enqueuePushJob, getPushJob, getPushQueueSummary, processDuePushJobs, type PushBackend } from "./services/push-queue.js";
import type { WeixinDeliveryResult } from "./services/weixin-delivery.js";
import { ensureBuiltInAiProjects } from "./platform/project-registry.js";
import { instanceIdFromRequest, userIdFromRequest } from "./lib/user-context.js";
import { db } from "./db/index.js";
import { codexAcpTraces, pushJobs, scheduledTaskRuns } from "./db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { assertServiceAuthConfiguration, hasServiceApiAuthorization, isPublicServicePath, isSandboxPath } from "./lib/service-auth.js";
import { hasPlatformSession, isLoopbackAddress } from "./lib/platform-session.js";
import { hasPersistentPlatformSession } from "./lib/platform-auth.js";
import { consumeRequestRateLimit } from "./lib/request-rate-limit.js";

const agent = createAgent();

/** 待推送消息队列（OpenClaw 轮询取走） */
let pendingAlerts: string[] = [];
let pushQueueInterval: ReturnType<typeof setInterval> | null = null;

function isOfflineMode() {
  return process.env.INVEST_AGENT_OFFLINE_MODE === "true";
}

async function sendPushJob(job: { userId: string; backend: PushBackend; message: string; instanceId?: string }): Promise<WeixinDeliveryResult> {
  if (isOfflineMode()) {
    return { ok: false, reason: "wechat_api_error", errorMessage: "offline mode blocks external delivery" };
  }
  if (job.instanceId) {
    try {
      const projectManager = await projectWeixinManagerForInstance(job.instanceId);
      const projectResult = await projectManager.pushTextDetailed(job.message, { userId: job.userId, instanceId: job.instanceId });
      if (projectResult.ok) return projectResult;
      return projectResult;
    } catch (error) {
      logger.warn(`项目实例微信推送失败，尝试全局通道: ${(error as Error).message}`);
    }
  }
  return weixinMobileManager.pushTextDetailed(job.message, { userId: job.userId, instanceId: job.instanceId });
}

function startPushQueueWorker() {
  if (pushQueueInterval) return;
  const tick = () => {
    processDuePushJobs(sendPushJob).catch((error) => {
      logger.warn(`推送队列处理失败: ${(error as Error).message}`);
    });
  };
  pushQueueInterval = setInterval(tick, 30 * 1000);
  tick();
}

export function stopPushQueueWorker() {
  if (!pushQueueInterval) return;
  clearInterval(pushQueueInterval);
  pushQueueInterval = null;
}

export async function createServer() {
  assertServiceAuthConfiguration();
  const app = Fastify({ logger: false, bodyLimit: Number(process.env.INVEST_AGENT_MAX_REQUEST_BYTES) || 60 * 1024 * 1024 });

  await app.register(cors, { origin: false });
  app.addHook("onClose", async () => {
    stopPushQueueWorker();
  });
  (app as any).routeInventory = [];
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      (app as any).routeInventory.push({ method: String(method).toUpperCase(), url: route.url });
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = request.url.split("?")[0];
    // The page shell is public so remote Partner users can reach the login form.
    // Data APIs remain protected by persistent account sessions below.
    const platformPageRequest = requestPath === "/platform";
    const platformLoginRequest = requestPath === "/api/platform/auth/login";
    if (isPublicServicePath(request.url) || platformLoginRequest || platformPageRequest) return;
    const sandboxRequest = isSandboxPath(request.url);
    const platformSessionRequest = requestPath.startsWith("/api/platform/") && isLoopbackAddress(request.ip) && hasPlatformSession(request.headers.cookie);
    const platformAuthRequest = requestPath.startsWith("/api/platform/") && await hasPersistentPlatformSession(request.headers.cookie);
    if (!sandboxRequest && !platformSessionRequest && !platformAuthRequest && !hasServiceApiAuthorization(request.headers)) {
      return reply
        .header("www-authenticate", "Basic realm=\"Invest Agent Local API\"")
        .status(401)
        .send({ ok: false, error: "service api authorization required" });
    }
    const clientKey = `${request.ip}:${request.url.split("?")[0]}`;
    const limit = request.url.startsWith("/acp/message") ? 30 : 120;
    const result = consumeRequestRateLimit({ key: clientKey, max: limit, windowMs: 60_000 });
    if (!result.allowed) {
      return reply.header("retry-after", String(result.retryAfterSeconds)).status(429).send({ ok: false, error: "rate limit exceeded" });
    }
  });
  await ensureBuiltInAiProjects();
  await ensureBuiltInIndicatorDefinitions();
  await assertPlatformPartnerKeySafety();

  registerPortalRoutes(app);
  registerSandboxRoutes(app);
  registerPlatformRoutes(app);
  registerWatchRuleRoutes(app);

  if (!isOfflineMode()) startPushQueueWorker();

  // 注册推送回调：调度器产出的提醒进入可靠推送队列
  registerPush(async (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => {
    const job = await enqueuePushJob({
      userId: options?.userId,
      backend: config.acp.backend,
      projectId: options?.projectId,
      instanceId: options?.instanceId,
      source: "scheduler",
      message,
    });
    logger.info(`提醒已进入推送队列 job=${job.id} user=${job.userId} backend=${job.backend}`);
    await processDuePushJobs(sendPushJob, { limit: 5 });
    return job.id;
  });

  // 健康检查
  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  // 旧微信管理页重定向到 Platform 实例入口(Dashboard 退役前过渡兼容)
  app.get("/admin/weixin", async (_request, reply) => {
    reply.statusCode = 301;
    return reply.redirect("/platform#instances");
  });

  // Dashboard 已退役,旧入口 301 到 Platform;兼容期结束后移除该路由
  app.get("/dashboard", async (_request, reply) => {
    reply.statusCode = 301;
    return reply.redirect("/platform");
  });

  app.post("/api/alerts/mock-and-push", async () => {
    const text = [
      "⏰ 行情提醒",
      "",
      "【测试】",
      "  测试标的(000000) 触发模拟提醒，现价 10.00",
      "  与昨晚预案关系: 测试消息，不写入真实提醒记录",
      "  风险提示: 该消息仅用于验证提醒推送链路",
    ].join("\n");
    const pushed = await weixinMobileManager.pushText(text);
    return {
      ok: pushed,
      pushed,
      text,
      state: weixinMobileManager.getState(),
    };
  });

  // ACP Agent 信息（OpenClaw 发现用）
  app.get("/.well-known/agent.json", async () => ({
    agent_id: agent.agentId,
    name: agent.agentName,
    description: "A 股投资选股智能助手，支持选股分析、持仓管理、复盘提醒",
    capabilities: agent.capabilities,
    protocol: "acp-1.0",
    endpoint: `/acp/message`,
  }));

  // ACP 消息端点 — OpenClaw 转发微信消息到这里
  app.post<{ Body: AcpMessage }>(
    "/acp/message",
    async (request, reply): Promise<AcpResponse> => {
      const message = request.body;
      logger.info(`ACP 收到消息 from=${message.from}`);
      return agent.handleMessage(message);
    }
  );

  // 待推送提醒 — OpenClaw 轮询取走
  app.get("/acp/alerts", async () => {
    const alerts = [...pendingAlerts];
    pendingAlerts = [];
    return { alerts };
  });

  // 简单测试端点（不经过 ACP，直接对话）
  app.post<{ Body: { message: string; userId?: string; workspacePath?: string; channel?: "weixin-mobile" | "api" } }>(
    "/api/chat",
    async (request, reply) => {
      const { message, userId, workspacePath, channel } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }
      const normalizedChannel: "weixin-mobile" | "api" = channel === "weixin-mobile" ? "weixin-mobile" : "api";

      let resolvedWorkspacePath = workspacePath;
      if (!resolvedWorkspacePath && userId) {
        const { ensureWorkspace } = await import("./lib/workspace.js");
        const resolved = await ensureWorkspace({ userId, projectId: "invest-agent" });
        resolvedWorkspacePath = resolved.path;
      }

      const acpMessage: AcpMessage = {
        id: `test-${Date.now()}`,
        from: userId || "test",
        timestamp: Date.now(),
        content: { type: "text", text: message },
        ...(userId || resolvedWorkspacePath || normalizedChannel
          ? {
              context: {
                userId: userId || "test",
                ...(resolvedWorkspacePath ? { workspacePath: resolvedWorkspacePath } : {}),
                ...(normalizedChannel ? { channel: normalizedChannel } : {}),
              },
            }
          : {}),
      };

      const response = await agent.handleMessage(acpMessage);
      return response;
    }
  );

  app.post<{ Body: {
    message?: string;
    conversationId?: string;
    instanceId?: string;
    accountId?: string;
    contextToken?: string;
    media?: {
      type?: "image" | "audio" | "video" | "file";
      filePath?: string;
      mimeType?: string;
      fileName?: string;
    };
  } }>(
    "/api/testing/weixin-simulate",
    async (request, reply) => {
      const message = request.body?.message?.trim();
      const media = request.body?.media;
      if (!message && !media) return reply.status(400).send({ ok: false, error: "message or media is required" });
      if (media && (!media.type || !media.filePath || !media.mimeType)) {
        return reply.status(400).send({ ok: false, error: "media.type, media.filePath and media.mimeType are required" });
      }
      const conversationId = request.body?.conversationId?.trim() || `sim-weixin-${Date.now()}`;
      const instanceId = request.body?.instanceId?.trim();
      const manager = instanceId
        ? await projectWeixinManagerForInstance(instanceId)
        : weixinMobileManager;
      const startedAt = Date.now();
      const response = media
        ? await manager.simulateIncomingMedia({
            text: message,
            conversationId,
            accountId: request.body?.accountId,
            contextToken: request.body?.contextToken,
            media: {
              type: media.type!,
              filePath: media.filePath!,
              mimeType: media.mimeType!,
              fileName: media.fileName,
            },
          })
        : await manager.simulateIncomingText({
            text: message!,
            conversationId,
            accountId: request.body?.accountId,
            contextToken: request.body?.contextToken,
          });
      return {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        conversationId: response.conversationId,
        accountId: response.accountId,
        text: response.text,
      };
    }
  );

  // 手动触发巡检（测试用）
  app.post<{ Body: { userId?: string; instanceId?: string } }>("/api/alerts/check", async (request) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const { runAlertCheck, formatAlerts } = await import(
      "./scheduler/alert-check.js"
    );
    const items = await runAlertCheck({ userId, instanceId });
    return {
      userId,
      instanceId,
      count: items.length,
      alerts: items,
      text: items.length > 0 ? formatAlerts(items) : "当前无提醒",
    };
  });

  app.post<{ Body: { userId?: string; instanceId?: string } }>("/api/alerts/check-and-push", async (request) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const { runAlertCheck, formatAlerts } = await import(
      "./scheduler/alert-check.js"
    );
    const items = await runAlertCheck({ force: true, userId, instanceId });
    const text = items.length > 0 ? formatAlerts(items) : "当前强制巡检完成：没有触发提醒。";
    let pushed = false;
    let pushJobId: string | undefined;
    if (items.length > 0) {
      const job = await enqueuePushJob({
        userId,
        instanceId,
        backend: "hermes",
        source: "manual-alert-check",
        message: text,
      });
      pushJobId = job.id;
      await processDuePushJobs(sendPushJob, { limit: 5 });
      const updated = await getPushJob(job.id);
      pushed = updated?.status === "sent";
    }
    return {
      userId,
      instanceId,
      count: items.length,
      pushed,
      pushJobId,
      alerts: items,
      text,
      state: weixinMobileManager.getState(),
    };
  });

  app.get("/api/testing/scheduler/scopes", async () => {
    return {
      scopes: await listSchedulableScopes(),
    };
  });

  app.post<{
    Body: {
      task: "daily-review" | "weekly-review" | "monthly-review" | "market-watch";
      userId?: string;
      instanceId?: string;
      manualReason?: string;
      now?: string;
    };
  }>("/api/testing/scheduler/trigger", async (request, reply) => {
    const task = request.body?.task;
    if (!task) {
      return reply.status(400).send({ ok: false, error: "task is required" });
    }
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const now = request.body?.now ? new Date(request.body.now) : new Date();
    if (Number.isNaN(now.getTime())) {
      return reply.status(400).send({ ok: false, error: "now must be a valid ISO datetime" });
    }
    const manualReason = request.body?.manualReason?.trim() || "manual-acceptance";

    const scope = { userId, instanceId };
    const result = task === "market-watch"
      ? await triggerScheduledMarketWatchNow(scope, now, { manualReason })
      : await triggerScheduledReviewNow(task.replace("-review", "") as "daily" | "weekly" | "monthly", scope, now, { manualReason });

    const [taskRun] = await db
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskKey, result.taskKey))
      .limit(1);

    const [trace] = await db
      .select()
      .from(codexAcpTraces)
      .where(and(
        eq(codexAcpTraces.userId, userId),
        eq(codexAcpTraces.instanceId, instanceId),
        eq(codexAcpTraces.conversationId, `scheduler:${task === "market-watch" ? "market-watch" : `${task.replace("-review", "")}-review`}:${userId}:${instanceId}`),
      ))
      .orderBy(desc(codexAcpTraces.createdAt))
      .limit(1);

    const [pushJob] = result.pushJobId
      ? await db.select().from(pushJobs).where(eq(pushJobs.id, result.pushJobId)).limit(1)
      : [];

    return {
      ok: true,
      task,
      userId,
      instanceId,
      manualReason,
      now: now.toISOString(),
      skipped: result.skipped,
      taskKey: result.taskKey,
      pushJobId: result.pushJobId,
      taskRun,
      trace,
      pushJob,
    };
  });

  return app;
}

export async function startServer() {
  const app = await createServer();

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(
      `🚀 ${agent.agentName} 启动成功 — http://${config.host}:${config.port}`
    );
    logger.info(`健康检查: http://localhost:${config.port}/health`);
    logger.info(`ACP 端点: http://localhost:${config.port}/acp/message`);
    logger.info(`提醒轮询: http://localhost:${config.port}/acp/alerts`);
    logger.info(`平台管理: http://localhost:${config.port}/platform`);

    if (process.env.WEIXIN_AUTO_START !== "false" && weixinMobileManager.getState().stage === "connected") {
      weixinMobileManager.ensureListenerStarted().catch((error) => {
        logger.warn(`微信监听自动启动失败: ${(error as Error).message}`);
      });
    }
    autoStartPlatformWeixinListeners().catch((error) => {
      logger.warn(`Platform 项目微信监听自动恢复失败: ${(error as Error).message}`);
    });
  } catch (error) {
    logger.error("启动失败:", error);
    process.exit(1);
  }

  return app;
}
