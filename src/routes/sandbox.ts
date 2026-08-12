import type { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { agentTraces, alertEvents, alertRules, indicatorResults, investmentProfiles, methodologyProfiles } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { ACTIVE_BACKEND, planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { WorkspaceStore, type OnboardingStepKey, type OnboardingStateYaml, type StrategyYaml } from "../lib/workspace-store.js";
import { sandboxContextFromRequest, type SandboxPermission } from "../lib/sandbox-context.js";
import { assertSandboxToolAllowed, type ToolId } from "../platform/tool-registry.js";
import { buildDailyReviewContext, buildMonthlyReviewContext, buildWeeklyReviewContext, generateDailyReview, saveSkillDailyReview } from "../handlers/review.js";
import { setPlanWatchConditions, type PlanWatchConditionInput } from "../handlers/plan-conditions.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { consumeSandboxConfirmation, createSandboxConfirmation, listPendingSandboxConfirmations } from "../lib/sandbox-confirmation.js";
import { enqueuePushJob, getPushJob, processDuePushJobs, type PushBackend } from "../services/push-queue.js";
import { createWatchRule, deleteWatchRule, dryRunWatchRuleById, listWatchRuleCatalog, listWatchRules, updateWatchRule, validateWatchRule } from "../services/watch-rules.js";
import {
  applyConfirmedOnboardingStep,
  isOnboardingStep as isSharedOnboardingStep,
  normalizeOnboardingState as normalizeSharedOnboardingState,
  OnboardingContractError,
} from "../services/onboarding.js";
import { mutationResourceKeysForOperation } from "../services/mutation-resource-keys.js";
import { withResourceMutationLock } from "../services/resource-mutation-lock.js";

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

function sandboxMutationSafe(
  toolId: ToolId | ToolId[],
  operation: string,
  handler: (ctx: ReturnType<typeof sandboxContextFromRequest>, request: any, reply: any) => Promise<any>,
  extraPermissions: SandboxPermission[] = [],
) {
  return sandboxSafe(toolId, async (ctx, request, reply) => {
    const resourceKeys = mutationResourceKeysForOperation(operation, request.body);
    return withResourceMutationLock(ctx, resourceKeys, () => handler(ctx, request, reply));
  }, extraPermissions);
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

const ONBOARDING_STEPS: OnboardingStepKey[] = [
  "welcome",
  "portfolio",
  "style",
  "review_schedule",
  "market_watch_schedule",
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pickWatchPolicyOverrides(value: unknown): Record<string, unknown> {
  const input = asRecord(value);
  const { default_check_windows: _defaultCheckWindows, fixed_intraday_brief: _fixedIntradayBrief, ...rest } = input;
  return rest;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
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

function normalizeReviewScheduleTime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const standalone = normalizeTimeToken(trimmed);
  if (standalone) return standalone;
  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+\d{1,2}:\d{2}$/i.test(trimmed)) return trimmed;
  if (/^day_\d{1,2}\s+\d{1,2}:\d{2}$/i.test(trimmed)) return trimmed;
  return trimmed || undefined;
}

function readReviewScheduleDefaults(value: unknown): Record<string, unknown> {
  const body = asRecord(value);
  const input = asRecord(body.reviewSchedule ?? body.review_schedule ?? value);
  const dailyInput = asRecord(input.daily_review ?? input.dailyReview ?? body.daily_review ?? body.dailyReview);
  const weeklyInput = asRecord(input.weekly_review ?? input.weeklyReview ?? body.weekly_review ?? body.weeklyReview);
  const monthlyInput = asRecord(input.monthly_review ?? input.monthlyReview ?? body.monthly_review ?? body.monthlyReview);
  const companyInput = asRecord(
    input.company_financial_analysis ??
    input.companyFinancialAnalysis ??
    body.company_financial_analysis ??
    body.companyFinancialAnalysis
  );
  const dailyDefaultTime = normalizeReviewScheduleTime(firstDefined(
    dailyInput.default_time,
    dailyInput.defaultTime,
    input.daily_review_time,
    input.dailyReviewTime,
    body.daily_review_time,
    body.dailyReviewTime,
  ));
  const weeklyDefaultTime = normalizeReviewScheduleTime(firstDefined(
    weeklyInput.default_time,
    weeklyInput.defaultTime,
    input.weekly_review_time,
    input.weeklyReviewTime,
    body.weekly_review_time,
    body.weeklyReviewTime,
  ));
  const monthlyDefaultTime = normalizeReviewScheduleTime(firstDefined(
    monthlyInput.default_time,
    monthlyInput.defaultTime,
    input.monthly_review_time,
    input.monthlyReviewTime,
    body.monthly_review_time,
    body.monthlyReviewTime,
  ));
  return {
    daily_review: {
      ...dailyInput,
      ...(dailyDefaultTime ? { default_time: dailyDefaultTime } : {}),
    },
    weekly_review: {
      ...weeklyInput,
      ...(weeklyDefaultTime ? { default_time: weeklyDefaultTime } : {}),
    },
    monthly_review: {
      ...monthlyInput,
      ...(monthlyDefaultTime ? { default_time: monthlyDefaultTime } : {}),
    },
    company_financial_analysis: companyInput,
  };
}

function hasReviewScheduleInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return [
    input.reviewSchedule,
    input.review_schedule,
    input.daily_review,
    input.dailyReview,
    input.weekly_review,
    input.weeklyReview,
    input.monthly_review,
    input.monthlyReview,
    input.daily_review_time,
    input.dailyReviewTime,
    input.weekly_review_time,
    input.weeklyReviewTime,
    input.monthly_review_time,
    input.monthlyReviewTime,
  ].some((item) => item !== undefined);
}

function normalizeMarketWatchWindowToken(value: unknown): string | null {
  return normalizeTimeToken(value);
}

function normalizeMarketWatchWindows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const windows: string[] = [];
  for (const item of value) {
    const time = normalizeMarketWatchWindowToken(item);
    if (!time || seen.has(time)) continue;
    seen.add(time);
    windows.push(time);
  }
  return windows;
}

function firstNonEmptyMarketWatchWindows(...values: unknown[]): string[] {
  for (const value of values) {
    const windows = normalizeMarketWatchWindows(value);
    if (windows.length > 0) return windows;
  }
  return [];
}

function hasMarketWatchWindowInput(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  const nested = asRecord(input.marketWatchSchedule ?? input.market_watch_schedule ?? {});
  const marketWatch = asRecord(input.marketWatch ?? input.market_watch ?? nested.marketWatch ?? nested.market_watch);
  const fixed = asRecord(nested.fixed_intraday_brief);
  return [
    input.market_watch_windows,
    input.marketWatchWindows,
    nested.default_windows,
    nested.defaultWindows,
    marketWatch.default_windows,
    marketWatch.defaultWindows,
    fixed.times,
  ].some(Array.isArray);
}

function normalizeMarketWatchPushMode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (!normalized) return undefined;
  if (
    normalized === "every_check_brief" ||
    normalized === "scheduled_brief" ||
    normalized === "scheduled_intraday_brief" ||
    normalized === "active_watch"
  ) {
    return "scheduled_intraday_brief";
  }
  if (normalized === "exception_only" || normalized === "only_push_on_exception" || normalized === "low_disturbance") {
    return "exception_only";
  }
  return normalized;
}

function readMarketWatchScheduleDefaults(value: unknown): Record<string, unknown> {
  const body = asRecord(value);
  const input = asRecord(body.marketWatchSchedule ?? body.market_watch_schedule ?? value);
  const marketWatch = asRecord(input.market_watch ?? input.marketWatch ?? body.market_watch ?? body.marketWatch);
  const fixed = asRecord(input.fixed_intraday_brief);
  const windows = firstNonEmptyMarketWatchWindows(
    marketWatch.default_windows,
    marketWatch.defaultWindows,
    input.default_windows,
    input.defaultWindows,
    body.market_watch_windows,
    body.marketWatchWindows,
    fixed.times,
  );
  const pushMode = normalizeMarketWatchPushMode(
    marketWatch.push_mode ?? marketWatch.pushMode ?? input.push_mode ?? input.pushMode ?? body.push_mode ?? body.pushMode
  );
  const onlyPushOnException =
    typeof marketWatch.only_push_on_exception === "boolean" ? marketWatch.only_push_on_exception :
    typeof marketWatch.onlyPushOnException === "boolean" ? marketWatch.onlyPushOnException :
    typeof input.only_push_on_exception === "boolean" ? input.only_push_on_exception :
    typeof input.onlyPushOnException === "boolean" ? input.onlyPushOnException :
    typeof body.only_push_on_exception === "boolean" ? body.only_push_on_exception :
    typeof body.onlyPushOnException === "boolean" ? body.onlyPushOnException :
    pushMode === "scheduled_intraday_brief" ? false :
    pushMode === "exception_only" ? true :
    undefined;
  const customFrequency =
    marketWatch.custom_frequency ?? marketWatch.customFrequency ?? input.custom_frequency ?? input.customFrequency ?? body.custom_frequency ?? body.customFrequency;
  const {
    step: _step,
    summary: _summary,
    notes: _notes,
    complete: _complete,
    default_windows: _defaultWindows,
    defaultWindows: _defaultWindowsCamel,
    market_watch_windows: _marketWatchWindows,
    marketWatchWindows: _marketWatchWindowsCamel,
    only_push_on_exception: _onlyPushOnException,
    onlyPushOnException: _onlyPushOnExceptionCamel,
    push_mode: _pushMode,
    pushMode: _pushModeCamel,
    custom_frequency: _customFrequency,
    customFrequency: _customFrequencyCamel,
    fixed_intraday_brief: _fixedIntradayBrief,
    market_watch: _marketWatch,
    marketWatch: _marketWatchCamel,
    marketWatchSchedule: _marketWatchSchedule,
    market_watch_schedule: _marketWatchScheduleSnake,
    ...rest
  } = input;
  const result: Record<string, unknown> = {
    ...rest,
    ...(windows.length > 0 ? { default_windows: windows } : {}),
    ...(customFrequency !== undefined ? { custom_frequency: customFrequency } : {}),
    ...(onlyPushOnException !== undefined ? { only_push_on_exception: onlyPushOnException } : {}),
    ...(pushMode ? { push_mode: pushMode } : {}),
  };
  return result;
}

function arraysEqualString(a: unknown, b: string[]) {
  return Array.isArray(a) && a.length === b.length && a.every((item, index) => item === b[index]);
}

function validateOnboardingStepRequest(step: OnboardingStepKey, body: Record<string, unknown>) {
  if (step === "style") {
    const profile = asRecord(body.styleProfile ?? body.style_profile);
    if (typeof (profile.style ?? body.style) !== "string" && typeof (profile.notes ?? body.notes) !== "string") {
      return { status: 400, error: "style 确认必须携带 styleProfile 的策略摘要，不能只推进 onboarding 状态。" };
    }
    return null;
  }

  if (step === "review_schedule") {
    const defaults = readReviewScheduleDefaults(body);
    const dailyTime = asRecord(defaults.daily_review).default_time;
    const weeklyTime = asRecord(defaults.weekly_review).default_time;
    const monthlyTime = asRecord(defaults.monthly_review).default_time;
    if (hasReviewScheduleInput(body) && !dailyTime && !weeklyTime && !monthlyTime) {
      return {
        status: 400,
        error: "review_schedule 包含复盘时间字段，但没有可识别的 default_time；请使用 reviewSchedule.daily_review.default_time 等结构化字段。",
      };
    }
    return null;
  }

  if (step !== "market_watch_schedule") return null;
  const defaults = readMarketWatchScheduleDefaults(body);
  const expectedWindows = Array.isArray(defaults.default_windows)
    ? defaults.default_windows.filter((item): item is string => typeof item === "string")
    : [];
  if (hasMarketWatchWindowInput(body) && expectedWindows.length === 0) {
    return {
      status: 400,
      error: "market_watch_schedule 包含盯盘时间字段，但没有可识别的 HH:MM 时间；请使用 marketWatchSchedule.default_windows 或 market_watch_windows。",
    };
  }
  return null;
}

async function validateOnboardingStepEffects(
  store: WorkspaceStore,
  step: OnboardingStepKey,
  body: Record<string, unknown>,
) {
  if (step === "style") {
    const strategy = await store.readStrategy();
    const profile = asRecord(body.styleProfile ?? body.style_profile);
    const expectedStyle = typeof (profile.style ?? body.style) === "string" ? String(profile.style ?? body.style).trim() : "";
    if (!strategy?.last_confirmed_at || (expectedStyle && strategy.profile?.style !== expectedStyle)) {
      return { status: 500, error: "style 已确认但 strategy.yaml 未按请求落盘。" };
    }
    return null;
  }

  if (step === "review_schedule") {
    const schedules = asRecord(await store.readSchedules());
    const defaults = readReviewScheduleDefaults(body);
    const expectedDaily = asRecord(defaults.daily_review).default_time;
    const expectedWeekly = asRecord(defaults.weekly_review).default_time;
    const expectedMonthly = asRecord(defaults.monthly_review).default_time;
    const actualDaily = asRecord(schedules.daily_review).default_time;
    const actualWeekly = asRecord(schedules.weekly_review).default_time;
    const actualMonthly = asRecord(schedules.monthly_review).default_time;

    if (expectedDaily && actualDaily !== expectedDaily) {
      return { status: 500, error: "review_schedule 已确认但 daily_review.default_time 未按请求落盘。", expected: expectedDaily, actual: actualDaily ?? null };
    }
    if (expectedWeekly && actualWeekly !== expectedWeekly) {
      return { status: 500, error: "review_schedule 已确认但 weekly_review.default_time 未按请求落盘。", expected: expectedWeekly, actual: actualWeekly ?? null };
    }
    if (expectedMonthly && actualMonthly !== expectedMonthly) {
      return { status: 500, error: "review_schedule 已确认但 monthly_review.default_time 未按请求落盘。", expected: expectedMonthly, actual: actualMonthly ?? null };
    }
    if (!asRecord(schedules.daily_review).default_time || !asRecord(schedules.weekly_review).default_time || !asRecord(schedules.monthly_review).default_time) {
      return { status: 500, error: "review_schedule 已确认但日/周/月复盘时间不完整。" };
    }
    return null;
  }

  if (step === "notification") {
    const schedules = asRecord(await store.readSchedules());
    const notification = asRecord(await store.readNotification());
    const expectedMode = readNotificationPreferenceModeFromBody(body, schedules);
    const expectedMarketWatchPolicy = marketWatchPolicyForPreference(expectedMode);
    const actualMode = asRecord(notification.preference).mode;
    const actualMarketWatch = asRecord(schedules.market_watch);

    if (actualMode !== expectedMode) {
      return {
        status: 500,
        error: "notification 已确认但 notification.preference.mode 未按请求落盘。",
        expected: expectedMode,
        actual: actualMode ?? null,
      };
    }
    if (actualMarketWatch.only_push_on_exception !== expectedMarketWatchPolicy.only_push_on_exception) {
      return {
        status: 500,
        error: "notification 已确认但 schedules.market_watch.only_push_on_exception 未与通知偏好对齐。",
        expected: expectedMarketWatchPolicy.only_push_on_exception,
        actual: actualMarketWatch.only_push_on_exception ?? null,
      };
    }
    if (actualMarketWatch.push_mode !== expectedMarketWatchPolicy.push_mode) {
      return {
        status: 500,
        error: "notification 已确认但 schedules.market_watch.push_mode 未与通知偏好对齐。",
        expected: expectedMarketWatchPolicy.push_mode,
        actual: actualMarketWatch.push_mode ?? null,
      };
    }
    return null;
  }

  if (step !== "market_watch_schedule") return null;

  const schedules = asRecord(await store.readSchedules());
  const actualWindows = asRecord(schedules.market_watch).default_windows;
  const defaults = readMarketWatchScheduleDefaults(body);
  const expectedWindows = Array.isArray(defaults.default_windows)
    ? defaults.default_windows.filter((item): item is string => typeof item === "string")
    : [];

  if (expectedWindows.length > 0 && !arraysEqualString(actualWindows, expectedWindows)) {
    return {
      status: 500,
      error: "market_watch_schedule 已确认但 schedules.market_watch.default_windows 未按请求落盘。",
      expected: expectedWindows,
      actual: actualWindows ?? null,
    };
  }

  if (!Array.isArray(actualWindows) || actualWindows.length === 0) {
    return {
      status: 500,
      error: "market_watch_schedule 已确认但 schedules.market_watch.default_windows 为空。",
    };
  }

  return null;
}

type NotificationPreferenceMode = "low_disturbance" | "active_watch" | "evening_summary";

const NOTIFICATION_PREFERENCE_LABELS: Record<NotificationPreferenceMode, string> = {
  low_disturbance: "低打扰",
  active_watch: "积极盯盘",
  evening_summary: "晚间汇总",
};

const NOTIFICATION_PREFERENCE_DESCRIPTIONS: Record<NotificationPreferenceMode, string> = {
  low_disturbance: "盘中只提醒可能需要当天处理的事，其他放到晚间复盘。",
  active_watch: "到用户设置的盯盘时间就推送盘中简报；重大风险仍会单独提醒。",
  evening_summary: "盘中尽量不打扰，晚上统一复盘。",
};

function normalizeNotificationPreferenceMode(value: unknown): NotificationPreferenceMode {
  if (typeof value !== "string") return "low_disturbance";
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "active_watch" || normalized === "active" || normalized === "积极盯盘") return "active_watch";
  if (normalized === "evening_summary" || normalized === "evening" || normalized === "晚间汇总") return "evening_summary";
  return "low_disturbance";
}

function readNotificationPreferenceMode(value: unknown): NotificationPreferenceMode {
  const input = asRecord(value);
  return normalizeNotificationPreferenceMode(input.mode ?? value);
}

function readNotificationPreferenceModeFromBody(body: Record<string, unknown>, schedules?: Record<string, unknown>): NotificationPreferenceMode {
  const explicit = firstDefined(
    body.notificationPreference,
    body.notification_preference,
    body.notification,
    body.preference,
    body.notification_mode,
    body.notificationMode,
    body.mode,
  );
  if (explicit !== undefined) return readNotificationPreferenceMode(explicit);
  return inferNotificationPreferenceModeFromMarketWatch(schedules?.market_watch);
}

function inferNotificationPreferenceModeFromMarketWatch(marketWatch: unknown): NotificationPreferenceMode {
  const input = asRecord(marketWatch);
  const pushMode = normalizeMarketWatchPushMode(input.push_mode ?? input.pushMode);
  if (input.only_push_on_exception === false || pushMode === "scheduled_intraday_brief") return "active_watch";
  if (pushMode === "exception_only") return "low_disturbance";
  return "low_disturbance";
}

function buildNotificationPreference(mode: NotificationPreferenceMode) {
  return {
    mode,
    label: NOTIFICATION_PREFERENCE_LABELS[mode],
    description: NOTIFICATION_PREFERENCE_DESCRIPTIONS[mode],
  };
}

function normalizeOnboardingAssetName(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function normalizeOnboardingAssetCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim() : "";
  return code ? code.slice(0, 32) : null;
}

function normalizeOnboardingAssetList(value: unknown): Array<{ name: string; code: string | null; notes?: string }> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: Array<{ name: string; code: string | null; notes?: string }> = [];
  for (const raw of value) {
    const item = typeof raw === "string" ? { name: raw } : asRecord(raw);
    const name = normalizeOnboardingAssetName(
      item.name ?? item.stockName ?? item.stock_name ?? item.label ?? item.title
    );
    const code = normalizeOnboardingAssetCode(
      item.code ?? item.stockCode ?? item.stock_code ?? item.symbol
    );
    if (!name && !code) continue;
    const key = `${code || ""}::${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const notes = typeof item.notes === "string" ? item.notes.trim().slice(0, 240) : undefined;
    result.push({ name: name || code || "未命名标的", code, notes });
  }
  return result;
}

function findOnboardingAssetsMissingCode(kind: "holding" | "watchlist", items: Array<{ name: string; code: string | null }>) {
  return items
    .filter((item) => !item.code || !/^\d{6}$/.test(item.code))
    .map((item) => ({
      kind,
      name: item.name,
      code: item.code,
      reason: item.code ? "证券代码必须是 6 位数字" : "缺少证券代码",
    }));
}

function marketWatchPolicyForPreference(mode: NotificationPreferenceMode) {
  if (mode === "active_watch") {
    return {
      only_push_on_exception: false,
      push_mode: "scheduled_intraday_brief",
    };
  }
  return {
    only_push_on_exception: true,
    push_mode: mode === "evening_summary" ? "exception_only" : "exception_only",
  };
}

async function applyOnboardingStepDefaults(
  store: WorkspaceStore,
  step: OnboardingStepKey,
  now: string,
  body: Record<string, unknown>
) {
  if (step === "style") {
    const profile = asRecord(body.styleProfile ?? body.style_profile);
    const style = typeof (profile.style ?? body.style) === "string" ? String(profile.style ?? body.style).trim() : "";
    const notes = typeof (profile.notes ?? body.notes) === "string" ? String(profile.notes ?? body.notes).trim() : "";
    const selectedStylePack = profile.selectedStylePack ?? profile.selected_style_pack;
    const buyRules = profile.buyRules ?? profile.buy_rules;
    const sellRules = profile.sellRules ?? profile.sell_rules;
    const riskRules = profile.riskRules ?? profile.risk_rules;
    const existing = await store.readStrategy() ?? {};
    await store.writeStrategy({
      ...existing,
      profile: {
        ...(existing.profile ?? {}),
        style: style || existing.profile?.style || "自定义策略",
        selected_style_pack: selectedStylePack === null ? null : typeof selectedStylePack === "string" ? selectedStylePack : existing.profile?.selected_style_pack ?? null,
        custom_style_enabled: typeof (profile.customStyleEnabled ?? profile.custom_style_enabled) === "boolean"
          ? Boolean(profile.customStyleEnabled ?? profile.custom_style_enabled)
          : existing.profile?.custom_style_enabled ?? true,
        risk_preference: typeof (profile.riskPreference ?? profile.risk_preference) === "string"
          ? String(profile.riskPreference ?? profile.risk_preference)
          : existing.profile?.risk_preference ?? "",
        investment_horizon: typeof (profile.investmentHorizon ?? profile.investment_horizon) === "string"
          ? String(profile.investmentHorizon ?? profile.investment_horizon)
          : existing.profile?.investment_horizon ?? "",
      },
      buy_rules: Array.isArray(buyRules) ? buyRules : existing.buy_rules ?? [],
      sell_rules: Array.isArray(sellRules) ? sellRules : existing.sell_rules ?? [],
      risk_rules: Array.isArray(riskRules) ? riskRules : existing.risk_rules ?? [],
      notes: notes || existing.notes || "",
      last_confirmed_at: now,
    });
  }

  if (step === "review_schedule") {
    const schedules = await store.readSchedules() ?? {};
    const reviewDefaults = readReviewScheduleDefaults(body);
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

  if (step === "market_watch_schedule") {
    const schedules = await store.readSchedules() ?? {};
    const marketWatchDefaults = readMarketWatchScheduleDefaults(body);
    await store.writeSchedules({
      ...schedules,
      timezone: schedules.timezone ?? "Asia/Shanghai",
      market_watch: {
        enabled: true,
        auto_run: true,
        default_windows: ["09:55", "11:20", "14:30"],
        custom_frequency: null,
        only_push_on_exception: true,
        ...(schedules.market_watch && typeof schedules.market_watch === "object" ? schedules.market_watch as Record<string, unknown> : {}),
        ...marketWatchDefaults,
      },
    });
  }

  if (step === "notification") {
    const notification = await store.readNotification() ?? {};
    const schedules = await store.readSchedules() ?? {};
    const mode = readNotificationPreferenceModeFromBody(body, schedules);
    const marketWatchPolicy = marketWatchPolicyForPreference(mode);
    await store.writeNotification({
      ...notification,
      preference: buildNotificationPreference(mode),
      user_mode: notification.user_mode ?? "working_professional",
      working_hours: {
        start: "09:00",
        end: "18:00",
        ...(notification.working_hours && typeof notification.working_hours === "object" ? notification.working_hours as Record<string, unknown> : {}),
        policy: mode === "active_watch"
          ? "按用户设置的盯盘时间推送盘中简报。"
          : mode === "evening_summary"
            ? "盘中不主动推送，晚上统一查看复盘和关注事项。"
            : "盘中不主动推送普通信息，减少不必要打扰。",
      },
      do_not_disturb: {
        ...(notification.do_not_disturb && typeof notification.do_not_disturb === "object" ? notification.do_not_disturb as Record<string, unknown> : {}),
        enabled: mode !== "active_watch",
        allow_p0_override: false,
      },
      last_confirmed_at: now,
    });
    await store.writeSchedules({
      ...schedules,
      timezone: schedules.timezone ?? "Asia/Shanghai",
      market_watch: {
        enabled: true,
        auto_run: true,
        default_windows: ["09:55", "11:20", "14:30"],
        custom_frequency: null,
        ...(schedules.market_watch && typeof schedules.market_watch === "object" ? schedules.market_watch as Record<string, unknown> : {}),
        ...marketWatchPolicy,
      },
    });
  }

  if (step === "watch_rules") {
    const watch = await store.readWatch() ?? {};
    const watchDefaults = pickWatchPolicyOverrides(body.watchPolicy);
    const notification = await store.readNotification() ?? {};
    const mode = readNotificationPreferenceMode(asRecord(notification.preference).mode);
    const marketWatchPolicy = marketWatchPolicyForPreference(mode);
    await store.writeWatch({
      ...watch,
      mode: typeof watch.mode === "string" ? watch.mode : "default",
      only_push_on_exception: marketWatchPolicy.only_push_on_exception,
      priority_policy: mode === "active_watch"
        ? "用户偏好为积极盯盘：固定盯盘时间推送盘中简报，重大风险单独提醒；事件优先级仍由系统内部判断。"
        : "用户偏好为低打扰/晚间汇总：盘中只打断可能需要当天处理的事项，其他进入晚间复盘或记录；事件优先级由系统内部判断。",
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
        `已确认通知偏好：${NOTIFICATION_PREFERENCE_LABELS[mode]}。`,
        NOTIFICATION_PREFERENCE_DESCRIPTIONS[mode],
        "尚未批量创建具体阶段二明确规则；如需创建均线、价格或技术指标提醒，应单独向用户确认后再调用 watch-rule API。",
      ],
      ...watchDefaults,
    });
  }
}

export function registerSandboxRoutes(app: FastifyInstance) {
  app.get("/api/sandbox/me", sandboxSafe("invest.snapshot.read", async (ctx) => ({
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

  app.get("/api/sandbox/snapshot", sandboxSafe("invest.snapshot.read", async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const [portfolioRows, watchlistRows, planRows, upgradedAlertRules, recentIndicatorResults, recentEvents, recentPlans, recentConversations, methodChangeRows, investmentProfile, methodologyProfile] =
      await Promise.all([
        portfolioBackend.listActive(ctx.userId, ctx.instanceId),
        watchlistBackend.list(ctx.userId, ctx.instanceId),
        planBackend.list(ctx.userId, ctx.instanceId),
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
        db.select().from(agentTraces).where(and(eq(agentTraces.userId, ctx.userId), eq(agentTraces.instanceId, ctx.instanceId))).orderBy(desc(agentTraces.createdAt)).limit(20),
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
      alertRules: [],
      upgradedAlertRules,
      recentIndicatorResults,
      recentEvents,
      recentPlans,
    };
  }));

  app.get("/api/sandbox/confirmations/pending", sandboxSafe("invest.snapshot.read", async (ctx) => {
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
    const state = normalizeSharedOnboardingState(await store.readOnboardingState());
    await audit(ctx, {
      operation: "onboarding.state.read",
      resourceType: "onboarding_state",
      resultSummary: `status=${state.status}; current=${state.current_step ?? "-"}`,
    });
    return { ok: true, userId: ctx.userId, instanceId: ctx.instanceId, state };
  }));

  app.post<{
    Body: {
      holdings?: Array<{ name?: string; code?: string; notes?: string }>;
      watchlist?: Array<{ name?: string; code?: string; notes?: string }>;
      summary?: string;
      notes?: string;
    };
  }>("/api/sandbox/onboarding/confirm-portfolio", sandboxMutationSafe(["invest.onboarding.write", "invest.portfolio.write"], "onboarding.confirm_portfolio", async (ctx, request, reply) => {
    const holdingInputs = normalizeOnboardingAssetList(request.body?.holdings);
    const watchInputs = normalizeOnboardingAssetList(request.body?.watchlist);
    if (!holdingInputs.length && !watchInputs.length) {
      return reply.status(400).send({ ok: false, error: "至少需要一个持仓或观察仓标的" });
    }
    const missingCodes = [
      ...findOnboardingAssetsMissingCode("holding", holdingInputs),
      ...findOnboardingAssetsMissingCode("watchlist", watchInputs),
    ];
    if (missingCodes.length > 0) {
      return reply.status(400).send({
        ok: false,
        error: "持仓和观察仓写入前必须补齐 6 位证券代码；请先通过外部数据 MCP 或让用户确认歧义标的后再重试",
        missingCodes,
      });
    }

    const now = new Date().toISOString();
    const store = new WorkspaceStore(ctx.userId);
    const portfolio = (await store.readPortfolio()) ?? { holdings: [], watchlist: [], accounts: [] };
    const holdings = Array.isArray(portfolio.holdings) ? [...portfolio.holdings] : [];
    const watchItems = Array.isArray(portfolio.watchlist) ? [...portfolio.watchlist] : [];

    for (const item of holdingInputs) {
      const idx = holdings.findIndex((existing: any) =>
        (item.code && existing.code === item.code) || (!item.code && existing.name === item.name)
      );
      const next = {
        ...(idx >= 0 ? holdings[idx] : {}),
        name: item.name,
        code: item.code,
        asset_type: (idx >= 0 ? (holdings[idx] as any).asset_type : null) ?? null,
        market: (idx >= 0 ? (holdings[idx] as any).market : null) ?? null,
        account: (idx >= 0 ? (holdings[idx] as any).account : null) ?? null,
        currency: (idx >= 0 ? (holdings[idx] as any).currency : "CNY") ?? "CNY",
        cost: (idx >= 0 ? (holdings[idx] as any).cost : null) ?? null,
        shares: (idx >= 0 ? (holdings[idx] as any).shares : null) ?? null,
        market_value: (idx >= 0 ? (holdings[idx] as any).market_value : null) ?? null,
        weight: (idx >= 0 ? (holdings[idx] as any).weight : null) ?? null,
        notes: item.notes || (idx >= 0 ? (holdings[idx] as any).notes : "") || "User confirmed holding name only; details can be completed later.",
      };
      if (idx >= 0) holdings[idx] = next as any;
      else holdings.push(next as any);
    }

    for (const item of watchInputs) {
      const idx = watchItems.findIndex((existing: any) =>
        (item.code && existing.code === item.code) || (!item.code && existing.name === item.name)
      );
      const next = {
        ...(idx >= 0 ? watchItems[idx] : {}),
        name: item.name,
        code: item.code,
        asset_type: (idx >= 0 ? (watchItems[idx] as any).asset_type : null) ?? null,
        market: (idx >= 0 ? (watchItems[idx] as any).market : null) ?? null,
        trigger: (idx >= 0 ? (watchItems[idx] as any).trigger : "") ?? "",
        evidence_needed: Array.isArray(idx >= 0 ? (watchItems[idx] as any).evidence_needed : null)
          ? (watchItems[idx] as any).evidence_needed
          : [],
        notes: item.notes || (idx >= 0 ? (watchItems[idx] as any).notes : "") || "User confirmed watch name only; trigger can be completed later.",
      };
      if (idx >= 0) watchItems[idx] = next as any;
      else watchItems.push(next as any);
    }

    await store.writePortfolio({
      ...portfolio,
      holdings: holdings as any,
      watchlist: watchItems as any,
      accounts: Array.isArray(portfolio.accounts) ? portfolio.accounts : [],
      last_confirmed_at: now,
      last_confirmed_by: "user",
    });

    const current = normalizeSharedOnboardingState(await store.readOnboardingState());
    const steps = { ...(current.steps ?? {}) };
    steps.welcome = { done: true, completed_at: steps.welcome?.completed_at ?? now };
    steps.portfolio = { done: true, completed_at: steps.portfolio?.completed_at ?? now };
    const nextState: OnboardingStateYaml = {
      ...current,
      status: "in_progress",
      current_step: "style",
      steps,
      updated_at: now,
      notes: request.body?.notes ?? current.notes ?? "",
    };
    await store.writeOnboardingState(nextState);
    await store.appendChangeLog({
      ts: now,
      source: "sandbox",
      type: "onboarding_portfolio_confirmed",
      summary: request.body?.summary || "用户确认 onboarding 持仓和观察仓",
      details: {
        holding_names: holdingInputs.map((item) => item.name),
        watch_names: watchInputs.map((item) => item.name),
        current_step: nextState.current_step,
      },
    });
    await audit(ctx, {
      operation: "onboarding.confirm_portfolio",
      resourceType: "onboarding_state",
      resourceId: "portfolio",
      requestBody: request.body,
      resultSummary: `confirmed portfolio holdings=${holdingInputs.length}; watchlist=${watchInputs.length}; current=style`,
    });
    return {
      ok: true,
      userId: ctx.userId,
      instanceId: ctx.instanceId,
      state: nextState,
      holdings,
      watchlist: watchItems,
      message: "已确认持仓和观察仓，下一步进入风格包选择",
    };
  }));

  app.post<{
    Body: {
      step?: string;
      summary?: string;
      notes?: string;
      reviewSchedule?: Record<string, unknown>;
      review_schedule?: Record<string, unknown>;
      daily_review_time?: string;
      dailyReviewTime?: string;
      weekly_review_time?: string;
      weeklyReviewTime?: string;
      monthly_review_time?: string;
      monthlyReviewTime?: string;
      marketWatchSchedule?: Record<string, unknown>;
      market_watch_schedule?: Record<string, unknown>;
      marketWatchWindows?: string[];
      market_watch_windows?: string[];
      pushMode?: string;
      push_mode?: string;
      notificationPreference?: Record<string, unknown> | string;
      notification_preference?: Record<string, unknown> | string;
      notification?: Record<string, unknown> | string;
      preference?: Record<string, unknown> | string;
      notification_mode?: string;
      notificationMode?: string;
      mode?: string;
      watchPolicy?: Record<string, unknown>;
      complete?: boolean;
    };
  }>("/api/sandbox/onboarding/confirm-step", sandboxMutationSafe("invest.onboarding.write", "onboarding.confirm_step", async (ctx, request, reply) => {
    const step = request.body?.step;
    if (!isSharedOnboardingStep(step)) {
      return reply.status(400).send({ ok: false, error: `非法 onboarding step: ${String(step ?? "")}` });
    }

    const now = new Date().toISOString();
    const store = new WorkspaceStore(ctx.userId);
    let nextState: OnboardingStateYaml;
    try {
      nextState = await applyConfirmedOnboardingStep({ store, step, body: request.body ?? {}, now });
    } catch (error) {
      const contractError = error instanceof OnboardingContractError ? error : null;
      const message = error instanceof Error ? error.message : String(error);
      await audit(ctx, {
        operation: "onboarding.confirm_step",
        resourceType: "onboarding_state",
        resourceId: step,
        requestBody: request.body,
        resultSummary: message,
        status: "error",
      });
      return reply.status(contractError?.status ?? 500).send({ ok: false, error: message });
    }
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
      message: nextState.status === "completed" ? "新手引导已完成" : `已确认 ${step}`,
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
  }>("/api/sandbox/profiles/investment", sandboxMutationSafe("invest.profile.write", "profiles.investment.set", async (ctx, request, reply) => {
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
  }>("/api/sandbox/profiles/methodology", sandboxMutationSafe("invest.profile.write", "profiles.methodology.set", async (ctx, request, reply) => {
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
  }>("/api/sandbox/method-changes/propose", sandboxMutationSafe("invest.profile.write", "method_changes.propose", async (ctx, request, reply) => {
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

  app.post<{ Body: { id?: string | number; status?: "confirmed" | "rejected"; decisionNote?: string; confirmationId?: string } }>("/api/sandbox/method-changes/decide", sandboxMutationSafe("invest.profile.write", "method_changes.decide", async (ctx, request, reply) => {
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

  app.post<{ Body: { name?: string; code?: string; reason?: string; userId?: string } }>("/api/sandbox/watchlist/add", sandboxMutationSafe("invest.watchlist.write", "watchlist.add", async (ctx, request, reply) => {
    const { name, code, reason } = request.body ?? {};
    if (!code) return reply.status(400).send({ ok: false, error: "缺少 6 位股票代码；请先通过外部数据 MCP 或用户确认完成代码解析" });
    if (!/^\d{6}$/.test(code)) return reply.status(400).send({ ok: false, error: "stockCode 必须是 6 位数字代码（如 600519），不带 sh/sz 前缀" });

    const stockCode = code;
    const existing = await watchlistBackend.find(ctx.userId, ctx.instanceId, stockCode);
    if (existing) return { ok: false, error: `${existing.name}(${stockCode}) 已在自选池中`, userId: ctx.userId };

    const stockName = name || stockCode;
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

  app.post<{ Body: { code: string; userId?: string; confirmationId?: string } }>("/api/sandbox/watchlist/remove", sandboxMutationSafe("invest.watchlist.write", "watchlist.remove", async (ctx, request, reply) => {
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

  app.post<{ Body: { stockCode: string; stockName?: string; support?: number; resistance?: number; targetPrice?: number; stopLoss?: number; notes?: string; watchConditions?: PlanWatchConditionInput[]; linkedAlertRuleIds?: number[]; planType?: string; strategyKey?: string | null; userId?: string } }>("/api/sandbox/plans/set", sandboxMutationSafe("invest.plan.write", "plans.set", async (ctx, request, reply) => {
    const { stockCode, stockName, support, resistance, targetPrice, stopLoss, notes, watchConditions, linkedAlertRuleIds, planType, strategyKey } = request.body ?? {};
    if (!stockCode) return reply.status(400).send({ ok: false, error: "缺少股票代码" });
    if (!/^\d{6}$/.test(stockCode)) return reply.status(400).send({ ok: false, error: "stockCode 必须是 6 位数字代码（如 600519），不带 sh/sz 前缀" });
    const name = stockName || stockCode;
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

  app.post<{ Body: { stockCode: string; stockName?: string; conditions: PlanWatchConditionInput[]; userId?: string } }>("/api/sandbox/plans/watch-conditions", sandboxMutationSafe("invest.plan.write", "plans.watch_conditions", async (ctx, request, reply) => {
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

  app.post<{ Body: { stockCode: string; userId?: string; confirmationId?: string } }>("/api/sandbox/plans/remove", sandboxMutationSafe("invest.plan.write", "plans.remove", async (ctx, request, reply) => {
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

  app.post<{ Body: { key?: string; name?: string; applicability?: string; body?: string; enabled?: boolean; userId?: string } }>("/api/sandbox/strategies/set", sandboxMutationSafe("invest.strategy.write", "strategies.set", async (ctx, request, reply) => {
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

  app.post<{ Body: { key?: string; userId?: string; confirmationId?: string } }>("/api/sandbox/strategies/remove", sandboxMutationSafe("invest.strategy.write", "strategies.remove", async (ctx, request, reply) => {
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

  app.post<{ Body: { date?: string; content?: string; summary?: string; context?: unknown; userId?: string } }>("/api/sandbox/reviews/save", sandboxMutationSafe("invest.review.write", "reviews.save", async (ctx, request, reply) => {
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

  app.post<{ Body: { date?: string; force?: boolean; userId?: string } }>("/api/sandbox/reviews/daily", sandboxMutationSafe("invest.review.write", "reviews.daily", async (ctx, request) => {
    const { date, force } = request.body ?? {};
    const content = await generateDailyReview({ force: force ?? true, targetDate: date, userId: ctx.userId, instanceId: ctx.instanceId });
    return { ok: true, userId: ctx.userId, date: date ?? new Date().toISOString().slice(0, 10), content, summary: content.slice(0, 1200) };
  }));

  app.post<{ Body: { force?: boolean } }>("/api/sandbox/alerts/check", sandboxSafe("invest.alert.check", async (ctx, request) => {
    const { runAlertCheck, formatAlerts } = await import("../scheduler/alert-check.js");
    const items = await runAlertCheck({ force: request.body?.force === true, userId: ctx.userId, instanceId: ctx.instanceId });
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
      const backend = "mastra" satisfies PushBackend;
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
        return weixinMobileManager.pushText(dueJob.message, { userId: dueJob.userId });
      }, { limit: 5 });
      const updated = await getPushJob(job.id);
      pushed = updated?.status === "sent";
    }
    await audit(ctx, {
      operation: "alerts.check_and_push",
      resourceType: "alert_check",
      requestBody: request.body,
      resultSummary: `backend=${ctx.backend ?? "mastra"}; count=${items.length}; pushed=${pushed}; pushJobId=${pushJobId ?? "-"}`,
    });
    return { ok: true, userId: ctx.userId, count: items.length, pushed, pushJobId, alerts: items, text };
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

  app.post<{ Body: Record<string, unknown> }>("/api/sandbox/watch-rules", sandboxMutationSafe("invest.alert.write", "watch_rules.create", async (ctx, request, reply) => {
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

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/sandbox/watch-rules/:id", sandboxMutationSafe("invest.alert.write", "watch_rules.update", async (ctx, request, reply) => {
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

  app.delete<{ Params: { id: string }; Body: { confirmationId?: string } }>("/api/sandbox/watch-rules/:id", sandboxMutationSafe("invest.alert.write", "watch_rules.delete", async (ctx, request, reply) => {
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
