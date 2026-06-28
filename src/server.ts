import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAgent } from "./acp/agent.js";
import type { AcpMessage, AcpResponse } from "./acp/protocol.js";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { listSchedulableScopes, registerPush, triggerScheduledMarketWatchNow, triggerScheduledReviewNow } from "./scheduler/index.js";
import { listAcpBackends } from "./acp/stdio-agent.js";
import { renderWeixinAdminPage } from "./admin/weixin-page.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import { autoStartPlatformWeixinListeners, projectWeixinManagerForInstance, registerPlatformRoutes } from "./routes/platform.js";
import { ensureBuiltInIndicatorDefinitions } from "./handlers/indicator-definitions.js";
import { syncAllLegacyAlertsToAlertRules } from "./handlers/alert-rules.js";
import { enqueuePushJob, getPushJob, getPushQueueSummary, processDuePushJobs, type PushBackend } from "./services/push-queue.js";
import { ensureBuiltInAiProjects } from "./platform/project-registry.js";
import { instanceIdFromRequest, userIdFromRequest } from "./lib/user-context.js";
import { db } from "./db/index.js";
import { codexAcpTraces, pushJobs, scheduledTaskRuns } from "./db/schema.js";
import { and, desc, eq } from "drizzle-orm";

const agent = createAgent();

/** 待推送消息队列（OpenClaw 轮询取走） */
let pendingAlerts: string[] = [];
let pushQueueInterval: ReturnType<typeof setInterval> | null = null;

async function sendPushJob(job: { userId: string; backend: PushBackend; message: string; instanceId?: string }) {
  if (job.instanceId) {
    try {
      const projectManager = await projectWeixinManagerForInstance(job.instanceId);
      const pushed = await projectManager.pushText(job.message, { userId: job.userId, instanceId: job.instanceId });
      if (pushed) return true;
    } catch (error) {
      logger.warn(`项目实例微信推送失败，尝试全局通道: ${(error as Error).message}`);
    }
  }
  return weixinMobileManager.pushText(job.message, { userId: job.userId, instanceId: job.instanceId });
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

export async function createServer() {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await ensureBuiltInAiProjects();
  await ensureBuiltInIndicatorDefinitions();
  await syncAllLegacyAlertsToAlertRules();

  registerDashboardRoutes(app);
  registerSandboxRoutes(app);
  registerPlatformRoutes(app);

  startPushQueueWorker();

  // 注册推送回调：调度器产出的提醒进入可靠推送队列
  registerPush(async (message: string, options?: { userId?: string; projectId?: string; instanceId?: string }) => {
    const job = await enqueuePushJob({
      userId: options?.userId,
      backend: "hermes",
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
    const { backends } = await listAcpBackends();
    return {
      status: "ok",
      agent: agent.agentName,
      agentId: agent.agentId,
      capabilities: agent.capabilities,
      acpBackends: { backends },
      hermesAcp: backends.find((b) => b.id === "hermes") ?? null,
      pendingAlerts: pendingAlerts.length,
      pushQueue: await getPushQueueSummary(),
      timestamp: new Date().toISOString(),
    };
  });

  // 旧微信管理页重定向到统一 Dashboard
  app.get("/admin/weixin", async (_request, reply) => {
    reply.statusCode = 301;
    return reply.redirect("/dashboard");
  });

  app.get("/api/weixin/status", async () => weixinMobileManager.getState());

  app.post("/api/weixin/connect/start", async () => weixinMobileManager.startLogin());

  app.post("/api/weixin/listener/start", async () => {
    await weixinMobileManager.ensureListenerStarted();
    return weixinMobileManager.getState();
  });

  app.post("/api/weixin/connect/stop", async () => {
    weixinMobileManager.stop();
    return weixinMobileManager.getState();
  });

  app.post<{ Body: { message?: string } }>("/api/weixin/push/test", async (request, reply) => {
    const text = request.body?.message?.trim() || `测试提醒：${new Date().toLocaleString("zh-CN")}`;
    try {
      const pushed = await weixinMobileManager.pushText(text);
      if (!pushed) {
        return reply.status(409).send({
          ok: false,
          message: "当前没有可用的微信会话，请先让客户微信给助手发送一条消息。",
          state: weixinMobileManager.getState(),
        });
      }
      return { ok: true, state: weixinMobileManager.getState() };
    } catch (error) {
      logger.warn(`测试微信推送失败: ${(error as Error).message}`);
      return reply.status(500).send({
        ok: false,
        message: (error as Error).message,
        state: weixinMobileManager.getState(),
      });
    }
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
  app.post<{ Body: { message: string; userId?: string; workspacePath?: string; channel?: "weixin-mobile" | "dashboard" | "api" } }>(
    "/api/chat",
    async (request, reply) => {
      const { message, userId, workspacePath, channel } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

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
        ...(userId || resolvedWorkspacePath || channel
          ? {
              context: {
                userId: userId || "test",
                ...(resolvedWorkspacePath ? { workspacePath: resolvedWorkspacePath } : {}),
                ...(channel ? { channel } : {}),
              },
            }
          : {}),
      };

      const response = await agent.handleMessage(acpMessage);
      return response;
    }
  );

  app.post<{ Body: { message?: string; conversationId?: string; instanceId?: string; accountId?: string; contextToken?: string } }>(
    "/api/testing/weixin-simulate",
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.status(400).send({ ok: false, error: "message is required" });
      }
      const conversationId = request.body?.conversationId?.trim() || `sim-weixin-${Date.now()}`;
      const instanceId = request.body?.instanceId?.trim();
      const manager = instanceId
        ? await projectWeixinManagerForInstance(instanceId)
        : weixinMobileManager;
      const startedAt = Date.now();
      const response = await manager.simulateIncomingText({
        text: message,
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
    await app.listen({ port: config.port, host: "0.0.0.0" });
    logger.info(
      `🚀 ${agent.agentName} 启动成功 — http://0.0.0.0:${config.port}`
    );
    logger.info(`健康检查: http://localhost:${config.port}/health`);
    logger.info(`ACP 端点: http://localhost:${config.port}/acp/message`);
    logger.info(`提醒轮询: http://localhost:${config.port}/acp/alerts`);
    logger.info(`微信连接后台: http://localhost:${config.port}/admin/weixin`);
    logger.info(`数据看板: http://localhost:${config.port}/dashboard`);
    logger.info(`平台实例管理: http://localhost:${config.port}/platform`);

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
