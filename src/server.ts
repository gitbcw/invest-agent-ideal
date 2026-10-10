import Fastify from "fastify";
import path from "node:path";
import cors from "@fastify/cors";
import { createRuntimeAgent } from "./runtime/agent.js";
import type { AgentMessage, AgentResponse } from "./runtime/protocol.js";
import { config } from "./lib/config.js";
import { sqlite } from "./db/index.js";
import { MastraUserPreferenceStore } from "./services/user-preferences.js";
import { logger } from "./lib/logger.js";
import { listSchedulableScopes, registerPush, triggerScheduledMarketWatchNow, triggerScheduledReviewNow } from "./scheduler/index.js";
import { weixinMobileManager } from "./channels/weixin-mobile.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSandboxRoutes } from "./routes/sandbox.js";
import { registerExternalMcpObserverRoutes } from "./routes/external-mcp-observer.js";
import { assertPlatformPartnerKeySafety, autoStartPlatformWeixinListeners, projectWeixinManagerForInstance, registerPlatformRoutes } from "./routes/platform.js";
import { ensureBuiltInIndicatorDefinitions } from "./handlers/indicator-definitions.js";
import { enqueuePushJob, getPushJob, getPushQueueSummary, processDuePushJobs, type PushBackend } from "./services/push-queue.js";
import type { WeixinDeliveryResult } from "./services/weixin-delivery.js";
import { ensureBuiltInAiProjects } from "./platform/project-registry.js";
import { DEFAULT_PROJECT_ID, instanceIdFromRequest, userIdFromRequest } from "./lib/user-context.js";
import { ensureDefaultProjectForUser } from "./platform/project-registry.js";
import { ACTIVE_BACKEND } from "./lib/data-backend.js";
import { db } from "./db/index.js";
import { agentTraces, pushJobs, scheduledTaskRuns } from "./db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { assertServiceAuthConfiguration, hasServiceApiAuthorization, isPublicServicePath, isSandboxPath } from "./lib/service-auth.js";
import { hasPlatformSession, isLoopbackAddress } from "./lib/platform-session.js";
import { hasPersistentPlatformSession } from "./lib/platform-auth.js";
import { consumeRequestRateLimit } from "./lib/request-rate-limit.js";
import { recoverInterruptedConversationTaskRuns } from "./services/conversation-task-runs.js";

const agent = createRuntimeAgent();

let pushQueueInterval: ReturnType<typeof setInterval> | null = null;

function isOfflineMode() {
  return process.env.INVEST_AGENT_OFFLINE_MODE === "true";
}

async function sendPushJob(job: { userId: string; backend: PushBackend; message: string; instanceId?: string; sentChunks?: number | null }): Promise<WeixinDeliveryResult> {
  if (isOfflineMode()) {
    return { ok: false, reason: "wechat_api_error", errorMessage: "offline mode blocks external delivery" };
  }
  if (job.instanceId) {
    try {
      const projectManager = await projectWeixinManagerForInstance(job.instanceId);
      return await projectManager.pushTextDetailed(job.message, { userId: job.userId, instanceId: job.instanceId, skipChunks: job.sentChunks ?? 0 });
    } catch (error) {
      logger.warn(`项目实例微信推送失败，尝试全局通道: ${(error as Error).message}`);
    }
  }
  return weixinMobileManager.pushTextDetailed(job.message, { userId: job.userId, instanceId: job.instanceId, skipChunks: job.sentChunks ?? 0 });
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
async function resolveWizardScope(query: { instanceId?: string; userId?: string }): Promise<{ userId: string; projectId: string; instanceId: string }> {
  let userId = query.userId?.trim() || "";
  if (!userId && query.instanceId?.trim()) {
    const row = sqlite.prepare("SELECT owner_user_id AS ownerId, project_id FROM ai_instances WHERE id=?").get(query.instanceId.trim()) as { ownerId?: string; project_id?: string } | undefined;
    if (row?.ownerId) return { userId: row.ownerId, projectId: row.project_id ?? "invest-agent", instanceId: query.instanceId.trim() };
  }
  if (!userId) throw new Error("instanceId or userId is required");
  const instance = sqlite.prepare("SELECT id, project_id FROM ai_instances WHERE owner_user_id=? ORDER BY created_at ASC LIMIT 1").get(userId) as { id: string; project_id: string } | undefined;
  return { userId, projectId: instance?.project_id ?? "invest-agent", instanceId: instance?.id ?? `invest-agent-${userId}` };
}

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
    const limit = request.url.startsWith("/agent/message") ? 30 : 120;
    const result = consumeRequestRateLimit({ key: clientKey, max: limit, windowMs: 60_000 });
    if (!result.allowed) {
      return reply.header("retry-after", String(result.retryAfterSeconds)).status(429).send({ ok: false, error: "rate limit exceeded" });
    }
  });
  await ensureBuiltInAiProjects();
  await ensureBuiltInIndicatorDefinitions();
  await assertPlatformPartnerKeySafety();
  const recoveredConversationRuns = recoverInterruptedConversationTaskRuns();
  if (recoveredConversationRuns > 0) {
    logger.warn(`已收敛 ${recoveredConversationRuns} 条服务重启前未完成的对话任务`);
  }

  registerPortalRoutes(app);
  registerSandboxRoutes(app);
  registerPlatformRoutes(app);
  registerExternalMcpObserverRoutes(app);

  if (!isOfflineMode()) startPushQueueWorker();

  // 注册推送回调：调度器产出的提醒进入可靠推送队列
  registerPush(async (message, options) => {
    const job = await enqueuePushJob({
      userId: options?.userId,
      backend: config.agent.backend,
      projectId: options?.projectId,
      instanceId: options?.instanceId,
      source: "scheduler",
      messageKind: options?.messageKind,
      expiresAt: options?.expiresAt,
      originTaskKey: options?.originTaskKey,
      retryPolicy: options?.retryPolicy,
      idempotencyKey: options?.idempotencyKey,
      maxAttempts: options?.maxAttempts,
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

  // Agent discovery information.
  app.get("/.well-known/agent.json", async () => ({
    agent_id: agent.agentId,
    name: agent.agentName,
    description: "A 股投资选股智能助手，支持选股分析、持仓管理、复盘提醒",
    capabilities: agent.capabilities,
    protocol: "invest-agent-runtime-1.0",
    endpoint: `/agent/message`,
  }));

  // Channel adapters forward messages to this runtime endpoint.
  app.post<{ Body: AgentMessage }>(
    "/agent/message",
    async (request, reply): Promise<AgentResponse> => {
      const message = request.body;
      logger.info(`Agent 收到消息 from=${message.from}`);
      return agent.handleMessage(message);
    }
  );

  // O1 onboarding wizard completion: silently apply the default usage mode for
  // scopes that own no typed scheduled tasks, and return the notify copy the
  // Portal wizard shows in step 4.
  // 用户侧微信绑定（2026-10-09 重做：接实例微信管理器的真实扫码通道）。
  // 绑定 = startLogin 生成的动态二维码被该用户的微信扫下：凭据落盘到实例
  // 专属 stateDir，监听自动启动，扫码微信即该实例的通道对端。
  const wechatBindingManager = async (query: { instanceId?: string; userId?: string }) => {
    const scope = await resolveWizardScope(query);
    const { projectWeixinManagerForInstance } = await import("./routes/platform.js");
    return { scope, manager: await projectWeixinManagerForInstance(scope.instanceId) };
  };
  app.get<{ Querystring: { instanceId?: string; userId?: string } }>(
    "/api/wechat/binding",
    async (request) => {
      const { manager } = await wechatBindingManager(request.query);
      const state = manager.getState();
      return {
        ok: true,
        bound: (state.accounts?.length ?? 0) > 0,
        stage: state.stage,
        message: state.message ?? null,
        qrcodeDataUrl: state.qrcodeDataUrl ?? null,
        accounts: (state.accounts ?? []).map((account) => ({ accountId: account.accountId, listenerRunning: account.listenerRunning, pushReady: account.pushReady })),
      };
    },
  );
  app.post<{ Querystring: { instanceId?: string; userId?: string } }>(
    "/api/wechat/binding/qrcode",
    async (request) => {
      const { manager } = await wechatBindingManager(request.query);
      const state = await manager.startLogin(false);
      return {
        ok: true,
        bound: (state.accounts?.length ?? 0) > 0,
        stage: state.stage,
        message: state.message ?? null,
        qrcodeDataUrl: state.qrcodeDataUrl ?? null,
      };
    },
  );
  app.delete<{ Querystring: { instanceId?: string; userId?: string } }>(
    "/api/wechat/binding",
    async (request) => {
      const { scope, manager } = await wechatBindingManager(request.query);
      manager.stop();
      const { clearWeixinAccounts } = await import("./channels/weixin-account-store.js");
      const { config } = await import("./lib/config.js");
      clearWeixinAccounts(path.join(config.weixin.stateDir, "project-weixin", scope.instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")));
      return { ok: true, unbound: true };
    },
  );

  // 2026-10-08 冷启动引导闭环：Portal 登录/聊天页查询初始化状态用。
  // 入参用 instanceId（Portal 会话天然持有），内部反查 owner userId——
  // 镜像等 username != runtime userId 的部署不再错位写 scope。
  app.get<{ Querystring: { instanceId?: string; userId?: string } }>(
    "/api/onboarding/wizard/status",
    async (request, reply) => {
      const { instanceId, userId: rawUserId } = request.query ?? {};
      let userId = rawUserId?.trim() || "";
      if (!userId && instanceId?.trim()) {
        const row = sqlite.prepare("SELECT owner_user_id AS ownerId FROM ai_instances WHERE id=?").get(instanceId.trim()) as { ownerId?: string } | undefined;
        if (row?.ownerId) userId = row.ownerId;
      }
      if (!userId) return reply.status(400).send({ ok: false, error: "instanceId or userId is required" });
      const store = new MastraUserPreferenceStore(userId, instanceId?.trim() || `invest-agent-${userId}`, "invest-agent");
      const state = await store.readOnboardingState();
      const { isInitializationUnfinished } = await import("./runtime/agent.js");
      const needsOnboarding = await isInitializationUnfinished({
        userId,
        projectId: "invest-agent",
        instanceId: instanceId?.trim() || `invest-agent-${userId}`,
        channel: "web",
      } as Parameters<typeof isInitializationUnfinished>[0]);
      return { ok: true, userId, state: { status: state?.status ?? null, completedAt: state?.completed_at ?? null }, needsOnboarding };
    },
  );

  app.post<{ Body: {
      userId?: string; projectId?: string; instanceId?: string; strategyPackId?: string;
      style?: "trend" | "value" | "balanced" | "skip"; customText?: string; portfolioText?: string;
      notify?: {
        dailyReview?: { enabled: boolean; time?: string };
        marketWatch?: { enabled: boolean; times?: string[] };
        weeklyReview?: { enabled: boolean; time?: string };
        monthlyReview?: { enabled: boolean; time?: string };
      };
    } }>(
    "/api/onboarding/wizard/complete",
    async (request, reply) => {
      const { userId: rawUserId, projectId, instanceId, strategyPackId, style, customText, notify, portfolioText } = request.body ?? {};
      // username != runtime userId 的部署（镜像 mirror-* 登录名）按 instanceId
      // 反查 owner，避免写错 scope（2026-10-08）。
      let userId = rawUserId?.trim() || "";
      if (!userId && instanceId?.trim()) {
        const row = sqlite.prepare("SELECT owner_user_id AS ownerId FROM ai_instances WHERE id=?").get(instanceId.trim()) as { ownerId?: string } | undefined;
        if (row?.ownerId) userId = row.ownerId;
      }
      if (!userId) return reply.status(400).send({ ok: false, error: "userId or instanceId is required" });
      const project = await ensureDefaultProjectForUser(userId);
      const scope = { userId, projectId: projectId || project.projectId, instanceId: instanceId || project.instanceId };
      // Deterministic parse of pasted portfolio lines (name + 6-digit code).
      // Screenshot/image recognition stays with the model in conversation.
      let portfolioDraft: { parsed: number } | null = null;
      if (typeof portfolioText === "string" && portfolioText.trim().length > 0) {
        const holdings = portfolioText
          .split(/\n+/)
          .map((line) => {
            const code = line.match(/\b\d{6}\b/)?.[0];
            const name = line.replace(/\b\d{6}\b/, "").replace(/成本.*|,|，|\t/g, " ").trim();
            return code && name ? { name, code } : null;
          })
          .filter((item): item is { name: string; code: string } => item !== null);
        if (holdings.length > 0) {
          const { upsertOnboardingDraftStep } = await import("./services/onboarding-drafts.js");
          await upsertOnboardingDraftStep({ ...scope, conversationId: `wizard:${userId}` }, { step: "portfolio", payload: { holdings } });
          portfolioDraft = { parsed: holdings.length };
        }
      }
      // 2026-10-08 重设计：风格 → 两层模型（投资框架播种 + 主策略）；旧
      // strategyPackId 仍兼容（映射到 style）。
      const effectiveStyle = style ?? (strategyPackId === "strategy-trend-following" ? "trend" : strategyPackId === "strategy-value-reversion" ? "value" : undefined);
      const { bootstrapInvestorProfile } = await import("./services/onboarding-bootstrap.js");
      const profile = await bootstrapInvestorProfile({
        scope,
        ...(effectiveStyle ? { style: effectiveStyle } : {}),
        ...(customText ? { customText } : {}),
      });
      const { ensureDefaultUsageMode } = await import("./services/presets.js");
      const applied = await ensureDefaultUsageMode(scope);
      // 第三屏「推送与提醒」落地（2026-10-09）：对照系统真实推送任务逐项
      // 应用勾选与时间；任务由 preset 创建（active），未勾选项停用，时间
      // 变更走任务修订服务（保留 revision 链）。
      const { updateAutomationTask, pauseAutomationTask, activateAutomationTask } = await import("./services/automation-tasks.js");
      const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
      const appliedNotify: string[] = [];
      if (applied && notify) {
        const byType = new Map(applied.created.map((item) => [item.taskType, item.taskId]));
        const adjust = async (taskType: string, choice: { enabled: boolean; time?: string; times?: string[] }, scheduleKind: "time" | "windows") => {
          const taskId = byType.get(taskType);
          if (!taskId) return;
          if (!choice.enabled) {
            await pauseAutomationTask({ ...scope, taskId });
            appliedNotify.push("已按你的选择关闭对应推送");
            return;
          }
          const row = sqlite.prepare("SELECT schedule_json AS scheduleJson FROM automation_task_revisions WHERE revision_id=(SELECT current_revision_id FROM automation_tasks WHERE task_id=?)").get(taskId) as { scheduleJson: string } | undefined;
          if (!row) return;
          let schedule: Record<string, unknown>;
          try { schedule = JSON.parse(row.scheduleJson); } catch { return; }
          if (scheduleKind === "windows") {
            const times = (choice.times ?? []).filter((t) => timeRe.test(t)).sort();
            if (times.length > 0) {
              schedule.windows = times;
              schedule.time = times[times.length - 1];
            }
          } else if (choice.time && timeRe.test(choice.time)) {
            schedule.time = choice.time;
          }
          await updateAutomationTask({ ...scope, taskId, schedule: schedule as never });
          // schedule 修订会把任务重置为 paused（等确认语义）——向导场景用户
          // 已在勾选框上明确选择，直接激活。
          await activateAutomationTask({ ...scope, taskId });
        };
        if (notify.dailyReview) await adjust("scheduled-daily-review", notify.dailyReview, "time");
        if (notify.marketWatch) await adjust("scheduled-market-watch", notify.marketWatch, "windows");
        if (notify.weeklyReview) await adjust("scheduled-weekly-review", notify.weeklyReview, "time");
        if (notify.monthlyReview) await adjust("scheduled-monthly-review", notify.monthlyReview, "time");
      }
      const parts: string[] = [];
      // 2026-10-09：框架不再预置分析方法（与技能重复且双份常驻烧 token），
      // 向导完成语不再播报框架件数。
      if (profile.strategy) parts.push(profile.strategy.becamePrimary ? `已把「${profile.strategy.name}」设为你的主策略（每轮生效）` : `已保存「${profile.strategy.name}」`);
      if (applied) {
        parts.push("已按你的勾选配置推送：复盘与盯盘会在对应时间主动推给你（微信未绑定时先在对话里看），随时可以在任务页调整");
        if (appliedNotify.length > 0) parts.push(appliedNotify[0]!);
      } else {
        parts.push("已保留你现有的任务配置，未做更改。");
      }
      return {
        ok: true,
        appliedDefault: Boolean(applied),
        preset: applied ? { id: applied.presetId, version: applied.presetVersion } : null,
        profile,
        portfolioDraft,
        message: parts.join("。"),
      };
    },
  );

  // Simple local chat endpoint.
  app.post<{ Body: { message: string; userId?: string; workspacePath?: string; channel?: "weixin-mobile" | "api" } }>(
    "/api/chat",
    async (request, reply) => {
      const { message, userId, workspacePath, channel } = request.body;
      if (!message) {
        return reply.status(400).send({ error: "message is required" });
      }
      const normalizedChannel: "weixin-mobile" | "api" = channel === "weixin-mobile" ? "weixin-mobile" : "api";

      let resolvedWorkspacePath: string | undefined;
      let projectId = DEFAULT_PROJECT_ID;
      let instanceId: string | undefined;
      if (ACTIVE_BACKEND === "mastra" && userId) {
        // A request-provided workspacePath must never select a Mastra project
        // root. Bootstrap resolves the authenticated user's service-owned scope.
        const project = await ensureDefaultProjectForUser(userId);
        projectId = project.projectId;
        instanceId = project.instanceId;
      }

      const agentMessage: AgentMessage = {
        id: `test-${Date.now()}`,
        from: userId || "test",
        timestamp: Date.now(),
        content: { type: "text", text: message },
        ...(userId || resolvedWorkspacePath || normalizedChannel
          ? {
              context: {
                userId: userId || "test",
                ...(instanceId ? { projectId, instanceId } : {}),
                ...(resolvedWorkspacePath ? { workspacePath: resolvedWorkspacePath } : {}),
                ...(normalizedChannel ? { channel: normalizedChannel } : {}),
              },
            }
          : {}),
      };

      const response = await agent.handleMessage(agentMessage);
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
        backend: "mastra",
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
      .from(agentTraces)
      .where(and(
        eq(agentTraces.userId, userId),
        eq(agentTraces.instanceId, instanceId),
        eq(agentTraces.conversationId, `scheduler:${task === "market-watch" ? "market-watch" : `${task.replace("-review", "")}-review`}:${userId}:${instanceId}`),
      ))
      .orderBy(desc(agentTraces.createdAt))
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
    logger.info(`Agent 端点: http://localhost:${config.port}/agent/message`);
    logger.info(`提醒轮询: http://localhost:${config.port}/agent/alerts`);
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
