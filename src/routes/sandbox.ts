import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { alertEvents, alertRules, alerts, codexAcpTraces, indicatorResults, investmentProfiles, methodologyProfiles, portfolio, stockPlans, watchlist } from "../db/schema.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { ACTIVE_BACKEND } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { WorkspaceStore, type StrategyYaml } from "../lib/workspace-store.js";
import { sandboxContextFromRequest, type SandboxPermission } from "../lib/sandbox-context.js";
import { assertSandboxToolAllowed, type ToolId } from "../platform/tool-registry.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { getQuote } from "../services/stock.js";
import { buildDailyReviewContext, buildMonthlyReviewContext, buildWeeklyReviewContext, generateDailyReview, saveSkillDailyReview } from "../handlers/review.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { consumeSandboxConfirmation, createSandboxConfirmation, listPendingSandboxConfirmations } from "../lib/sandbox-confirmation.js";
import { deleteMirroredAlertRule, disableMirroredAlertRule, syncLegacyAlertToAlertRule } from "../handlers/alert-rules.js";
import { enqueuePushJob, getPushJob, processDuePushJobs, type PushBackend } from "../services/push-queue.js";

function normalizeWatchlistReason(reason: string) {
  return reason.replace(/观察池/g, "自选池").trim();
}

function jsonText(value: unknown, fallback: unknown) {
  if (value === undefined) return JSON.stringify(fallback);
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(value);
}

function parseJsonText(value: string | null | undefined, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeInvestmentProfile(row: typeof investmentProfiles.$inferSelect | undefined) {
  if (!row) return null;
  return {
    ...row,
    customStyle: parseJsonText(row.customStyle, {}),
    markets: parseJsonText(row.markets, []),
    allocation: parseJsonText(row.allocation, {}),
    positionRoles: parseJsonText(row.positionRoles, {}),
    buyRules: parseJsonText(row.buyRules, []),
    sellRules: parseJsonText(row.sellRules, []),
    rebalanceRules: parseJsonText(row.rebalanceRules, []),
    riskRules: parseJsonText(row.riskRules, []),
    notificationPolicy: parseJsonText(row.notificationPolicy, {}),
    decisionPolicy: parseJsonText(row.decisionPolicy, {}),
  };
}

function serializeMethodologyProfile(row: typeof methodologyProfiles.$inferSelect | undefined) {
  if (!row) return null;
  return {
    ...row,
    sourcePolicy: parseJsonText(row.sourcePolicy, {}),
  };
}

/**
 * workspace 模式下的 profile 序列化器,与 serializeInvestmentProfile 输出 shape 保持一致。
 *
 * 字段舍弃说明:customStyle/notificationPolicy/decisionPolicy 在 yaml 中无对应,统一返回空对象。
 */
function serializeInvestmentProfileFromYaml(strategy: StrategyYaml | null) {
  if (!strategy) return null;
  const profile = strategy.profile ?? {};
  return {
    style: profile.style ?? null,
    selectedStylePack: profile.selected_style_pack ?? null,
    customStyle: {},
    riskPreference: profile.risk_preference ?? null,
    investmentHorizon: profile.investment_horizon ?? null,
    markets: profile.markets ?? [],
    allocation: strategy.allocation ?? {},
    positionRoles: strategy.position_roles ?? {},
    buyRules: strategy.buy_rules ?? [],
    sellRules: strategy.sell_rules ?? [],
    rebalanceRules: strategy.rebalance_rules ?? [],
    riskRules: strategy.risk_rules ?? [],
    notificationPolicy: {},
    decisionPolicy: {},
    notes: strategy.notes ?? null,
    updatedAt: strategy.last_confirmed_at ?? null,
  };
}

function serializeMethodologyProfileFromMd(methods: { fundamental: string; technical: string; macro: string; risk: string }) {
  if (!methods.fundamental && !methods.technical && !methods.macro && !methods.risk) return null;
  return {
    fundamentalMethod: methods.fundamental,
    technicalMethod: methods.technical,
    macroMethod: methods.macro,
    riskMethod: methods.risk,
    sourcePolicy: {},
    notes: null,
    updatedAt: null,
  };
}

async function loadInvestmentProfile(ctx: { userId: string; instanceId: string }) {
  if (ACTIVE_BACKEND !== "workspace") {
    const rows = await db.select().from(investmentProfiles).where(and(eq(investmentProfiles.userId, ctx.userId), eq(investmentProfiles.instanceId, ctx.instanceId))).limit(1);
    return serializeInvestmentProfile(rows[0]);
  }
  const store = new WorkspaceStore(ctx.userId);
  const strategy = await store.readStrategy();
  return serializeInvestmentProfileFromYaml(strategy);
}

async function loadMethodologyProfile(ctx: { userId: string; instanceId: string }) {
  if (ACTIVE_BACKEND !== "workspace") {
    const rows = await db.select().from(methodologyProfiles).where(and(eq(methodologyProfiles.userId, ctx.userId), eq(methodologyProfiles.instanceId, ctx.instanceId))).limit(1);
    return serializeMethodologyProfile(rows[0]);
  }
  const store = new WorkspaceStore(ctx.userId);
  const methods = await store.readMethodology();
  return serializeMethodologyProfileFromMd(methods);
}

const indicatorNames: Record<string, string> = {
  price: "涨跌幅",
  turnover: "换手率",
  volume_ratio: "量比",
  macd: "MACD",
  breakout: "放量突破",
  break_support: "跌破支撑",
  target_price: "目标价",
  support_price: "支撑价",
};

function sandboxError(reply: any, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "SANDBOX_TOKEN_REQUIRED") {
    return reply.status(401).send({ ok: false, error: "sandbox token required" });
  }
  if (message === "SANDBOX_TOKEN_INVALID" || message === "SANDBOX_TOKEN_INVALID_PAYLOAD" || message === "SANDBOX_TOKEN_EXPIRED") {
    return reply.status(401).send({ ok: false, error: "sandbox token invalid or expired" });
  }
  if (message === "SANDBOX_PERMISSION_DENIED") {
    return reply.status(403).send({ ok: false, error: "sandbox permission denied" });
  }
  if (message === "SANDBOX_TOOL_UNKNOWN" || message === "SANDBOX_TOOL_NOT_ALLOWED") {
    return reply.status(403).send({ ok: false, error: "sandbox tool not allowed" });
  }
  logger.error("Sandbox API 操作失败:", error);
  return reply.status(500).send({ ok: false, error: "操作失败，请重试" });
}

function sandboxSafe(toolId: ToolId | ToolId[], handler: (ctx: ReturnType<typeof sandboxContextFromRequest>, request: any, reply: any) => Promise<any>, extraPermissions: SandboxPermission[] = []) {
  return async (request: any, reply: any) => {
    try {
      const ctx = sandboxContextFromRequest(request);
      const toolIds = Array.isArray(toolId) ? toolId : [toolId];
      for (const id of toolIds) {
        assertSandboxToolAllowed(ctx, id, extraPermissions);
      }
      return await handler(ctx, request, reply);
    } catch (error) {
      return sandboxError(reply, error);
    }
  };
}

async function audit(ctx: ReturnType<typeof sandboxContextFromRequest>, input: {
  operation: string;
  resourceType: string;
  resourceId?: string;
  requestBody?: unknown;
  resultSummary?: string;
  status?: "success" | "denied" | "error";
}) {
  await recordSandboxAudit({
    context: ctx,
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    requestBody: input.requestBody,
    resultSummary: input.resultSummary,
    status: input.status ?? "success",
  });
}

async function requireConfirmation(ctx: ReturnType<typeof sandboxContextFromRequest>, request: any, reply: any, operation: string, resourceType: string, resourceId?: string) {
  const confirmationId = typeof request.body?.confirmationId === "string" ? request.body.confirmationId.trim() : "";
  if (confirmationId) {
    const result = await consumeSandboxConfirmation(ctx, confirmationId, {
      operation,
      resourceType,
      resourceId,
      requestBody: request.body,
    });
    if (result.ok) return false;
    await audit(ctx, {
      operation,
      resourceType,
      resourceId,
      requestBody: request.body,
      resultSummary: `确认失败：${result.reason}`,
      status: "denied",
    });
    reply.status(409).send({
      ok: false,
      error: "confirmation invalid",
      message: `确认无效或已过期：${result.reason}`,
    });
    return true;
  }

  const pending = await createSandboxConfirmation(ctx, {
    operation,
    resourceType,
    resourceId,
    requestBody: request.body,
  });
  await audit(ctx, {
    operation,
    resourceType,
    resourceId,
    requestBody: request.body,
    resultSummary: `需要用户二次确认；confirmationId=${pending.id}`,
    status: "denied",
  });
  reply.status(409).send({
    ok: false,
    error: "confirmation required",
    confirmationId: pending.id,
    expiresAt: pending.expiresAt,
    message: "删除类操作需要用户二次确认。请向用户确认这次删除；用户确认后，在下一轮请求中带 confirmationId 重试。",
  });
  return true;
}

export function registerSandboxRoutes(app: FastifyInstance) {
  app.get("/api/sandbox/me", sandboxSafe("invest.dashboard.read", async (ctx) => ({
    ok: true,
    context: {
      userId: ctx.userId,
      projectId: ctx.projectId,
      instanceId: ctx.instanceId,
      projectType: ctx.projectType,
      skillBundleId: ctx.skillBundleId,
      role: ctx.role,
      channel: ctx.channel,
      backend: ctx.backend,
      conversationId: ctx.conversationId,
      permissions: ctx.permissions,
      tokenId: ctx.tokenId,
      expiresAt: ctx.expiresAt,
    },
  })));

  app.get("/api/sandbox/dashboard", sandboxSafe("invest.dashboard.read", async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const [holdings, watchItems, plans, legacyAlertRules, upgradedAlertRules, recentIndicatorResults, recentEvents, recentPlans, recentConversations, methodChangeRows, investmentProfile, methodologyProfile] =
      await Promise.all([
        db.select().from(portfolio).where(and(eq(portfolio.userId, ctx.userId), eq(portfolio.instanceId, ctx.instanceId), isNull(portfolio.sellDate))),
        db.select().from(watchlist).where(and(eq(watchlist.userId, ctx.userId), eq(watchlist.instanceId, ctx.instanceId))),
        db.select().from(stockPlans).where(and(eq(stockPlans.userId, ctx.userId), eq(stockPlans.instanceId, ctx.instanceId))),
        db.select().from(alerts).where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId))),
        db.select().from(alertRules).where(and(eq(alertRules.userId, ctx.userId), eq(alertRules.instanceId, ctx.instanceId))),
        db.select().from(indicatorResults).where(and(eq(indicatorResults.userId, ctx.userId), eq(indicatorResults.instanceId, ctx.instanceId))).orderBy(desc(indicatorResults.calculatedAt)).limit(50),
        db.select().from(alertEvents).where(and(eq(alertEvents.userId, ctx.userId), eq(alertEvents.instanceId, ctx.instanceId))).orderBy(desc(alertEvents.createdAt)).limit(50),
        // WP4.7:daily_plans 走 backend
        (async () => {
          const todayDate = new Date();
          const endDate = todayDate.toISOString().slice(0, 10);
          const startDate = new Date(todayDate.getTime() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
          const all = await dailyPlanBackend.listInRange(ctx.userId, ctx.instanceId, startDate, endDate);
          return all.slice(0, 5);
        })(),
        db.select().from(codexAcpTraces).where(and(eq(codexAcpTraces.userId, ctx.userId), eq(codexAcpTraces.instanceId, ctx.instanceId))).orderBy(desc(codexAcpTraces.createdAt)).limit(20),
        // WP4.9:method_change_candidates 走 backend。
        // 只回最近 7 天的 proposed 候选,避免老候选当作"待确认操作"污染 Codex 上下文。
        methodChangeBackend.list(ctx.userId, ctx.instanceId, { status: "proposed", limit: 20, maxAgeDays: 7 }),
        loadInvestmentProfile(ctx),
        loadMethodologyProfile(ctx),
      ]);
    const todayEvents = recentEvents.filter((event) => event.eventDate === today);
    return {
      ok: true,
      userId: ctx.userId,
      projectId: ctx.projectId,
      instanceId: ctx.instanceId,
      projectType: ctx.projectType,
      skillBundleId: ctx.skillBundleId,
      updatedAt: new Date().toISOString(),
      summary: {
        holdingCount: holdings.length,
        watchlistCount: watchItems.length,
        planCount: plans.length,
        alertRuleCount: upgradedAlertRules.filter((rule) => rule.enabled).length,
        todayEventCount: todayEvents.length,
        conversationCount: recentConversations.length,
        hasInvestmentProfile: investmentProfile !== null,
        hasMethodologyProfile: methodologyProfile !== null,
        // 仅统计最近 7 天的 proposed 候选;超过 7 天的老候选已自动从上下文里隐藏,可经 monthly-context 完整查看。
        proposedMethodChangeCount: methodChangeRows.length,
      },
      investmentProfile,
      methodologyProfile,
      proposedMethodChanges: methodChangeRows,
      holdings,
      watchlist: watchItems,
      plans,
      alertRules: legacyAlertRules,
      upgradedAlertRules,
      recentIndicatorResults,
      recentEvents,
      recentPlans,
    };
  }));

  app.get("/api/sandbox/confirmations/pending", sandboxSafe("invest.dashboard.read", async (ctx) => {
    const confirmations = await listPendingSandboxConfirmations(ctx);
    return { ok: true, userId: ctx.userId, projectId: ctx.projectId, instanceId: ctx.instanceId, confirmations };
  }));

  app.get("/api/sandbox/profiles", sandboxSafe("invest.profile.read", async (ctx) => {
    const [investmentProfile, methodologyProfile, changeRows] = await Promise.all([
      loadInvestmentProfile(ctx),
      loadMethodologyProfile(ctx),
      methodChangeBackend.list(ctx.userId, ctx.instanceId, { limit: 20 }),
    ]);
    return {
      ok: true,
      userId: ctx.userId,
      projectId: ctx.projectId,
      instanceId: ctx.instanceId,
      investmentProfile,
      methodologyProfile,
      methodChangeCandidates: changeRows,
    };
  }));

  app.post<{
    Body: {
      style?: string;
      selectedStylePack?: string | null;
      customStyle?: unknown;
      riskPreference?: string;
      investmentHorizon?: string;
      markets?: unknown;
      allocation?: unknown;
      positionRoles?: unknown;
      buyRules?: unknown;
      sellRules?: unknown;
      rebalanceRules?: unknown;
      riskRules?: unknown;
      notificationPolicy?: unknown;
      decisionPolicy?: unknown;
      notes?: string;
      confirmationId?: string;
    };
  }>("/api/sandbox/profiles/investment", sandboxSafe("invest.profile.write", async (ctx, request, reply) => {
    if (await requireConfirmation(ctx, request, reply, "profiles.investment.set", "investment_profile", ctx.instanceId)) return;
    const now = new Date().toISOString();
    const ignoredFields: string[] = [];
    if (request.body?.customStyle !== undefined) ignoredFields.push("customStyle");
    if (request.body?.notificationPolicy !== undefined) ignoredFields.push("notificationPolicy");
    if (request.body?.decisionPolicy !== undefined) ignoredFields.push("decisionPolicy");

    let investmentProfile;
    if (ACTIVE_BACKEND === "workspace") {
      investmentProfile = await writeInvestmentProfileToWorkspace(ctx.userId, request.body ?? {}, now);
    } else {
      const existing = await db.select().from(investmentProfiles).where(and(eq(investmentProfiles.userId, ctx.userId), eq(investmentProfiles.instanceId, ctx.instanceId))).limit(1);
      const values = {
        userId: ctx.userId,
        instanceId: ctx.instanceId,
        style: request.body?.style ?? existing[0]?.style ?? null,
        selectedStylePack: request.body?.selectedStylePack === undefined ? (existing[0]?.selectedStylePack ?? null) : request.body.selectedStylePack,
        customStyle: jsonText(request.body?.customStyle, parseJsonText(existing[0]?.customStyle, {})),
        riskPreference: request.body?.riskPreference ?? existing[0]?.riskPreference ?? null,
        investmentHorizon: request.body?.investmentHorizon ?? existing[0]?.investmentHorizon ?? null,
        markets: jsonText(request.body?.markets, parseJsonText(existing[0]?.markets, [])),
        allocation: jsonText(request.body?.allocation, parseJsonText(existing[0]?.allocation, {})),
        positionRoles: jsonText(request.body?.positionRoles, parseJsonText(existing[0]?.positionRoles, {})),
        buyRules: jsonText(request.body?.buyRules, parseJsonText(existing[0]?.buyRules, [])),
        sellRules: jsonText(request.body?.sellRules, parseJsonText(existing[0]?.sellRules, [])),
        rebalanceRules: jsonText(request.body?.rebalanceRules, parseJsonText(existing[0]?.rebalanceRules, [])),
        riskRules: jsonText(request.body?.riskRules, parseJsonText(existing[0]?.riskRules, [])),
        notificationPolicy: jsonText(request.body?.notificationPolicy, parseJsonText(existing[0]?.notificationPolicy, {})),
        decisionPolicy: jsonText(request.body?.decisionPolicy, parseJsonText(existing[0]?.decisionPolicy, {})),
        notes: request.body?.notes ?? existing[0]?.notes ?? null,
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing.length > 0) {
        await db.update(investmentProfiles).set(values).where(eq(investmentProfiles.id, existing[0].id));
      } else {
        await db.insert(investmentProfiles).values(values);
      }
      investmentProfile = serializeInvestmentProfile(values as typeof investmentProfiles.$inferSelect);
    }
    await audit(ctx, {
      operation: "profiles.investment.set",
      resourceType: "investment_profile",
      resourceId: ctx.instanceId,
      requestBody: request.body,
      resultSummary: `investment profile saved (workspace=${ACTIVE_BACKEND === "workspace"})`,
    });
    return { ok: true, userId: ctx.userId, message: "投资风格 Profile 已保存", investmentProfile, ignoredFields: ignoredFields.length ? ignoredFields : undefined };
  }));

  /**
   * 合并写入 strategy.yaml。仅更新 body 中提供的非空字段,保留其他字段不变。
   * 舍弃字段:customStyle、notificationPolicy、decisionPolicy。
   */
  async function writeInvestmentProfileToWorkspace(userId: string, body: {
    style?: string;
    selectedStylePack?: string | null;
    riskPreference?: string;
    investmentHorizon?: string;
    markets?: unknown;
    allocation?: unknown;
    positionRoles?: unknown;
    buyRules?: unknown;
    sellRules?: unknown;
    rebalanceRules?: unknown;
    riskRules?: unknown;
    notes?: string;
  }, now: string) {
    const store = new WorkspaceStore(userId);
    const existing = (await store.readStrategy()) ?? ({} as StrategyYaml);
    const profile = { ...(existing.profile ?? {}) };
    if (body.style !== undefined) profile.style = body.style;
    if (body.selectedStylePack !== undefined) profile.selected_style_pack = body.selectedStylePack;
    if (body.riskPreference !== undefined) profile.risk_preference = body.riskPreference;
    if (body.investmentHorizon !== undefined) profile.investment_horizon = body.investmentHorizon;
    if (body.markets !== undefined) profile.markets = body.markets as string[];
    const next: StrategyYaml = {
      ...existing,
      profile,
      allocation: body.allocation !== undefined ? (body.allocation as Record<string, unknown>) : existing.allocation,
      position_roles: body.positionRoles !== undefined ? (body.positionRoles as Record<string, unknown>) : existing.position_roles,
      buy_rules: body.buyRules !== undefined ? (body.buyRules as unknown[]) : existing.buy_rules,
      sell_rules: body.sellRules !== undefined ? (body.sellRules as unknown[]) : existing.sell_rules,
      rebalance_rules: body.rebalanceRules !== undefined ? (body.rebalanceRules as unknown[]) : existing.rebalance_rules,
      risk_rules: body.riskRules !== undefined ? (body.riskRules as unknown[]) : existing.risk_rules,
      notes: body.notes !== undefined ? body.notes : existing.notes,
      last_confirmed_at: now,
    };
    await store.writeStrategy(next);
    return serializeInvestmentProfileFromYaml(next);
  }

  app.post<{
    Body: {
      fundamentalMethod?: string;
      technicalMethod?: string;
      macroMethod?: string;
      riskMethod?: string;
      sourcePolicy?: unknown;
      notes?: string;
      confirmationId?: string;
    };
  }>("/api/sandbox/profiles/methodology", sandboxSafe("invest.profile.write", async (ctx, request, reply) => {
    if (await requireConfirmation(ctx, request, reply, "profiles.methodology.set", "methodology_profile", ctx.instanceId)) return;
    const now = new Date().toISOString();
    const ignoredFields: string[] = [];
    if (request.body?.sourcePolicy !== undefined) ignoredFields.push("sourcePolicy");

    let methodologyProfile;
    if (ACTIVE_BACKEND === "workspace") {
      methodologyProfile = await writeMethodologyProfileToWorkspace(ctx.userId, request.body ?? {});
    } else {
      const existing = await db.select().from(methodologyProfiles).where(and(eq(methodologyProfiles.userId, ctx.userId), eq(methodologyProfiles.instanceId, ctx.instanceId))).limit(1);
      const values = {
        userId: ctx.userId,
        instanceId: ctx.instanceId,
        fundamentalMethod: request.body?.fundamentalMethod ?? existing[0]?.fundamentalMethod ?? "",
        technicalMethod: request.body?.technicalMethod ?? existing[0]?.technicalMethod ?? "",
        macroMethod: request.body?.macroMethod ?? existing[0]?.macroMethod ?? "",
        riskMethod: request.body?.riskMethod ?? existing[0]?.riskMethod ?? "",
        sourcePolicy: jsonText(request.body?.sourcePolicy, parseJsonText(existing[0]?.sourcePolicy, {})),
        notes: request.body?.notes ?? existing[0]?.notes ?? null,
        createdAt: existing[0]?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing.length > 0) {
        await db.update(methodologyProfiles).set(values).where(eq(methodologyProfiles.id, existing[0].id));
      } else {
        await db.insert(methodologyProfiles).values(values);
      }
      methodologyProfile = serializeMethodologyProfile(values as typeof methodologyProfiles.$inferSelect);
    }
    await audit(ctx, {
      operation: "profiles.methodology.set",
      resourceType: "methodology_profile",
      resourceId: ctx.instanceId,
      requestBody: request.body,
      resultSummary: `methodology profile saved (workspace=${ACTIVE_BACKEND === "workspace"})`,
    });
    return { ok: true, userId: ctx.userId, message: "方法论 Profile 已保存", methodologyProfile, ignoredFields: ignoredFields.length ? ignoredFields : undefined };
  }));

  /**
   * 覆盖写入 knowledge/methods/*.md。空字符串字段跳过,保留原 md 内容。
   */
  async function writeMethodologyProfileToWorkspace(userId: string, body: {
    fundamentalMethod?: string;
    technicalMethod?: string;
    macroMethod?: string;
    riskMethod?: string;
  }) {
    const store = new WorkspaceStore(userId);
    const methods = await store.readMethodology();
    const next = {
      fundamental: body.fundamentalMethod ?? methods.fundamental,
      technical: body.technicalMethod ?? methods.technical,
      macro: body.macroMethod ?? methods.macro,
      risk: body.riskMethod ?? methods.risk,
    };
    await store.writeMethodology(next);
    return serializeMethodologyProfileFromMd(next);
  }

  app.post<{
    Body: {
      sourceReviewId?: string;
      sourceType?: string;
      proposedChange?: string;
      reason?: string;
      affectedResource?: string;
    };
  }>("/api/sandbox/method-changes/propose", sandboxSafe("invest.profile.write", async (ctx, request, reply) => {
    const proposedChange = request.body?.proposedChange?.trim();
    const reason = request.body?.reason?.trim();
    if (!proposedChange || !reason) return reply.status(400).send({ ok: false, error: "缺少 proposedChange 或 reason" });
    const created = await methodChangeBackend.propose({
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      sourceReviewId: request.body?.sourceReviewId,
      sourceType: request.body?.sourceType || "review",
      proposedChange,
      reason,
      affectedResource: request.body?.affectedResource || "methodology_profile",
    });
    await audit(ctx, {
      operation: "method_changes.propose",
      resourceType: "method_change_candidate",
      resourceId: String(created.id),
      requestBody: request.body,
      resultSummary: "proposed method change",
    });
    return { ok: true, userId: ctx.userId, candidate: created };
  }));

  app.post<{ Body: { id?: string | number; status?: "confirmed" | "rejected"; decisionNote?: string; confirmationId?: string } }>("/api/sandbox/method-changes/decide", sandboxSafe("invest.profile.write", async (ctx, request, reply) => {
    const { id, status, decisionNote } = request.body ?? {};
    if (!id || !status || !["confirmed", "rejected"].includes(status)) return reply.status(400).send({ ok: false, error: "缺少有效 id 或 status" });
    if (await requireConfirmation(ctx, request, reply, "method_changes.decide", "method_change_candidate", String(id))) return;
    const updated = await methodChangeBackend.decide({
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      id: String(id),
      status,
      decisionNote,
    });
    if (!updated) return { ok: false, error: "方法变更候选不存在", userId: ctx.userId };
    await audit(ctx, {
      operation: "method_changes.decide",
      resourceType: "method_change_candidate",
      resourceId: String(id),
      requestBody: request.body,
      resultSummary: `method change ${status}`,
    });
    return { ok: true, userId: ctx.userId, message: `方法变更候选已${status === "confirmed" ? "确认" : "拒绝"}` };
  }));

  app.post<{ Body: { name?: string; code?: string; reason?: string; userId?: string } }>("/api/sandbox/watchlist/add", sandboxSafe("invest.watchlist.write", async (ctx, request, reply) => {
    const { name, code, reason } = request.body ?? {};
    if (!name && !code) return reply.status(400).send({ ok: false, error: "请输入股票名称或代码" });
    const { codes, unresolved } = await resolveStockRefs([{ code, name }]);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: `未找到股票：${unresolved[0]?.name ?? code}` });

    const stockCode = codes[0];
    const existing = await db.select().from(watchlist).where(and(eq(watchlist.userId, ctx.userId), eq(watchlist.instanceId, ctx.instanceId), eq(watchlist.stockCode, stockCode))).limit(1);
    if (existing.length > 0) return { ok: false, error: `${existing[0].stockName}(${stockCode}) 已在自选池中`, userId: ctx.userId };

    const quotes = await getQuote([stockCode]);
    const stockName = quotes[0]?.name || name || stockCode;
    await db.insert(watchlist).values({
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      stockCode,
      stockName,
      addedAt: new Date().toISOString(),
      reason: normalizeWatchlistReason(reason || "AI 助手根据对话加入"),
      source: "ai_conversation",
    });
    await audit(ctx, {
      operation: "watchlist.add",
      resourceType: "watchlist",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `added ${stockName}(${stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `已添加 ${stockName}(${stockCode}) 到自选池` };
  }));

  app.post<{ Body: { code: string; userId?: string; confirmationId?: string } }>("/api/sandbox/watchlist/remove", sandboxSafe("invest.watchlist.write", async (ctx, request, reply) => {
    const { code } = request.body ?? {};
    if (!code) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    const existing = await db.select().from(watchlist).where(and(eq(watchlist.userId, ctx.userId), eq(watchlist.instanceId, ctx.instanceId), eq(watchlist.stockCode, code))).limit(1);
    if (existing.length === 0) return { ok: false, error: `${code} 不在自选池中`, userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "watchlist.remove", "watchlist", code)) return;
    await db.delete(watchlist).where(and(eq(watchlist.userId, ctx.userId), eq(watchlist.instanceId, ctx.instanceId), eq(watchlist.stockCode, code)));
    await audit(ctx, {
      operation: "watchlist.remove",
      resourceType: "watchlist",
      resourceId: code,
      requestBody: request.body,
      resultSummary: `removed ${existing[0].stockName}(${code})`,
    });
    return { ok: true, userId: ctx.userId, message: `已移除 ${existing[0].stockName}(${code})` };
  }));

  app.post<{ Body: { stockCode: string; stockName?: string; support?: number; resistance?: number; targetPrice?: number; stopLoss?: number; notes?: string; watchConditions?: PlanWatchConditionInput[]; linkedAlertRuleIds?: number[]; planType?: string; strategyKey?: string | null; userId?: string } }>("/api/sandbox/plans/set", sandboxSafe("invest.plan.write", async (ctx, request, reply) => {
    const { stockCode, stockName, support, resistance, targetPrice, stopLoss, notes, watchConditions, linkedAlertRuleIds, planType, strategyKey } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    const quotes = await getQuote([stockCode]);
    const name = stockName || quotes[0]?.name || stockCode;
    const existing = await db.select().from(stockPlans).where(and(eq(stockPlans.userId, ctx.userId), eq(stockPlans.instanceId, ctx.instanceId), eq(stockPlans.stockCode, stockCode))).limit(1);
    const values = {
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      stockCode,
      stockName: name,
      support: support !== undefined ? support : (existing[0]?.support ?? null),
      resistance: resistance !== undefined ? resistance : (existing[0]?.resistance ?? null),
      targetPrice: targetPrice !== undefined ? targetPrice : (existing[0]?.targetPrice ?? null),
      stopLoss: stopLoss !== undefined ? stopLoss : (existing[0]?.stopLoss ?? null),
      notes: notes !== undefined ? notes : (existing[0]?.notes ?? null),
      watchConditions: watchConditions !== undefined ? JSON.stringify(watchConditions) : (existing[0]?.watchConditions ?? null),
      linkedAlertRuleIds: linkedAlertRuleIds !== undefined ? JSON.stringify(linkedAlertRuleIds) : (existing[0]?.linkedAlertRuleIds ?? null),
      planType: planType ?? existing[0]?.planType ?? "manual",
      strategyKey: strategyKey !== undefined ? strategyKey : (existing[0]?.strategyKey ?? null),
      updatedAt: new Date().toISOString(),
    };
    if (existing.length > 0) {
      await db.update(stockPlans).set(values).where(and(eq(stockPlans.userId, ctx.userId), eq(stockPlans.instanceId, ctx.instanceId), eq(stockPlans.stockCode, stockCode)));
    } else {
      await db.insert(stockPlans).values(values);
    }
    await audit(ctx, {
      operation: "plans.set",
      resourceType: "stock_plan",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `${existing.length > 0 ? "updated" : "created"} ${name}(${stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `${name}(${stockCode}) 预案已${existing.length > 0 ? "更新" : "创建"}` };
  }));

  app.post<{ Body: { stockCode: string; stockName?: string; conditions: PlanWatchConditionInput[]; userId?: string } }>("/api/sandbox/plans/watch-conditions", sandboxSafe("invest.plan.write", async (ctx, request, reply) => {
    const { stockCode, stockName, conditions } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    if (!Array.isArray(conditions)) return reply.status(400).send({ ok: false, error: "conditions 必须是数组" });
    const result = await setPlanWatchConditions({ userId: ctx.userId, instanceId: ctx.instanceId, stockCode, stockName, conditions });
    await audit(ctx, {
      operation: "plans.watch_conditions",
      resourceType: "stock_plan",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `updated ${result.conditionCount} conditions for ${result.stockName}(${result.stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `${result.stockName}(${result.stockCode}) 已更新 ${result.conditionCount} 个观察条件`, ...result };
  }));

  app.post<{ Body: { stockCode: string; userId?: string; confirmationId?: string } }>("/api/sandbox/plans/remove", sandboxSafe("invest.plan.write", async (ctx, request, reply) => {
    const { stockCode } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    const existing = await db.select().from(stockPlans).where(and(eq(stockPlans.userId, ctx.userId), eq(stockPlans.instanceId, ctx.instanceId), eq(stockPlans.stockCode, stockCode))).limit(1);
    if (existing.length === 0) return { ok: false, error: `${stockCode} 暂无预案`, userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "plans.remove", "stock_plan", stockCode)) return;
    await db.delete(stockPlans).where(and(eq(stockPlans.userId, ctx.userId), eq(stockPlans.instanceId, ctx.instanceId), eq(stockPlans.stockCode, stockCode)));
    await audit(ctx, {
      operation: "plans.remove",
      resourceType: "stock_plan",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `removed ${existing[0].stockName}(${stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `已删除 ${existing[0].stockName}(${stockCode}) 的预案` };
  }));

  // ─── 交易策略 CRUD(workspace/config/trading_strategies.yaml) ───

  app.get("/api/sandbox/strategies", sandboxSafe("invest.strategy.read", async (ctx) => {
    const store = new WorkspaceStore(ctx.userId);
    const list = await store.readTradingStrategies();
    return { ok: true, userId: ctx.userId, strategies: list };
  }));

  app.post<{ Body: { key?: string; name?: string; applicability?: string; body?: string; enabled?: boolean; userId?: string } }>("/api/sandbox/strategies/set", sandboxSafe("invest.strategy.write", async (ctx, request, reply) => {
    const { key, name, applicability, body, enabled } = request.body ?? {};
    if (!key) return reply.status(400).send({ ok: false, error: "缺少策略 key" });
    if (!name) return reply.status(400).send({ ok: false, error: "缺少策略 name" });
    if (!body) return reply.status(400).send({ ok: false, error: "缺少策略 body" });
    const store = new WorkspaceStore(ctx.userId);
    const existing = (await store.readTradingStrategies()).find((s) => s.key === key);
    await store.writeTradingStrategy({ key, name, applicability, body, enabled });
    await audit(ctx, {
      operation: "strategies.set",
      resourceType: "trading_strategy",
      resourceId: key,
      requestBody: request.body,
      resultSummary: `${existing ? "updated" : "created"} strategy ${key}`,
    });
    return { ok: true, userId: ctx.userId, message: `策略 [${key}] ${name} 已${existing ? "更新" : "新增"}` };
  }));

  app.post<{ Body: { key?: string; userId?: string; confirmationId?: string } }>("/api/sandbox/strategies/remove", sandboxSafe("invest.strategy.write", async (ctx, request, reply) => {
    const { key } = request.body ?? {};
    if (!key) return reply.status(400).send({ ok: false, error: "缺少策略 key" });
    const store = new WorkspaceStore(ctx.userId);
    const existing = (await store.readTradingStrategies()).find((s) => s.key === key);
    if (!existing) return { ok: false, error: `未找到 key 为 ${key} 的策略`, userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "strategies.remove", "trading_strategy", key)) return;
    await store.removeTradingStrategy(key);
    await audit(ctx, {
      operation: "strategies.remove",
      resourceType: "trading_strategy",
      resourceId: key,
      requestBody: request.body,
      resultSummary: `removed strategy ${key}`,
    });
    return { ok: true, userId: ctx.userId, message: `已删除策略 [${key}] ${existing.name}` };
  }));

  app.post<{ Body: { date?: string; userId?: string } }>("/api/sandbox/reviews/context", sandboxSafe("invest.review.read", async (ctx, request) => {
    const { date } = request.body ?? {};
    const context = await buildDailyReviewContext({ targetDate: date, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, date: context.date, context };
  }));

  app.post<{ Body: { date?: string; userId?: string } }>("/api/sandbox/reviews/weekly-context", sandboxSafe("invest.review.read", async (ctx, request) => {
    const { date } = request.body ?? {};
    const context = await buildWeeklyReviewContext({ date, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, weekStart: context.weekStart, weekEnd: context.weekEnd, context };
  }));

  app.post<{ Body: { date?: string; userId?: string } }>("/api/sandbox/reviews/monthly-context", sandboxSafe("invest.review.read", async (ctx, request) => {
    const { date } = request.body ?? {};
    const context = await buildMonthlyReviewContext({ date, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, monthKey: context.monthKey, monthStart: context.monthStart, monthEnd: context.monthEnd, context };
  }));

  app.post<{ Body: { date?: string; content?: string; summary?: string; context?: unknown; userId?: string } }>("/api/sandbox/reviews/save", sandboxSafe("invest.review.write", async (ctx, request, reply) => {
    const { date, content, summary, context } = request.body ?? {};
    if (!content?.trim()) return reply.status(400).send({ ok: false, error: "缺少复盘内容" });
    const saved = await saveSkillDailyReview({ userId: ctx.userId, instanceId: ctx.instanceId, date, content, summary, context });
    await audit(ctx, {
      operation: "reviews.save",
      resourceType: "daily_review",
      resourceId: saved.date,
      requestBody: { date, summary, hasContent: Boolean(content), hasContext: Boolean(context) },
      resultSummary: `saved daily review ${saved.date}`,
    });
    return { ok: true, userId: ctx.userId, ...saved };
  }));

  app.post<{ Body: { date?: string; force?: boolean; userId?: string } }>("/api/sandbox/reviews/daily", sandboxSafe("invest.review.write", async (ctx, request) => {
    const { date, force } = request.body ?? {};
    const content = await generateDailyReview({ force: force ?? true, targetDate: date, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, date: date ?? new Date().toISOString().slice(0, 10), content, summary: content.slice(0, 1200) };
  }));

  app.post("/api/sandbox/alerts/check", sandboxSafe("invest.alert.check", async (ctx) => {
    const { runAlertCheck, formatAlerts } = await import("../scheduler/alert-check.js");
    const items = await runAlertCheck({ userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, count: items.length, alerts: items, text: items.length > 0 ? formatAlerts(items) : "当前无提醒" };
  }));

  app.post("/api/sandbox/alerts/check-and-push", sandboxSafe(["invest.alert.check", "push.weixin.send"], async (ctx, request) => {
    const { runAlertCheck, formatAlerts } = await import("../scheduler/alert-check.js");
    const { weixinMobileManager } = await import("../channels/weixin-mobile.js");
    const items = await runAlertCheck({ force: true, userId: ctx.userId, instanceId: ctx.instanceId });
    const text = items.length > 0 ? formatAlerts(items) : "当前强制巡检完成：没有触发提醒。";
    let pushed = false;
    let pushJobId: string | undefined;
    if (items.length > 0) {
      const backend = "codex" satisfies PushBackend;
      const job = await enqueuePushJob({
        userId: ctx.userId,
        projectId: ctx.projectId,
        instanceId: ctx.instanceId,
        backend,
        source: "sandbox-alert-check",
        message: text,
      });
      pushJobId = job.id;
      await processDuePushJobs(async (dueJob) => {
        if (dueJob.backend === "hermes") {
          // 旁路微信通道已下线,降级到主桥
        }
        return weixinMobileManager.pushText(dueJob.message, { userId: dueJob.userId });
      }, { limit: 5 });
      const updated = await getPushJob(job.id);
      pushed = updated?.status === "sent";
    }
    await audit(ctx, {
      operation: "alerts.check_and_push",
      resourceType: "alert_check",
      requestBody: request.body,
      resultSummary: `backend=${ctx.backend ?? "codex"}; count=${items.length}; pushed=${pushed}; pushJobId=${pushJobId ?? "-"}`,
    });
    return { ok: true, userId: ctx.userId, count: items.length, pushed, pushJobId, alerts: items, text };
  }));

  app.post<{ Body: { stockCode: string; stockName?: string; indicator: string; threshold?: number | string; userId?: string } }>("/api/sandbox/alerts/set", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const { stockCode, stockName, indicator, threshold } = request.body ?? {};
    if (!stockCode || !indicator) return reply.status(400).send({ ok: false, error: "缺少股票代码或指标" });

    const existing = await db
      .select()
      .from(alerts)
      .where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId), eq(alerts.stockCode, stockCode), eq(alerts.indicator, indicator)))
      .limit(1);

    const values = {
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      stockCode,
      indicator,
      threshold: JSON.stringify({ value: threshold ?? 3 }),
      enabled: true,
    };

    if (existing.length > 0) {
      await db.update(alerts).set(values).where(eq(alerts.id, existing[0].id));
    } else {
      await db.insert(alerts).values(values);
    }
    await syncLegacyAlertToAlertRule({
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      stockCode,
      stockName,
      indicator,
      threshold: values.threshold,
      enabled: true,
    });
    await audit(ctx, {
      operation: "alerts.set",
      resourceType: "alert_rule",
      resourceId: `${stockCode}:${indicator}`,
      requestBody: request.body,
      resultSummary: `${existing.length > 0 ? "updated" : "created"} ${stockCode} ${indicator}`,
    });

    const displayName = indicatorNames[indicator] || indicator;
    return { ok: true, userId: ctx.userId, message: `${stockName ?? stockCode} ${displayName} 提醒已${existing.length > 0 ? "更新" : "设置"}` };
  }));

  app.post<{ Body: { id: number; enabled: boolean; userId?: string; confirmationId?: string } }>("/api/sandbox/alerts/toggle", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const { id, enabled } = request.body ?? {};
    if (id == null || enabled == null || typeof id !== "number") return reply.status(400).send({ ok: false, error: "缺少参数" });

    const existing = await db.select().from(alerts).where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId), eq(alerts.id, id))).limit(1);
    if (existing.length === 0) return { ok: false, error: "提醒规则不存在", userId: ctx.userId };

    if (!enabled && await requireConfirmation(ctx, request, reply, "alerts.toggle_off", "alert_rule", String(id))) return;

    await db.update(alerts).set({ enabled }).where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId), eq(alerts.id, id)));
    await disableMirroredAlertRule(ctx.userId, existing[0].stockCode, existing[0].indicator, ctx.instanceId);
    if (enabled) {
      await syncLegacyAlertToAlertRule({
        userId: ctx.userId,
        instanceId: ctx.instanceId,
        stockCode: existing[0].stockCode,
        indicator: existing[0].indicator,
        threshold: existing[0].threshold,
        enabled: true,
      });
    }
    await audit(ctx, {
      operation: enabled ? "alerts.toggle_on" : "alerts.toggle_off",
      resourceType: "alert_rule",
      resourceId: String(id),
      requestBody: request.body,
      resultSummary: `${enabled ? "enabled" : "disabled"} ${existing[0].stockCode} ${existing[0].indicator}`,
    });
    return { ok: true, userId: ctx.userId, message: `提醒已${enabled ? "启用" : "关闭"}` };
  }));

  app.post<{ Body: { id: number; userId?: string; confirmationId?: string } }>("/api/sandbox/alerts/remove", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const { id } = request.body ?? {};
    if (id == null || typeof id !== "number") return reply.status(400).send({ ok: false, error: "缺少参数" });

    const existing = await db.select().from(alerts).where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId), eq(alerts.id, id))).limit(1);
    if (existing.length === 0) return { ok: false, error: "提醒规则不存在", userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "alerts.remove", "alert_rule", String(id))) return;

    await db.delete(alerts).where(and(eq(alerts.userId, ctx.userId), eq(alerts.instanceId, ctx.instanceId), eq(alerts.id, id)));
    await deleteMirroredAlertRule(ctx.userId, existing[0].stockCode, existing[0].indicator, ctx.instanceId);
    await audit(ctx, {
      operation: "alerts.remove",
      resourceType: "alert_rule",
      resourceId: String(id),
      requestBody: request.body,
      resultSummary: `removed ${existing[0].stockCode} ${existing[0].indicator}`,
    });
    return { ok: true, userId: ctx.userId, message: `已删除 ${existing[0].stockCode} 的${indicatorNames[existing[0].indicator] || existing[0].indicator}提醒` };
  }));
}
