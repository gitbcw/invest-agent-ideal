import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { alertRules, alerts, alertEvents, codexAcpTraces, conversationTasks, indicatorResults, portfolio, stockPlans, users, watchlist } from "../db/schema.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getSignalConfig, handleSignalConfigTool } from "../handlers/signal-config.js";
import { getAlertInterval, setAlertInterval } from "../scheduler/index.js";
import { renderDashboardPage } from "../admin/dashboard-page.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { getQuote } from "../services/stock.js";
import { getCapitalFlowBatch } from "../services/eastmoney.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { reviewViewpointBackend } from "../lib/review-viewpoint-backend.js";
import { logger } from "../lib/logger.js";
import { buildDailyReviewContext, buildMonthlyReviewContext, buildWeeklyReviewContext, generateDailyReview, handleReviewTool, saveSkillDailyReview } from "../handlers/review.js";
import { getIndicatorDefinition, listIndicatorDefinitions } from "../handlers/indicator-definitions.js";
import { deleteMirroredAlertRule, disableMirroredAlertRule, syncLegacyAlertToAlertRule } from "../handlers/alert-rules.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { getWorkspaceStore } from "../lib/workspace-store.js";
import { DEFAULT_USER_ID, instanceIdFromRequest, normalizeUserId, userIdFromRequest } from "../lib/user-context.js";
import { ensureDefaultAiInstanceForUser } from "../lib/user-identity.js";
import { ensureDefaultProjectForUser, listProjectRuntimeContexts } from "../platform/project-registry.js";
import { portfolioBackend, watchlistBackend, planBackend } from "../lib/data-backend.js";
import { listAcpBackends, switchAcpBackend, type AcpBackendId } from "../acp/stdio-agent.js";

export function registerDashboardRoutes(app: FastifyInstance) {
  const safe = (handler: (request: any, reply: any) => Promise<any>) =>
    async (request: any, reply: any) => {
      try { return await handler(request, reply); }
      catch (e) { logger.error("Dashboard 操作失败:", e); return reply.status(500).send({ ok: false, error: "操作失败，请重试" }); }
    };

  const requestScope = (request: any) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    return { userId, instanceId };
  };

  // ─── 页面 ───
  app.get("/dashboard", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderDashboardPage());
  });

  // ─── 聚合数据 API ───
  app.get<{ Querystring: { userId?: string; instanceId?: string } }>("/api/dashboard", async (request) => {
    const userId = userIdFromRequest(request);
    const requestedInstanceId = request.query.instanceId?.trim();
    const today = new Date().toISOString().slice(0, 10);
    const runtimeContexts = await listProjectRuntimeContexts({ ownerUserId: userId });
    const defaultProject = userId === DEFAULT_USER_ID
      ? await ensureDefaultProjectForUser(userId, "hermes")
      : runtimeContexts.find((project) => project.projectType === "invest-agent");
    const currentProject =
      runtimeContexts.find((project) => project.projectId === requestedInstanceId || project.instanceId === requestedInstanceId) ||
      (defaultProject ? runtimeContexts.find((project) => project.projectId === defaultProject.projectId) : undefined) ||
      runtimeContexts[0];
    if (!currentProject) {
      const [signals, indicators, interval, allUsers] = await Promise.all([
        getSignalConfig(),
        listIndicatorDefinitions(),
        getAlertInterval(),
        db.select().from(users).orderBy(users.displayName),
      ]);
      return {
        userId,
        projectId: undefined,
        aiProjectId: undefined,
        instanceId: undefined,
        projectType: undefined,
        skillBundleId: undefined,
        currentProject: undefined,
        currentInstance: undefined,
        projects: [],
        instances: [],
        users: allUsers,
        updatedAt: new Date().toISOString(),
        summary: {
          holdingCount: 0,
          watchlistCount: 0,
          planCount: 0,
          alertRuleCount: 0,
          indicatorCount: indicators.length,
          todayEventCount: 0,
          conversationCount: 0,
          intervalMinutes: interval,
        },
        holdings: [],
        watchlist: [],
        plans: [],
        alertRules: [],
        upgradedAlertRules: [],
        indicators,
        recentIndicatorResults: [],
        signals,
        capitalFlows: {},
        recentEvents: [],
        eventBatches: [],
        recentConversations: [],
        recentPlans: [],
      };
    }
    const instanceId = currentProject.instanceId;

    const [holdings, watchItems, plans, legacyAlertRules, upgradedAlertRules, recentIndicatorResults, recentEvents, recentPlans, recentConversations, reviewViewpointRows, openViewpoints, dueViewpoints, methodCandidates, pendingTasks, signals, indicators, interval, allUsers] =
      await Promise.all([
        db.select().from(portfolio).where(and(eq(portfolio.userId, userId), eq(portfolio.instanceId, instanceId), isNull(portfolio.sellDate))),
        db.select().from(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.instanceId, instanceId))),
        db.select().from(stockPlans).where(and(eq(stockPlans.userId, userId), eq(stockPlans.instanceId, instanceId))),
        db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId))),
        db.select().from(alertRules).where(and(eq(alertRules.userId, userId), eq(alertRules.instanceId, instanceId))),
        db.select().from(indicatorResults).where(and(eq(indicatorResults.userId, userId), eq(indicatorResults.instanceId, instanceId))).orderBy(desc(indicatorResults.calculatedAt)).limit(50),
        db.select().from(alertEvents).where(and(eq(alertEvents.userId, userId), eq(alertEvents.instanceId, instanceId))).orderBy(desc(alertEvents.createdAt)).limit(50),
        // WP4.7:daily_plans 走 backend(workspace 模式下读 yaml,sqlite 模式读表)
        (async () => {
          const today = new Date();
          const endDate = today.toISOString().slice(0, 10);
          const startDate = new Date(today.getTime() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
          const all = await dailyPlanBackend.listInRange(userId, instanceId, startDate, endDate);
          return all.slice(0, 5);
        })(),
        db.select({
          id: codexAcpTraces.id,
          userId: codexAcpTraces.userId,
          conversationId: codexAcpTraces.conversationId,
          messageId: codexAcpTraces.messageId,
          channel: codexAcpTraces.channel,
          userText: codexAcpTraces.userText,
          replyTextSanitized: codexAcpTraces.replyTextSanitized,
          mode: codexAcpTraces.mode,
          status: codexAcpTraces.status,
          errorMessage: codexAcpTraces.errorMessage,
          elapsedMs: codexAcpTraces.elapsedMs,
          createdAt: codexAcpTraces.createdAt,
        }).from(codexAcpTraces).where(and(eq(codexAcpTraces.userId, userId), eq(codexAcpTraces.instanceId, instanceId))).orderBy(desc(codexAcpTraces.createdAt)).limit(80),
        // WP4.8:review_viewpoints 走 backend(workspace 模式下读 jsonl,sqlite 模式读表)
        reviewViewpointBackend.list(userId, instanceId, { limit: 50 }),
        reviewViewpointBackend.list(userId, instanceId, { status: "open", limit: 10 }),
        reviewViewpointBackend.list(userId, instanceId, { status: "open", expectedReviewDateTo: today, limit: 10 }),
        // WP4.9:method_change_candidates 走 backend(workspace 模式下读 jsonl,sqlite 模式读表)
        methodChangeBackend.list(userId, instanceId, { limit: 10 }),
        db.select().from(conversationTasks).where(and(eq(conversationTasks.userId, userId), eq(conversationTasks.instanceId, instanceId), eq(conversationTasks.status, "pending"))).orderBy(desc(conversationTasks.createdAt)).limit(10),
        getSignalConfig(),
        listIndicatorDefinitions(),
        getAlertInterval(),
        db.select().from(users).orderBy(users.displayName),
      ]);

    const todayEvents = recentEvents.filter((e) => e.eventDate === today);

    // 获取资金流数据
    const allCodes = [...holdings.map(h => h.stockCode), ...watchItems.map(w => w.stockCode)];
    let capitalFlows: Record<string, { mainNetInflow: number; superLargeNetInflow: number; largeNetInflow: number }> = {};
    try {
      const flowMap = await getCapitalFlowBatch(allCodes);
      flowMap.forEach((flow, code) => {
        capitalFlows[code] = {
          mainNetInflow: flow.mainNetInflow,
          superLargeNetInflow: flow.superLargeNetInflow,
          largeNetInflow: flow.largeNetInflow,
        };
      });
    } catch (e) { logger.warn("资金流获取失败，不影响其他数据:", e); }

    // 拉取持仓当前价,前端用于展示成本/浮亏
    let holdingQuotes: Record<string, { price: number | null; changePercent: number | null }> = {};
    if (holdings.length > 0) {
      try {
        const quotes = await getQuote(holdings.map((h) => h.stockCode));
        for (const q of quotes) {
          holdingQuotes[q.code] = {
            price: typeof q.price === "number" ? q.price : null,
            changePercent: typeof q.changePercent === "number" ? q.changePercent : null,
          };
        }
      } catch (e) { logger.warn("持仓行情获取失败，不影响其他数据:", e); }
    }
    const holdingsWithQuote = holdings.map((h) => {
      const q = holdingQuotes[h.stockCode];
      return {
        ...h,
        currentPrice: q?.price ?? null,
        changePercent: q?.changePercent ?? null,
      };
    });

    const eventBatches: Array<{ batchTime: string; events: typeof recentEvents }> = [];
    const WINDOW_MS = 2 * 60 * 1000;
    for (const ev of recentEvents) {
      const evTime = new Date(ev.createdAt).getTime();
      const last = eventBatches[eventBatches.length - 1];
      if (last) {
        const lastEventTime = new Date(last.events[last.events.length - 1].createdAt).getTime();
        if (lastEventTime - evTime < WINDOW_MS) {
          last.events.push(ev);
          continue;
        }
      }
      eventBatches.push({ batchTime: ev.createdAt, events: [ev] });
    }

    return {
      userId,
      projectId: currentProject.legacyProjectId,
      aiProjectId: currentProject.projectId,
      instanceId,
      projectType: currentProject.projectTypeManifest,
      skillBundleId: currentProject.skillBundleId,
      currentProject,
      currentInstance: {
        id: currentProject.instanceId,
        projectId: currentProject.legacyProjectId,
        ownerUserId: currentProject.ownerUserId,
        name: currentProject.name,
        status: currentProject.status,
        backend: currentProject.backend,
        skillBundleId: currentProject.skillBundleId,
        config: JSON.stringify(currentProject.config),
      },
      projects: [...new Map(runtimeContexts.map((project) => [project.legacyProjectId, {
        id: project.legacyProjectId,
        name: project.projectTypeManifest.displayName,
        type: project.projectType,
        status: "active",
      }])).values()],
      instances: runtimeContexts.map((project) => ({
        id: project.instanceId,
        projectId: project.legacyProjectId,
        ownerUserId: project.ownerUserId,
        name: project.name,
        status: project.status,
        backend: project.backend,
        skillBundleId: project.skillBundleId,
        config: JSON.stringify(project.config),
      })),
      users: allUsers,
      updatedAt: new Date().toISOString(),
      summary: {
        holdingCount: holdings.length,
        watchlistCount: watchItems.length,
        planCount: plans.length,
        alertRuleCount: upgradedAlertRules.filter((a) => a.enabled).length,
        indicatorCount: indicators.length,
        todayEventCount: todayEvents.length,
        conversationCount: recentConversations.length,
        viewpointCount: reviewViewpointRows.length,
        openViewpointCount: openViewpoints.length,
        dueViewpointCount: dueViewpoints.length,
        methodCandidateCount: methodCandidates.filter((item) => item.status === "proposed").length,
        pendingTaskCount: pendingTasks.length,
        intervalMinutes: interval,
      },
      holdings: holdingsWithQuote,
      watchlist: watchItems,
      plans,
      alertRules: legacyAlertRules,
      upgradedAlertRules,
      indicators,
      recentIndicatorResults,
      signals,
      capitalFlows,
      recentEvents,
      eventBatches,
      recentConversations,
      reviewViewpoints: reviewViewpointRows,
      openViewpoints,
      dueViewpoints,
      methodCandidates,
      pendingTasks,
      recentPlans: recentPlans.map((p) => ({
        planDate: p.planDate,
        generatedAt: p.generatedAt,
        summary: p.summary,
        content: p.content,
      })),
    };
  });

  app.get("/api/users", safe(async () => {
    const rows = await db.select().from(users).orderBy(users.displayName);
    return { ok: true, users: rows };
  }));

  app.post<{ Body: { userId?: string; displayName?: string } }>("/api/users/create-test", safe(async (request, reply) => {
    const now = new Date().toISOString();
    const userId = normalizeUserId(request.body?.userId || `test-${Date.now()}`);
    const displayName = request.body?.displayName?.trim() || userId;
    const existing = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (existing.length > 0) {
      return { ok: true, user: existing[0], existed: true };
    }
    await db.insert(users).values({
      id: userId,
      displayName,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const created = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!created[0]) return reply.status(500).send({ ok: false, error: "用户创建失败" });
    await ensureDefaultAiInstanceForUser(userId, "hermes");
    return { ok: true, user: created[0], existed: false };
  }));

  // ─── 指标定义（只读，供后续自定义指标/提醒规则迁移使用） ───

  app.get("/api/indicators", safe(async () => {
    const indicators = await listIndicatorDefinitions();
    return { ok: true, count: indicators.length, indicators };
  }));

  app.get<{ Params: { key: string } }>("/api/indicators/:key", safe(async (request, reply) => {
    const item = await getIndicatorDefinition(request.params.key);
    if (!item) return reply.status(404).send({ ok: false, error: "指标不存在" });
    return { ok: true, indicator: item };
  }));

  // ─── 持仓池 CRUD ───

  app.post<{ Body: { name?: string; code?: string; costPrice?: number; userId?: string } }>("/api/portfolio/add", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { name, code, costPrice } = request.body ?? {};
    if (!name && !code) return reply.status(400).send({ ok: false, error: "请输入股票名称或代码" });

    const { codes, unresolved } = await resolveStockRefs([{ code, name }]);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: `未找到股票：${unresolved[0]?.name ?? code}` });

    const stockCode = codes[0];
    const normalizedCost = typeof costPrice === "number" && costPrice > 0 && costPrice < 100000 ? costPrice : null;

    const existing = await portfolioBackend.findActive(userId, instanceId, stockCode);
    if (existing) {
      if (normalizedCost != null) {
        await portfolioBackend.upsertActive(userId, instanceId, {
          code: stockCode,
          name: existing.name,
          costPrice: normalizedCost,
        });
        return { ok: true, message: `已更新 ${existing.name}(${stockCode}) 成本 ${normalizedCost}` };
      }
      return { ok: false, error: `${existing.name}(${stockCode}) 已在持仓池中` };
    }

    const quotes = await getQuote([stockCode]);
    const stockName = quotes[0]?.name || name || stockCode;

    await portfolioBackend.upsertActive(userId, instanceId, {
      code: stockCode,
      name: stockName,
      costPrice: normalizedCost,
    });

    return { ok: true, message: `已添加 ${stockName}(${stockCode}) 到持仓池` };
  }));

  app.post<{ Body: { code: string; userId?: string } }>("/api/portfolio/remove", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { code } = request.body ?? {};
    if (!code) return reply.status(400).send({ ok: false, error: "缺少股票代码" });

    const existing = await portfolioBackend.findActive(userId, instanceId, code);
    if (!existing) return { ok: false, error: `${code} 不在持仓池中` };

    await portfolioBackend.markClosed(userId, instanceId, code);
    return { ok: true, message: `已移除 ${existing.name}(${code})` };
  }));

  // ─── 自选池 CRUD ───

  app.post<{ Body: { name?: string; code?: string; reason?: string; userId?: string } }>("/api/watchlist/add", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { name, code, reason } = request.body ?? {};
    if (!name && !code) return reply.status(400).send({ ok: false, error: "请输入股票名称或代码" });

    const { codes, unresolved } = await resolveStockRefs([{ code, name }]);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: `未找到股票：${unresolved[0]?.name ?? code}` });

    const stockCode = codes[0];
    const existing = await watchlistBackend.find(userId, instanceId, stockCode);
    if (existing) return { ok: false, error: `${existing.name}(${stockCode}) 已在自选池中` };

    const quotes = await getQuote([stockCode]);
    const stockName = quotes[0]?.name || name || stockCode;

    const normalizedReason = normalizeWatchlistReason(reason || "Dashboard 添加");
    await watchlistBackend.add(userId, instanceId, {
      code: stockCode,
      name: stockName,
      reason: normalizedReason,
      source: "dashboard",
    });

    return { ok: true, message: `已添加 ${stockName}(${stockCode}) 到自选池` };
  }));

  app.post<{ Body: { code: string; userId?: string } }>("/api/watchlist/remove", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { code } = request.body ?? {};
    if (!code) return reply.status(400).send({ ok: false, error: "缺少股票代码" });

    const existing = await watchlistBackend.find(userId, instanceId, code);
    if (!existing) return { ok: false, error: `${code} 不在自选池中` };

    await watchlistBackend.remove(userId, instanceId, code);
    return { ok: true, message: `已移除 ${existing.name}(${code})` };
  }));

  // ─── 交易预案 CRUD ───

  app.post<{ Body: { stockCode: string; stockName?: string; support?: number; resistance?: number; targetPrice?: number; stopLoss?: number; notes?: string; watchConditions?: PlanWatchConditionInput[]; linkedAlertRuleIds?: number[]; planType?: string; strategyKey?: string | null; userId?: string } }>("/api/plans/set", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { stockCode, stockName, support, resistance, targetPrice, stopLoss, notes, watchConditions, linkedAlertRuleIds, planType, strategyKey } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });

    const quotes = await getQuote([stockCode]);
    const name = stockName || quotes[0]?.name || stockCode;

    const existing = await planBackend.find(userId, instanceId, stockCode);
    const wasExisting = !!existing;

    await planBackend.upsert(userId, instanceId, {
      code: stockCode,
      name,
      support: support !== undefined ? support : (existing?.support ?? null),
      resistance: resistance !== undefined ? resistance : (existing?.resistance ?? null),
      targetPrice: targetPrice !== undefined ? targetPrice : (existing?.targetPrice ?? null),
      stopLoss: stopLoss !== undefined ? stopLoss : (existing?.stopLoss ?? null),
      notes: notes !== undefined ? notes : (existing?.notes ?? null),
      watchConditions: watchConditions !== undefined ? watchConditions : existing?.watchConditions,
      linkedAlertRuleIds: linkedAlertRuleIds !== undefined
        ? linkedAlertRuleIds.map(String)
        : existing?.linkedAlertRuleIds,
      planType: planType ?? existing?.planType ?? "manual",
      strategyKey: strategyKey !== undefined ? strategyKey : (existing?.strategyKey ?? null),
    });

    return { ok: true, message: `${name}(${stockCode}) 预案已${wasExisting ? "更新" : "创建"}` };
  }));

  app.post<{ Body: { stockCode: string; stockName?: string; conditions: PlanWatchConditionInput[]; userId?: string } }>("/api/plans/watch-conditions", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { stockCode, stockName, conditions } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    if (!Array.isArray(conditions)) return reply.status(400).send({ ok: false, error: "conditions 必须是数组" });

    const result = await setPlanWatchConditions({ userId, instanceId, stockCode, stockName, conditions });
    return {
      ok: true,
      message: `${result.stockName}(${result.stockCode}) 已更新 ${result.conditionCount} 个观察条件`,
      ...result,
    };
  }));

  app.post<{ Body: { stockCode: string; userId?: string } }>("/api/plans/remove", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { stockCode } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });

    const existing = await planBackend.find(userId, instanceId, stockCode);
    if (!existing) return { ok: false, error: `${stockCode} 暂无预案` };

    await planBackend.remove(userId, instanceId, stockCode);
    return { ok: true, message: `已删除 ${existing.name}(${stockCode}) 的预案` };
  }));

  // ─── 交易策略 CRUD(读 workspace/config/trading_strategies.yaml) ───

  app.get("/api/strategies", safe(async (request) => {
    const { userId } = requestScope(request);
    const store = getWorkspaceStore(userId);
    const list = await store.readTradingStrategies();
    return { ok: true, strategies: list };
  }));

  app.post<{ Body: { key?: string; name?: string; applicability?: string; body?: string; enabled?: boolean; userId?: string } }>("/api/strategies/set", safe(async (request, reply) => {
    const { userId } = requestScope(request);
    const { key, name, applicability, body, enabled } = request.body ?? {};
    if (!key) return reply.status(400).send({ ok: false, error: "缺少策略 key" });
    if (!name) return reply.status(400).send({ ok: false, error: "缺少策略 name" });
    if (!body) return reply.status(400).send({ ok: false, error: "缺少策略 body" });
    const store = getWorkspaceStore(userId);
    const existing = (await store.readTradingStrategies()).find((s) => s.key === key);
    await store.writeTradingStrategy({ key, name, applicability, body, enabled });
    return { ok: true, message: `策略 [${key}] ${name} 已${existing ? "更新" : "新增"}` };
  }));

  app.post<{ Body: { key?: string; userId?: string } }>("/api/strategies/remove", safe(async (request, reply) => {
    const { userId } = requestScope(request);
    const { key } = request.body ?? {};
    if (!key) return reply.status(400).send({ ok: false, error: "缺少策略 key" });
    const store = getWorkspaceStore(userId);
    const removed = await store.removeTradingStrategy(key);
    if (!removed) return { ok: false, error: `未找到 key 为 ${key} 的策略` };
    return { ok: true, message: `已删除策略 [${key}]` };
  }));

  // ─── 提醒规则 CRUD ───

  const indicatorNames: Record<string, string> = {
    price: "涨跌幅", turnover: "换手率", volume_ratio: "量比", macd: "MACD",
    breakout: "放量突破", break_support: "跌破支撑", target_price: "目标价", support_price: "支撑价",
  };

  app.post<{ Body: { stockCode: string; stockName?: string; indicator: string; threshold?: number; userId?: string } }>("/api/alerts/set", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { stockCode, stockName, indicator, threshold } = request.body ?? {};
    if (!stockCode || !indicator) return reply.status(400).send({ ok: false, error: "缺少股票代码或指标" });

    const existing = await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.stockCode, stockCode), eq(alerts.indicator, indicator))).limit(1);

    const values = {
      userId,
      instanceId,
      stockCode, indicator,
      threshold: JSON.stringify({ value: threshold ?? 3 }),
      enabled: true,
    };

    if (existing.length > 0) {
      await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
    } else {
      await db.insert(alerts).values(values);
    }
    await syncLegacyAlertToAlertRule({
      userId,
      instanceId,
      stockCode,
      stockName,
      indicator,
      threshold: values.threshold,
      enabled: true,
    });

    const displayName = indicatorNames[indicator] || indicator;
    return { ok: true, message: `${stockName ?? stockCode} ${displayName} 提醒已${existing.length > 0 ? "更新" : "设置"}` };
  }));

  app.post<{ Body: { id: number; enabled: boolean; userId?: string } }>("/api/alerts/toggle", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { id, enabled } = request.body ?? {};
    if (id == null || enabled == null || typeof id !== "number") return reply.status(400).send({ ok: false, error: "缺少参数" });

    const existing = await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.id, id))).limit(1);
    if (existing.length === 0) return { ok: false, error: "提醒规则不存在" };
    await db.update(alerts).set({ enabled }).where(eq(alerts.id, id));
    await disableMirroredAlertRule(userId, existing[0].stockCode, existing[0].indicator, instanceId);
    if (enabled) {
      await syncLegacyAlertToAlertRule({
        userId,
        instanceId,
        stockCode: existing[0].stockCode,
        indicator: existing[0].indicator,
        threshold: existing[0].threshold,
        enabled: true,
      });
    }
    return { ok: true, message: `提醒已${enabled ? "启用" : "关闭"}` };
  }));

  app.post<{ Body: { id: number; userId?: string } }>("/api/alerts/remove", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { id } = request.body ?? {};
    if (id == null || typeof id !== "number") return reply.status(400).send({ ok: false, error: "缺少参数" });

    const existing = await db.select().from(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.id, id))).limit(1);
    if (existing.length === 0) return { ok: false, error: "提醒规则不存在" };

    await db.delete(alerts).where(and(eq(alerts.userId, userId), eq(alerts.instanceId, instanceId), eq(alerts.id, id)));
    await deleteMirroredAlertRule(userId, existing[0].stockCode, existing[0].indicator, instanceId);
    return { ok: true, message: `已删除 ${existing[0].stockCode} 的${indicatorNames[existing[0].indicator] || existing[0].indicator}提醒` };
  }));

  // ─── 信号配置 ───

  app.post<{ Body: { signalKey: string; enabled?: boolean; params?: Record<string, number | string> } }>("/api/signals/update", safe(async (request, reply) => {
    const { signalKey, enabled, params } = request.body ?? {};
    if (!signalKey) return reply.status(400).send({ ok: false, error: "缺少信号标识" });

    const result = await handleSignalConfigTool({ operation: "update", signalKey, enabled, params });
    return { ok: true, message: result };
  }));

  // ─── 巡检间隔 ───

  app.post<{ Body: { minutes: number } }>("/api/interval/set", safe(async (request, reply) => {
    const { minutes } = request.body ?? {};
    if (!Number.isFinite(minutes) || minutes < 1) return reply.status(400).send({ ok: false, error: "巡检间隔至少1分钟" });

    const result = await setAlertInterval(minutes);
    return { ok: true, message: result };
  }));

  // ─── ACP backend 切换 ───

  app.get("/api/acp-backends", safe(async () => {
    return { ok: true, ...(await listAcpBackends()) };
  }));

  app.post<{ Body: { backend: AcpBackendId } }>("/api/acp-backends/switch", safe(async (request, reply) => {
    const { backend } = request.body ?? {};
    if (!["kimi", "claude", "codex"].includes(backend)) {
      return reply.status(400).send({ ok: false, error: "backend 必须是 kimi / claude / codex" });
    }
    const status = await switchAcpBackend(backend);
    return { ok: true, status, backends: (await listAcpBackends()).backends };
  }));

  // ─── 复盘 ───

  app.post<{ Body: { date?: string; userId?: string } }>("/api/reviews/context", safe(async (request) => {
    const { userId, instanceId } = requestScope(request);
    const { date } = request.body ?? {};
    const context = await buildDailyReviewContext({ targetDate: date, userId, instanceId });
    return { ok: true, date: context.date, context };
  }));

  app.post<{ Body: { date?: string; userId?: string } }>("/api/reviews/weekly-context", safe(async (request) => {
    const { userId, instanceId } = requestScope(request);
    const { date } = request.body ?? {};
    const context = await buildWeeklyReviewContext({ date, userId, instanceId });
    return { ok: true, weekStart: context.weekStart, weekEnd: context.weekEnd, context };
  }));

  app.post<{ Body: { date?: string; userId?: string } }>("/api/reviews/monthly-context", safe(async (request) => {
    const { userId, instanceId } = requestScope(request);
    const { date } = request.body ?? {};
    const context = await buildMonthlyReviewContext({ date, userId, instanceId });
    return { ok: true, monthKey: context.monthKey, monthStart: context.monthStart, monthEnd: context.monthEnd, context };
  }));

  app.post<{ Body: { date?: string; content?: string; summary?: string; context?: unknown; userId?: string } }>("/api/reviews/save", safe(async (request, reply) => {
    const { userId, instanceId } = requestScope(request);
    const { date, content, summary, context } = request.body ?? {};
    if (!content?.trim()) return reply.status(400).send({ ok: false, error: "缺少复盘内容" });
    const saved = await saveSkillDailyReview({ userId, instanceId, date, content, summary, context });
    return { ok: true, ...saved };
  }));

  app.post<{ Body: { date?: string; force?: boolean; userId?: string } }>("/api/reviews/daily", safe(async (request) => {
    const { userId, instanceId } = requestScope(request);
    const { date, force } = request.body ?? {};
    const content = await generateDailyReview({ force: force ?? true, targetDate: date, userId, instanceId });
    return {
      ok: true,
      date: date ?? new Date().toISOString().slice(0, 10),
      content,
      summary: content.slice(0, 1200),
    };
  }));

  app.get<{ Querystring: { date?: string; userId?: string } }>("/api/reviews/query", safe(async (request) => {
    const userId = userIdFromRequest(request);
    const date = request.query?.date;
    if (!date) {
      return { ok: false, error: "缺少 date 参数，格式 YYYY-MM-DD" };
    }
    const content = await handleReviewTool({ operation: "query", date, userId });
    return { ok: true, date, content, summary: content.slice(0, 1200) };
  }));
}

function normalizeWatchlistReason(reason: string) {
  return reason.replace(/观察池/g, "自选池").trim();
}
