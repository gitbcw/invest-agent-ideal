import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { alertEvents, alertRules, alerts, codexAcpTraces, indicatorResults, investmentProfiles, methodologyProfiles } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { ACTIVE_BACKEND, planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { WorkspaceStore, type OnboardingStepKey, type OnboardingStateYaml, type StrategyYaml } from "../lib/workspace-store.js";
import { sandboxContextFromRequest, type SandboxPermission } from "../lib/sandbox-context.js";
import { assertSandboxToolAllowed, type ToolId } from "../platform/tool-registry.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { buildDailyReviewContext, buildMonthlyReviewContext, buildWeeklyReviewContext, generateDailyReview, saveSkillDailyReview } from "../handlers/review.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { consumeSandboxConfirmation, createSandboxConfirmation, listPendingSandboxConfirmations } from "../lib/sandbox-confirmation.js";
import { deleteMirroredAlertRule, disableMirroredAlertRule, syncLegacyAlertToAlertRule } from "../handlers/alert-rules.js";
import { enqueuePushJob, getPushJob, processDuePushJobs, type PushBackend } from "../services/push-queue.js";
import { createWatchRule, deleteWatchRule, dryRunWatchRuleById, listWatchRuleCatalog, listWatchRules, updateWatchRule, validateWatchRule } from "../services/watch-rules.js";
import { marketCalendar, marketCapitalFlow, marketHealth, marketIndices, marketKline, marketQuote, marketResolve, marketSectorTheme, marketSnapshot, marketStockInfo, type MarketKlinePeriod } from "../services/market-data.js";

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

function splitCodes(value: string | undefined) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeHolding(row: Awaited<ReturnType<typeof portfolioBackend.listActive>>[number], userId: string, instanceId: string) {
  return {
    id: row.rowId,
    userId: row.userId ?? userId,
    instanceId: row.instanceId ?? instanceId,
    stockCode: row.code,
    stockName: row.name,
    buyDate: row.buyDate,
    buyPrice: row.costPrice ?? null,
    sellPrice: row.sellPrice ?? null,
    sellDate: row.sellDate ?? null,
    status: row.status,
  };
}

function serializeWatchItem(row: Awaited<ReturnType<typeof watchlistBackend.list>>[number], userId: string, instanceId: string) {
  return {
    id: row.rowId,
    userId: row.userId ?? userId,
    instanceId: row.instanceId ?? instanceId,
    stockCode: row.code,
    stockName: row.name,
    addedAt: row.addedAt,
    reason: row.reason ?? null,
    source: row.source ?? "manual",
  };
}

function serializePlan(row: Awaited<ReturnType<typeof planBackend.list>>[number], userId: string, instanceId: string) {
  return {
    id: row.rowId,
    userId: row.userId ?? userId,
    instanceId: row.instanceId ?? instanceId,
    stockCode: row.code,
    stockName: row.name,
    support: row.support ?? null,
    resistance: row.resistance ?? null,
    targetPrice: row.targetPrice ?? null,
    stopLoss: row.stopLoss ?? null,
    notes: row.notes ?? null,
    watchConditions: typeof row.watchConditions === "string" ? row.watchConditions : JSON.stringify(row.watchConditions ?? null),
    linkedAlertRuleIds: JSON.stringify(row.linkedAlertRuleIds ?? []),
    planType: row.planType ?? "manual",
    strategyKey: row.strategyKey ?? null,
    updatedAt: row.updatedAt,
  };
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

async function handleMarketSnapshot(ctx: ReturnType<typeof sandboxContextFromRequest>, body?: { includeCapitalFlow?: boolean }) {
  const result = await marketSnapshot({
    userId: ctx.userId,
    instanceId: ctx.instanceId,
    includeCapitalFlow: body?.includeCapitalFlow === true,
  });
  await audit(ctx, {
    operation: "market.snapshot",
    resourceType: "market_data",
    requestBody: body,
    resultSummary: `holdings=${result.holdings.length}; watchlist=${result.watchlist.length}; plans=${result.plans.length}; warnings=${result.warnings.length}`,
  });
  return result;
}

const ONBOARDING_STEPS: OnboardingStepKey[] = [
  "welcome",
  "portfolio",
  "style",
  "review_schedule",
  "notification",
  "watch_rules",
];

function nextOnboardingStep(step: OnboardingStepKey): OnboardingStepKey | "completed" {
  const idx = ONBOARDING_STEPS.indexOf(step);
  return idx >= 0 && idx < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[idx + 1] : "completed";
}

function normalizeOnboardingState(state: OnboardingStateYaml): OnboardingStateYaml {
  const steps = { ...(state.steps ?? {}) };
  for (const key of ONBOARDING_STEPS) {
    steps[key] = {
      done: steps[key]?.done === true,
      completed_at: steps[key]?.completed_at ?? null,
    };
  }
  return {
    version: state.version ?? 1,
    status: state.status ?? "not_started",
    current_step: state.current_step ?? "welcome",
    steps,
    completed_at: state.completed_at ?? null,
    updated_at: state.updated_at ?? null,
    notes: state.notes ?? "",
  };
}

function isOnboardingStep(value: unknown): value is OnboardingStepKey {
  return typeof value === "string" && (ONBOARDING_STEPS as string[]).includes(value);
}

const DEFAULT_WATCH_CHECK_WINDOWS = [
  { name: "开盘后", time: "09:55", purpose: "检查核心持仓、观察仓和市场风格是否出现开盘异常。" },
  { name: "午盘前", time: "11:20", purpose: "检查风格切换、板块异动和持仓是否偏离日复盘判断。" },
  { name: "收盘前", time: "14:30", purpose: "检查是否触发买入区、减仓区或风险阈值。" },
];

const WATCH_WINDOW_PURPOSES: Record<string, { name: string; purpose: string }> = {
  "09:30": { name: "开盘简报", purpose: "检查开盘状态、核心/非核心是否异常跳空。" },
  "10:00": { name: "早盘简报", purpose: "检查早盘第一轮走势、是否接近触发区。" },
  "11:00": { name: "上午趋势简报", purpose: "检查上午趋势确认、强弱分化。" },
  "12:00": { name: "午间简报", purpose: "汇总上午结论和下午关注点。" },
  "13:00": { name: "午后开盘简报", purpose: "检查午后开盘状态。" },
  "14:00": { name: "尾盘前简报", purpose: "检查尾盘前风险和是否接近操作触发。" },
  "15:00": { name: "收盘快照", purpose: "汇总收盘状态，识别晚间日复盘重点。" },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeTimeToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeTimeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const times: string[] = [];
  for (const item of value) {
    const time = normalizeTimeToken(item);
    if (!time || seen.has(time)) continue;
    seen.add(time);
    times.push(time);
  }
  return times;
}

function buildWatchWindowsFromTimes(times: string[]) {
  return times.map((time) => ({
    name: WATCH_WINDOW_PURPOSES[time]?.name ?? `${time}简报`,
    time,
    purpose: WATCH_WINDOW_PURPOSES[time]?.purpose ?? "按用户确认的固定盘中时间检查组合状态和规则触发。",
  }));
}

function deriveWatchWindows(input: {
  watch: Record<string, unknown>;
  watchDefaults: Record<string, unknown>;
  schedules: Record<string, unknown>;
  notification: Record<string, unknown>;
}) {
  const explicitWatchWindows = Array.isArray(input.watchDefaults.default_check_windows) && input.watchDefaults.default_check_windows.length > 0
    ? input.watchDefaults.default_check_windows
    : null;
  if (explicitWatchWindows) return explicitWatchWindows;

  const explicitWatchTimes = normalizeTimeList(asRecord(input.watchDefaults.fixed_intraday_brief).times);
  if (explicitWatchTimes.length > 0) return buildWatchWindowsFromTimes(explicitWatchTimes);

  const notificationTimes = normalizeTimeList(asRecord(input.notification.intraday_push).times);
  if (notificationTimes.length > 0) return buildWatchWindowsFromTimes(notificationTimes);

  const scheduleTimes = normalizeTimeList(asRecord(input.schedules.market_watch).default_windows);
  if (scheduleTimes.length > 0) return buildWatchWindowsFromTimes(scheduleTimes);

  return Array.isArray(input.watch.default_check_windows) && input.watch.default_check_windows.length > 0
    ? input.watch.default_check_windows
    : DEFAULT_WATCH_CHECK_WINDOWS;
}

async function applyOnboardingStepDefaults(
  store: WorkspaceStore,
  step: OnboardingStepKey,
  now: string,
  body: Record<string, unknown>
) {
  if (step === "review_schedule") {
    const schedules = await store.readSchedules() ?? {};
    const reviewDefaults = body.reviewSchedule && typeof body.reviewSchedule === "object"
      ? body.reviewSchedule as Record<string, unknown>
      : {};
    await store.writeSchedules({
      ...schedules,
      timezone: schedules.timezone ?? "Asia/Shanghai",
      run_policy: {
        automatic_by_default: true,
        manual_trigger_allowed: true,
        skip_automatic_if_manual_report_exists: true,
        refresh_requires_user_confirmation: true,
        ...(schedules.run_policy && typeof schedules.run_policy === "object" ? schedules.run_policy as Record<string, unknown> : {}),
      },
      daily_review: {
        enabled: true,
        auto_run: true,
        default_time: "19:00",
        trading_days_only: true,
        ...(reviewDefaults.daily_review && typeof reviewDefaults.daily_review === "object" ? reviewDefaults.daily_review as Record<string, unknown> : {}),
      },
      weekly_review: {
        enabled: true,
        auto_run: true,
        default_time: "Saturday 09:00",
        ...(reviewDefaults.weekly_review && typeof reviewDefaults.weekly_review === "object" ? reviewDefaults.weekly_review as Record<string, unknown> : {}),
      },
      monthly_review: {
        enabled: true,
        auto_run: true,
        default_time: "day_1 09:00",
        review_previous_month: true,
        ...(reviewDefaults.monthly_review && typeof reviewDefaults.monthly_review === "object" ? reviewDefaults.monthly_review as Record<string, unknown> : {}),
      },
      company_financial_analysis: {
        enabled: true,
        trigger: "user_request_or_new_report_detected",
        ...(reviewDefaults.company_financial_analysis && typeof reviewDefaults.company_financial_analysis === "object" ? reviewDefaults.company_financial_analysis as Record<string, unknown> : {}),
      },
    });
  }

  if (step === "notification") {
    const notification = await store.readNotification() ?? {};
    await store.writeNotification({
      ...notification,
      user_mode: notification.user_mode ?? "working_professional",
      working_hours: {
        start: "09:00",
        end: "18:00",
        policy: "工作时间只推 P0，P1/P2 延后到晚间简报。",
        ...(notification.working_hours && typeof notification.working_hours === "object" ? notification.working_hours as Record<string, unknown> : {}),
      },
      do_not_disturb: {
        enabled: true,
        allow_p0_override: true,
        ...(notification.do_not_disturb && typeof notification.do_not_disturb === "object" ? notification.do_not_disturb as Record<string, unknown> : {}),
      },
      last_confirmed_at: now,
    });
  }

  if (step === "watch_rules") {
    const watch = await store.readWatch() ?? {};
    const schedules = await store.readSchedules() ?? {};
    const notification = await store.readNotification() ?? {};
    const watchDefaults = body.watchPolicy && typeof body.watchPolicy === "object"
      ? body.watchPolicy as Record<string, unknown>
      : {};
    const defaultCheckWindows = deriveWatchWindows({
      watch: watch as Record<string, unknown>,
      watchDefaults,
      schedules,
      notification,
    });
    await store.writeWatch({
      ...watch,
      mode: typeof watch.mode === "string" ? watch.mode : "default",
      only_push_on_exception: true,
      priority_policy: "P0 立即推送；P1 晚间汇总；P2 仅记录。详见 config/notification.yaml。",
      default_check_windows: defaultCheckWindows,
      exception_rules: Array.isArray(watch.exception_rules) && watch.exception_rules.length > 0
        ? watch.exception_rules
        : [
            "核心持仓接近用户设定的买入区或减仓区。",
            "观察仓进入用户设定的配置区。",
            "持仓、行业或指数走势与日复盘核心判断明显相反。",
            "重大新闻、财报、政策或商品价格变化影响持仓逻辑。",
          ],
      custom_rules: Array.isArray(watch.custom_rules) ? watch.custom_rules : [],
      last_confirmed_at: now,
      confirmed_watch_rule_summary: [
        "已确认默认盯盘策略和低打扰口径。",
        "尚未批量创建具体阶段二明确规则；如需创建均线、价格或技术指标提醒，应单独向用户确认后再调用 watch-rule API。",
      ],
      ...watchDefaults,
    });
  }
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
    const [portfolioRows, watchlistRows, planRows, legacyAlertRules, upgradedAlertRules, recentIndicatorResults, recentEvents, recentPlans, recentConversations, methodChangeRows, investmentProfile, methodologyProfile] =
      await Promise.all([
        portfolioBackend.listActive(ctx.userId, ctx.instanceId),
        watchlistBackend.list(ctx.userId, ctx.instanceId),
        planBackend.list(ctx.userId, ctx.instanceId),
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
        // 只回最近 7 天的 proposed 候选,避免老候选当作"待确认操作"污染 agent 上下文。
        methodChangeBackend.list(ctx.userId, ctx.instanceId, { status: "proposed", limit: 20, maxAgeDays: 7 }),
        loadInvestmentProfile(ctx),
        loadMethodologyProfile(ctx),
      ]);
    const holdings = portfolioRows.map((row) => serializeHolding(row, ctx.userId, ctx.instanceId));
    const watchItems = watchlistRows.map((row) => serializeWatchItem(row, ctx.userId, ctx.instanceId));
    const plans = planRows.map((row) => serializePlan(row, ctx.userId, ctx.instanceId));
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

  app.get("/api/sandbox/onboarding/state", sandboxSafe("invest.onboarding.read", async (ctx) => {
    const store = new WorkspaceStore(ctx.userId);
    const state = normalizeOnboardingState(await store.readOnboardingState());
    await audit(ctx, {
      operation: "onboarding.state.read",
      resourceType: "onboarding_state",
      resultSummary: `status=${state.status}; current=${state.current_step ?? "-"}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, state };
  }));

  app.post<{
    Body: {
      step?: string;
      summary?: string;
      notes?: string;
      reviewSchedule?: Record<string, unknown>;
      watchPolicy?: Record<string, unknown>;
      complete?: boolean;
    };
  }>("/api/sandbox/onboarding/confirm-step", sandboxSafe("invest.onboarding.write", async (ctx, request, reply) => {
    const step = request.body?.step;
    if (!isOnboardingStep(step)) {
      return reply.status(400).send({ ok: false, error: `非法 onboarding step: ${String(step ?? "")}` });
    }

    const now = new Date().toISOString();
    const store = new WorkspaceStore(ctx.userId);
    await applyOnboardingStepDefaults(store, step, now, request.body ?? {});

    const current = normalizeOnboardingState(await store.readOnboardingState());
    const steps = { ...(current.steps ?? {}) };
    steps[step] = { done: true, completed_at: steps[step]?.completed_at ?? now };
    const allDone = ONBOARDING_STEPS.every((key) => key === step || steps[key]?.done === true);
    const shouldComplete = request.body?.complete === true || allDone || step === "watch_rules";
    const nextState: OnboardingStateYaml = {
      ...current,
      status: shouldComplete ? "completed" : "in_progress",
      current_step: shouldComplete ? "completed" : nextOnboardingStep(step),
      steps,
      completed_at: shouldComplete ? (current.completed_at ?? now) : current.completed_at ?? null,
      updated_at: now,
      notes: request.body?.notes ?? current.notes ?? "",
    };
    await store.writeOnboardingState(nextState);
    await store.appendChangeLog({
      ts: now,
      source: "sandbox",
      type: `onboarding_${step}_confirmed`,
      summary: request.body?.summary || `用户确认 onboarding 步骤: ${step}`,
      details: {
        step,
        status: nextState.status,
        current_step: nextState.current_step,
        did_create_watch_rules: false,
      },
    });
    await audit(ctx, {
      operation: "onboarding.confirm_step",
      resourceType: "onboarding_state",
      resourceId: step,
      requestBody: request.body,
      resultSummary: `confirmed ${step}; status=${nextState.status}; no watch-rule batch create`,
    });
    return {
      ok: true,
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      state: nextState,
      didCreateWatchRules: false,
      message: shouldComplete ? "新手引导已完成" : `已确认 ${step}`,
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
    const existing = await watchlistBackend.find(ctx.userId, ctx.instanceId, stockCode);
    if (existing) return { ok: false, error: `${existing.name}(${stockCode}) 已在自选池中`, userId: ctx.userId };

    const quoteResult = await marketQuote([stockCode], ctx.userId);
    const stockName = quoteResult.items[0]?.name || name || stockCode;
    await watchlistBackend.add(ctx.userId, ctx.instanceId, {
      code: stockCode,
      name: stockName,
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
    const existing = await watchlistBackend.find(ctx.userId, ctx.instanceId, code);
    if (!existing) return { ok: false, error: `${code} 不在自选池中`, userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "watchlist.remove", "watchlist", code)) return;
    await watchlistBackend.remove(ctx.userId, ctx.instanceId, code);
    await audit(ctx, {
      operation: "watchlist.remove",
      resourceType: "watchlist",
      resourceId: code,
      requestBody: request.body,
      resultSummary: `removed ${existing.name}(${code})`,
    });
    return { ok: true, userId: ctx.userId, message: `已移除 ${existing.name}(${code})` };
  }));

  app.post<{ Body: { stockCode: string; stockName?: string; support?: number; resistance?: number; targetPrice?: number; stopLoss?: number; notes?: string; watchConditions?: PlanWatchConditionInput[]; linkedAlertRuleIds?: number[]; planType?: string; strategyKey?: string | null; userId?: string } }>("/api/sandbox/plans/set", sandboxSafe("invest.plan.write", async (ctx, request, reply) => {
    const { stockCode, stockName, support, resistance, targetPrice, stopLoss, notes, watchConditions, linkedAlertRuleIds, planType, strategyKey } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    const quoteResult = await marketQuote([stockCode], ctx.userId);
    const name = stockName || quoteResult.items[0]?.name || stockCode;
    const existing = await planBackend.find(ctx.userId, ctx.instanceId, stockCode);
    await planBackend.upsert(ctx.userId, ctx.instanceId, {
      code: stockCode,
      name,
      support: support !== undefined ? support : (existing?.support ?? null),
      resistance: resistance !== undefined ? resistance : (existing?.resistance ?? null),
      targetPrice: targetPrice !== undefined ? targetPrice : (existing?.targetPrice ?? null),
      stopLoss: stopLoss !== undefined ? stopLoss : (existing?.stopLoss ?? null),
      notes: notes !== undefined ? notes : (existing?.notes ?? null),
      watchConditions: watchConditions !== undefined ? watchConditions : existing?.watchConditions,
      linkedAlertRuleIds: linkedAlertRuleIds !== undefined ? linkedAlertRuleIds.map(String) : existing?.linkedAlertRuleIds,
      planType: planType ?? existing?.planType ?? "manual",
      strategyKey: strategyKey !== undefined ? strategyKey : (existing?.strategyKey ?? null),
    });
    await audit(ctx, {
      operation: "plans.set",
      resourceType: "stock_plan",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `${existing ? "updated" : "created"} ${name}(${stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `${name}(${stockCode}) 预案已${existing ? "更新" : "创建"}` };
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
    const existing = await planBackend.find(ctx.userId, ctx.instanceId, stockCode);
    if (!existing) return { ok: false, error: `${stockCode} 暂无预案`, userId: ctx.userId };
    if (await requireConfirmation(ctx, request, reply, "plans.remove", "stock_plan", stockCode)) return;
    await planBackend.remove(ctx.userId, ctx.instanceId, stockCode);
    await audit(ctx, {
      operation: "plans.remove",
      resourceType: "stock_plan",
      resourceId: stockCode,
      requestBody: request.body,
      resultSummary: `removed ${existing.name}(${stockCode})`,
    });
    return { ok: true, userId: ctx.userId, message: `已删除 ${existing.name}(${stockCode}) 的预案` };
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

  app.post<{ Body: { force?: boolean } }>("/api/sandbox/alerts/check", sandboxSafe("invest.alert.check", async (ctx, request) => {
    const { runAlertCheck, formatAlerts } = await import("../scheduler/alert-check.js");
    const items = await runAlertCheck({ force: request.body?.force === true, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, count: items.length, alerts: items, text: items.length > 0 ? formatAlerts(items) : "当前无提醒" };
  }));

  app.get<{ Querystring: { codes?: string } }>("/api/sandbox/market/quote", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const codes = splitCodes(request.query.codes);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: "缺少 codes" });
    const result = await marketQuote(codes, ctx.userId);
    await audit(ctx, {
      operation: "market.quote",
      resourceType: "market_data",
      requestBody: { codes },
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.get<{ Querystring: { code?: string; period?: string; count?: string; startDate?: string; endDate?: string } }>("/api/sandbox/market/kline", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const code = request.query.code?.trim();
    if (!code) return reply.status(400).send({ ok: false, error: "缺少 code" });
    const period = request.query.period === "m5" ? "m5" : "day";
    const result = await marketKline({
      code,
      period: period as MarketKlinePeriod,
      count: request.query.count ? Number(request.query.count) : undefined,
      startDate: request.query.startDate,
      endDate: request.query.endDate,
    }, ctx.userId);
    await audit(ctx, {
      operation: "market.kline",
      resourceType: "market_data",
      resourceId: code,
      requestBody: request.query,
      resultSummary: `period=${result.period}; count=${result.items.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), result };
  }));

  app.get("/api/sandbox/market/indices", sandboxSafe("invest.market.read", async (ctx) => {
    const result = await marketIndices(ctx.userId);
    await audit(ctx, {
      operation: "market.indices",
      resourceType: "market_data",
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.get<{ Querystring: { codes?: string } }>("/api/sandbox/market/capital-flow", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const codes = splitCodes(request.query.codes);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: "缺少 codes" });
    const result = await marketCapitalFlow(codes, ctx.userId);
    await audit(ctx, {
      operation: "market.capital_flow",
      resourceType: "market_data",
      requestBody: { codes },
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.get<{ Querystring: { codes?: string } }>("/api/sandbox/market/sector-theme", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const codes = splitCodes(request.query.codes);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: "缺少 codes" });
    const result = await marketSectorTheme(codes, ctx.userId);
    await audit(ctx, {
      operation: "market.sector_theme",
      resourceType: "market_data",
      requestBody: { codes },
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.get<{ Querystring: { codes?: string; days?: string } }>("/api/sandbox/market/stock-info", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const codes = splitCodes(request.query.codes);
    if (codes.length === 0) return reply.status(400).send({ ok: false, error: "缺少 codes" });
    const result = await marketStockInfo(codes.map((code) => ({ code })), {
      days: request.query.days ? Number(request.query.days) : undefined,
    }, ctx.userId);
    await audit(ctx, {
      operation: "market.stock_info",
      resourceType: "market_data",
      requestBody: request.query,
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.get<{ Querystring: { keyword?: string } }>("/api/sandbox/market/resolve", sandboxSafe("invest.market.read", async (ctx, request, reply) => {
    const keyword = request.query.keyword?.trim();
    if (!keyword) return reply.status(400).send({ ok: false, error: "缺少 keyword" });
    const result = await marketResolve(keyword, ctx.userId);
    await audit(ctx, {
      operation: "market.resolve",
      resourceType: "market_data",
      requestBody: { keyword },
      resultSummary: `count=${result.items.length}; warnings=${result.warnings.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), ...result };
  }));

  app.post<{ Body: { includeCapitalFlow?: boolean } }>("/api/sandbox/market/snapshot", sandboxSafe("invest.market.read", async (ctx, request) => {
    return handleMarketSnapshot(ctx, request.body);
  }));

  app.get<{ Querystring: { includeCapitalFlow?: string } }>("/api/sandbox/market/snapshot", sandboxSafe("invest.market.read", async (ctx, request) => {
    return handleMarketSnapshot(ctx, { includeCapitalFlow: request.query.includeCapitalFlow === "true" });
  }));

  app.get("/api/sandbox/market/health", sandboxSafe("invest.market.read", async (ctx) => {
    const result = await marketHealth();
    await audit(ctx, {
      operation: "market.health",
      resourceType: "market_data",
      resultSummary: `endpoints=${result.endpoints.length}; failed=${result.endpoints.filter((e) => e.lastStatus === "fail").length}`,
    });
    return { ...result, userId: ctx.userId, instanceId: ctx.instanceId };
  }));

  app.get<{ Querystring: { date?: string } }>("/api/sandbox/market/calendar", sandboxSafe("invest.market.read", async (ctx, request) => {
    const date = request.query.date ? new Date(`${request.query.date}T00:00:00+08:00`) : new Date();
    const result = await marketCalendar(date, ctx.userId);
    await audit(ctx, {
      operation: "market.calendar",
      resourceType: "market_data",
      requestBody: request.query,
      resultSummary: `date=${result.dateKey}; tradingDay=${result.isTradingDay}; session=${result.session}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, updatedAt: new Date().toISOString(), result };
  }));

  app.post("/api/sandbox/alerts/check-and-push", sandboxSafe(["invest.alert.check", "push.weixin.send"], async (ctx, request) => {
    const { runAlertCheck, formatAlerts } = await import("../scheduler/alert-check.js");
    const { weixinMobileManager } = await import("../channels/weixin-mobile.js");
    const items = await runAlertCheck({ force: true, userId: ctx.userId, instanceId: ctx.instanceId });
    const text = items.length > 0 ? formatAlerts(items) : "当前强制巡检完成：没有触发提醒。";
    let pushed = false;
    let pushJobId: string | undefined;
    if (items.length > 0) {
      const backend = "hermes" satisfies PushBackend;
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
        resultSummary: `backend=${ctx.backend ?? "hermes"}; count=${items.length}; pushed=${pushed}; pushJobId=${pushJobId ?? "-"}`,
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

  app.get("/api/sandbox/watch-rules/catalog", sandboxSafe("invest.alert.read", async (ctx) => {
    await audit(ctx, {
      operation: "watch_rules.catalog",
      resourceType: "watch_rule_catalog",
      resultSummary: "list catalog",
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, items: listWatchRuleCatalog() };
  }));

  app.get("/api/sandbox/watch-rules", sandboxSafe("invest.alert.read", async (ctx) => {
    const items = await listWatchRules(ctx.userId, ctx.instanceId);
    await audit(ctx, {
      operation: "watch_rules.list",
      resourceType: "watch_rule",
      resultSummary: `count=${items.length}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, items };
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/sandbox/watch-rules/validate", sandboxSafe("invest.alert.read", async (ctx, request, reply) => {
    const validation = await validateWatchRule({ ...request.body, userId: ctx.userId, instanceId: ctx.instanceId });
    await audit(ctx, {
      operation: "watch_rules.validate",
      resourceType: "watch_rule",
      requestBody: request.body,
      resultSummary: validation.ok ? "ok" : `errors=${validation.errors.join("|")}`,
    });
    if (!validation.ok) return reply.status(400).send({ ok: false, userId: ctx.userId, instanceId: ctx.instanceId, errors: validation.errors });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, validation };
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/sandbox/watch-rules", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const rule = await createWatchRule({
      ...(request.body as any),
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      source: { kind: "sandbox_api", actor: "workspace_skill" },
    });
    await audit(ctx, {
      operation: "watch_rules.create",
      resourceType: "watch_rule",
      resourceId: String(rule.id),
      requestBody: request.body,
      resultSummary: `created ${rule.ruleType} ${rule.stockCode}`,
    });
    return reply.status(201).send({ ok: true, userId: ctx.userId, instanceId: ctx.instanceId, rule });
  }));

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/sandbox/watch-rules/:id", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    const rule = await updateWatchRule(id, {
      ...(request.body as any),
      source: { kind: "sandbox_api", actor: "workspace_skill" },
    }, ctx.userId, ctx.instanceId);
    await audit(ctx, {
      operation: "watch_rules.update",
      resourceType: "watch_rule",
      resourceId: String(rule.id),
      requestBody: request.body,
      resultSummary: `updated ${rule.ruleType} ${rule.stockCode}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, rule };
  }));

  app.delete<{ Params: { id: string }; Body: { confirmationId?: string } }>("/api/sandbox/watch-rules/:id", sandboxSafe("invest.alert.write", async (ctx, request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    if (await requireConfirmation(ctx, request, reply, "watch_rules.remove", "watch_rule", String(id))) return;
    const removed = await deleteWatchRule(id, ctx.userId, ctx.instanceId);
    if (!removed) return reply.status(404).send({ ok: false, error: "规则不存在", userId: ctx.userId, instanceId: ctx.instanceId });
    await audit(ctx, {
      operation: "watch_rules.remove",
      resourceType: "watch_rule",
      resourceId: String(id),
      requestBody: request.body,
      resultSummary: `removed ${id}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId };
  }));

  app.post<{ Params: { id: string } }>("/api/sandbox/watch-rules/:id/dry-run", sandboxSafe("invest.alert.read", async (ctx, request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    const result = await dryRunWatchRuleById(id, ctx.userId, ctx.instanceId);
    await audit(ctx, {
      operation: "watch_rules.dry_run",
      resourceType: "watch_rule",
      resourceId: String(id),
      resultSummary: `triggered=${result.triggered}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, result };
  }));
}
