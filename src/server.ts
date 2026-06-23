import Fastify from "fastify";
import cors from "@fastify/cors";
import { createAgent } from "./acp/agent.js";
import type { AcpMessage, AcpResponse } from "./acp/protocol.js";
import { textResponse } from "./acp/protocol.js";
import { config } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { registerPush } from "./scheduler/index.js";
import { getCodexAcpStatus } from "./acp/codex-stdio-agent.js";
import { listAcpBackends } from "./acp/stdio-agent.js";
import { getHermesAcpStatus, hermesStdioAcpAgent } from "./acp/hermes-stdio-agent.js";
import { renderWeixinAdminPage } from "./admin/weixin-page.js";
import { dietWeixinMobileManager, hermesWeixinMobileManager, weixinMobileManager } from "./channels/weixin-mobile.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import { autoStartPlatformWeixinListeners, projectWeixinManagerForInstance, registerPlatformRoutes, stopPlatformWeixinListeners } from "./routes/platform.js";
import { ensureBuiltInIndicatorDefinitions } from "./handlers/indicator-definitions.js";
import { syncAllLegacyAlertsToAlertRules } from "./handlers/alert-rules.js";
import { randomUUID } from "node:crypto";
import { buildDailyReviewContext } from "./handlers/review.js";
import { buildAcpPromptContext } from "./acp/prompt-context-builder.js";
import { sanitizeCustomerText } from "./lib/customer-output.js";
import { DEFAULT_USER_ID, instanceIdFromRequest, normalizeUserId, userIdFromRequest } from "./lib/user-context.js";
import { handleAiIntentDraftTurn, handlePendingConversationTaskTurn } from "./lib/conversation-tasks.js";
import { enqueuePushJob, getPushJob, getPushQueueSummary, processDuePushJobs, type PushBackend } from "./services/push-queue.js";
import { DIET_RECOMMENDATION_SHARED_INSTANCE_ID, ensureBuiltInAiProjects, getProjectRuntimeContext } from "./platform/project-registry.js";
import { DIET_RECOMMENDATION_PROJECT_TYPE_ID, INVEST_AGENT_PROJECT_TYPE_ID } from "./platform/project-types.js";

const agent = createAgent();

async function hermesTestContextForProfile(profile: string, userId: string, conversationId: string, projectIdOrInstanceId?: string) {
  if (projectIdOrInstanceId) {
    const project = await getProjectRuntimeContext(projectIdOrInstanceId);
    return {
      userId: userId === DEFAULT_USER_ID ? project.ownerUserId : userId,
      projectId: project.projectId,
      instanceId: project.instanceId,
      projectType: project.projectType,
      skillBundleId: project.skillBundleId,
      strategySkillId: project.strategySkillId,
      instanceExpansionPath: project.instanceExpansionPath,
      channel: "api" as const,
      backend: "hermes" as const,
      hermesProfile: profile || project.hermesProfile,
      conversationId,
    };
  }
  if (profile === "diet-recommendation") {
    return {
      userId,
      projectId: DIET_RECOMMENDATION_SHARED_INSTANCE_ID,
      instanceId: DIET_RECOMMENDATION_SHARED_INSTANCE_ID,
      projectType: DIET_RECOMMENDATION_PROJECT_TYPE_ID,
      skillBundleId: "diet-recommendation-default",
      channel: "api" as const,
      backend: "hermes" as const,
      hermesProfile: profile,
      conversationId,
    };
  }
  return {
    userId,
    projectId: "invest-agent",
    instanceId: userId === DEFAULT_USER_ID ? "invest-agent-primary" : `invest-agent-${userId}`,
    projectType: INVEST_AGENT_PROJECT_TYPE_ID,
    skillBundleId: "invest-agent-default",
    channel: "api" as const,
    backend: "hermes" as const,
    hermesProfile: profile,
    conversationId,
  };
}

/** 待推送消息队列（OpenClaw 轮询取走） */
let pendingAlerts: string[] = [];
let pushQueueInterval: ReturnType<typeof setInterval> | null = null;

async function sendPushJob(job: { userId: string; backend: PushBackend; message: string; instanceId?: string }) {
  if (job.instanceId && job.instanceId !== "invest-agent-primary") {
    try {
      const projectManager = await projectWeixinManagerForInstance(job.instanceId);
      const pushed = await projectManager.pushText(job.message, { userId: job.userId, instanceId: job.instanceId });
      if (pushed) return true;
    } catch (error) {
      logger.warn(`项目实例微信推送失败，尝试全局通道: ${(error as Error).message}`);
    }
  }
  const manager = job.backend === "hermes" ? hermesWeixinMobileManager : weixinMobileManager;
  return manager.pushText(job.message, { userId: job.userId, instanceId: job.instanceId });
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
      backend: process.env.HERMES_EXPERIMENT_ENABLED === "true" ? "hermes" : "codex",
      projectId: options?.projectId,
      instanceId: options?.instanceId,
      source: "scheduler",
      message,
    });
    logger.info(`提醒已进入推送队列 job=${job.id} user=${job.userId} backend=${job.backend}`);
    await processDuePushJobs(sendPushJob, { limit: 5 });
  });

  // 健康检查
  app.get("/health", async () => ({
    status: "ok",
    agent: agent.agentName,
    agentId: agent.agentId,
    capabilities: agent.capabilities,
    acpBackends: await listAcpBackends(),
    codexAcp: getCodexAcpStatus(),
    hermesAcp: getHermesAcpStatus(),
    pendingAlerts: pendingAlerts.length,
    pushQueue: await getPushQueueSummary(),
    timestamp: new Date().toISOString(),
  }));

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

  app.get("/admin/hermes-weixin", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(renderWeixinAdminPage({
        title: "项目微信绑定",
        subtitle: "为当前 AI 项目绑定独立微信连接，消息将进入 Hermes 后端",
        apiBase: "/api/hermes-weixin",
        showAlertActions: false,
        sampleMessages: ["你是谁？", "我的持仓", "自选列表", "每日复盘"],
        qrHint: "请使用你的微信扫描二维码。该连接会绑定到当前 AI 项目的独立微信状态，不影响其他项目连接。",
      }));
  });

  app.get("/admin/diet-weixin", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(renderWeixinAdminPage({
        title: "饮食推荐助手微信绑定",
        subtitle: "一个饮食推荐项目服务多个微信用户，使用同一套饮食推荐 Skill",
        apiBase: "/api/diet-weixin",
        showAlertActions: false,
        sampleMessages: ["我想控制体重，晚餐怎么吃？", "帮我安排一周工作日早餐", "我不吃辣，有什么高蛋白午餐？"],
        qrHint: "请使用微信扫描二维码。多个用户可通过该连接绑定到同一个饮食推荐助手项目。",
      }));
  });

  app.get("/api/diet-weixin/status", async () => dietWeixinMobileManager.getState());

  app.post("/api/diet-weixin/connect/start", async () => dietWeixinMobileManager.startLogin());

  app.post("/api/diet-weixin/listener/start", async () => {
    await dietWeixinMobileManager.ensureListenerStarted();
    return dietWeixinMobileManager.getState();
  });

  app.post("/api/diet-weixin/connect/stop", async () => {
    dietWeixinMobileManager.stop();
    return dietWeixinMobileManager.getState();
  });

  app.post<{ Body: { message?: string } }>("/api/diet-weixin/push/test", async (request, reply) => {
    const text = request.body?.message?.trim() || `饮食推荐助手测试提醒：${new Date().toLocaleString("zh-CN")}`;
    try {
      const pushed = await dietWeixinMobileManager.pushText(text);
      if (!pushed) {
        return reply.status(409).send({
          ok: false,
          message: "当前没有可用的饮食推荐助手微信会话，请先用该微信给助手发送一条消息。",
          state: dietWeixinMobileManager.getState(),
        });
      }
      return { ok: true, state: dietWeixinMobileManager.getState() };
    } catch (error) {
      logger.warn(`饮食推荐助手测试微信推送失败: ${(error as Error).message}`);
      return reply.status(500).send({
        ok: false,
        message: (error as Error).message,
        state: dietWeixinMobileManager.getState(),
      });
    }
  });

  app.get("/api/hermes-weixin/status", async () => hermesWeixinMobileManager.getState());

  app.post("/api/hermes-weixin/connect/start", async () => hermesWeixinMobileManager.startLogin());

  app.post("/api/hermes-weixin/listener/start", async () => {
    await hermesWeixinMobileManager.ensureListenerStarted();
    return hermesWeixinMobileManager.getState();
  });

  app.post("/api/hermes-weixin/connect/stop", async () => {
    hermesWeixinMobileManager.stop();
    return hermesWeixinMobileManager.getState();
  });

  app.post<{ Body: { message?: string } }>("/api/hermes-weixin/push/test", async (request, reply) => {
    const text = request.body?.message?.trim() || `Hermes 后端测试提醒：${new Date().toLocaleString("zh-CN")}`;
    try {
      const pushed = await hermesWeixinMobileManager.pushText(text);
      if (!pushed) {
        return reply.status(409).send({
          ok: false,
          message: "当前没有可用的项目微信会话，请先用该微信给项目助手发送一条消息。",
          state: hermesWeixinMobileManager.getState(),
        });
      }
      return { ok: true, state: hermesWeixinMobileManager.getState() };
    } catch (error) {
      logger.warn(`Hermes 后端测试微信推送失败: ${(error as Error).message}`);
      return reply.status(500).send({
        ok: false,
        message: (error as Error).message,
        state: hermesWeixinMobileManager.getState(),
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
  app.post<{ Body: { message: string } }>(
    "/api/chat",
    async (request, reply) => {
      const { message } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      const acpMessage: AcpMessage = {
        id: `test-${Date.now()}`,
        from: "test",
        timestamp: Date.now(),
        content: { type: "text", text: message },
      };

      const response = await agent.handleMessage(acpMessage);
      return response;
    }
  );

  app.get("/api/hermes/status", async () => getHermesAcpStatus());

  app.post<{ Body: { message?: string; conversationId?: string; userId?: string; profile?: string; projectId?: string; instanceId?: string } }>(
    "/api/hermes/chat-test",
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }

      const startedAt = Date.now();
      const profile = request.body?.profile?.trim() || getHermesAcpStatus().profile;
      const userId = normalizeUserId(request.body?.userId || (request.body?.conversationId?.startsWith("user:") ? request.body.conversationId.slice(5) : DEFAULT_USER_ID));
      const conversationId = request.body?.conversationId || "hermes-test";
      const userContext = await hermesTestContextForProfile(profile, userId, conversationId, request.body?.instanceId || request.body?.projectId);
      const taskReply = await handlePendingConversationTaskTurn(userContext, message);
      if (taskReply) {
        return {
          ok: true,
          backend: "conversation-task",
          profile,
          elapsedMs: Date.now() - startedAt,
          text: taskReply,
        };
      }
      const { promptText } = await buildAcpPromptContext({
        userText: message,
        userContext,
      });
      const raw = await hermesStdioAcpAgent.chat({
        conversationId,
        text: promptText,
        messageId: randomUUID(),
        profile,
      });
      const intentReply = await handleAiIntentDraftTurn(userContext, raw);
      if (intentReply) {
        return {
          ok: true,
          backend: "ai-intent-task",
          profile,
          elapsedMs: Date.now() - startedAt,
          text: intentReply,
        };
      }
      const text = sanitizeCustomerText(raw);
      return {
        ok: true,
        backend: "hermes",
        profile,
        elapsedMs: Date.now() - startedAt,
        text,
      };
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
        : hermesWeixinMobileManager;
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

  app.post<{ Body: { message?: string; conversationId?: string; userId?: string; profile?: string; projectId?: string; instanceId?: string } }>(
    "/api/hermes/daily-review-test",
    async (request) => {
      const startedAt = Date.now();
      const profile = request.body?.profile?.trim() || getHermesAcpStatus().profile;
      const projectContext = request.body?.instanceId || request.body?.projectId
        ? await getProjectRuntimeContext(request.body.instanceId || request.body.projectId!)
        : undefined;
      const userId = normalizeUserId(request.body?.userId || projectContext?.ownerUserId);
      const reviewContext = await buildDailyReviewContext({ userId, instanceId: projectContext?.instanceId });
      const conversationId = request.body?.conversationId || `hermes-daily-review-${reviewContext.date}`;
      const userContext = await hermesTestContextForProfile(profile, userId, conversationId, request.body?.instanceId || request.body?.projectId);
      const promptContext = await buildAcpPromptContext({
        userText: request.body?.message?.trim() || "请生成今日复盘",
        reviewContext,
        userContext,
      });
      const promptText = promptContext.promptText;
      const raw = await hermesStdioAcpAgent.chat({
        conversationId,
        text: promptText,
        messageId: randomUUID(),
        profile,
      });
      const text = sanitizeCustomerText(raw);
      return {
        ok: true,
        backend: "hermes",
        profile,
        date: reviewContext.date,
        saved: false,
        elapsedMs: Date.now() - startedAt,
        contextSummary: promptContext.reviewContextSummary,
        text,
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
        backend: process.env.HERMES_EXPERIMENT_ENABLED === "true" ? "hermes" : "codex",
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

  // 手动触发盘前提醒（测试用）
  app.post("/api/alerts/pre-market", async () => {
    const { runPreMarketAlert } = await import(
      "./scheduler/pre-market.js"
    );
    const text = await runPreMarketAlert();
    return { text };
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
    logger.info(`Hermes 项目微信绑定后台: http://localhost:${config.port}/admin/hermes-weixin`);
    logger.info(`饮食推荐助手微信绑定后台: http://localhost:${config.port}/admin/diet-weixin`);
    logger.info(`数据看板: http://localhost:${config.port}/dashboard`);
    logger.info(`平台项目后台: http://localhost:${config.port}/platform`);

    if (process.env.WEIXIN_AUTO_START !== "false" && weixinMobileManager.getState().stage === "connected") {
      weixinMobileManager.ensureListenerStarted().catch((error) => {
        logger.warn(`微信监听自动启动失败: ${(error as Error).message}`);
      });
    }
    if (process.env.HERMES_WEIXIN_AUTO_START === "true" && hermesWeixinMobileManager.getState().stage === "connected") {
      hermesWeixinMobileManager.ensureListenerStarted().catch((error) => {
        logger.warn(`Hermes 项目微信监听自动启动失败: ${(error as Error).message}`);
      });
    }
    if (process.env.DIET_WEIXIN_AUTO_START === "true" && dietWeixinMobileManager.getState().stage === "connected") {
      dietWeixinMobileManager.ensureListenerStarted().catch((error) => {
        logger.warn(`饮食推荐助手微信监听自动启动失败: ${(error as Error).message}`);
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
