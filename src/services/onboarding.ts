import { sqlite } from "../db/index.js";
import { DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { WorkspaceStore, type NotificationYaml, type OnboardingStateYaml, type OnboardingStepKey, type PortfolioYaml, type SchedulesYaml, type StrategyYaml } from "../lib/workspace-store.js";

const ONBOARDING_STEPS: OnboardingStepKey[] = [
  "welcome",
  "portfolio",
  "style",
  "review_schedule",
  "market_watch_schedule",
  "notification",
  "watch_rules",
];

const REQUIRED_BEFORE: Record<OnboardingStepKey, OnboardingStepKey[]> = {
  welcome: [],
  portfolio: ["welcome"],
  style: ["welcome", "portfolio"],
  review_schedule: ["welcome", "portfolio", "style"],
  market_watch_schedule: ["welcome", "portfolio", "style", "review_schedule"],
  notification: ["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule"],
  watch_rules: ["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule", "notification"],
};

type NotificationMode = "low_disturbance" | "active_watch" | "evening_summary";

const NOTIFICATION_LABELS: Record<NotificationMode, string> = {
  low_disturbance: "低打扰",
  active_watch: "积极盯盘",
  evening_summary: "晚间汇总",
};

const NOTIFICATION_DESCRIPTIONS: Record<NotificationMode, string> = {
  low_disturbance: "盘中不主动推送普通信息，减少不必要打扰。",
  active_watch: "在每个盘中简报时间推送持仓与市场摘要。",
  evening_summary: "盘中不主动推送，晚上统一查看复盘和关注事项。",
};

export class OnboardingContractError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "OnboardingContractError";
  }
}

export function isOnboardingStep(value: unknown): value is OnboardingStepKey {
  return typeof value === "string" && ONBOARDING_STEPS.includes(value as OnboardingStepKey);
}

export function normalizeOnboardingState(state: OnboardingStateYaml | null | undefined): OnboardingStateYaml {
  const steps = { ...(state?.steps ?? {}) };
  for (const key of ONBOARDING_STEPS) {
    steps[key] = {
      done: steps[key]?.done === true,
      completed_at: steps[key]?.completed_at ?? null,
    };
  }
  return {
    version: state?.version ?? 1,
    status: state?.status ?? "not_started",
    current_step: state?.current_step ?? "welcome",
    steps,
    completed_at: state?.completed_at ?? null,
    updated_at: state?.updated_at ?? null,
    notes: state?.notes ?? "",
  };
}

export async function applyConfirmedOnboardingStep(input: {
  store: WorkspaceStore;
  step: OnboardingStepKey;
  body?: Record<string, unknown>;
  now?: string;
}): Promise<OnboardingStateYaml> {
  const body = input.body ?? {};
  const now = input.now ?? new Date().toISOString();
  const current = normalizeOnboardingState(await input.store.readOnboardingState());
  assertStepOrder(current, input.step);
  validateOnboardingStepPayload(input.step, body);
  await applyStepConfiguration(input.store, input.step, body, now);
  await verifyStepConfiguration(input.store, input.step, body);

  const steps = { ...(current.steps ?? {}) };
  steps[input.step] = { done: true, completed_at: steps[input.step]?.completed_at ?? now };
  const allDone = ONBOARDING_STEPS.every((step) => steps[step]?.done === true);
  const nextStep = allDone ? "completed" : ONBOARDING_STEPS.find((step) => steps[step]?.done !== true) ?? "completed";
  const nextState: OnboardingStateYaml = {
    ...current,
    status: allDone ? "completed" : "in_progress",
    current_step: nextStep,
    steps,
    completed_at: allDone ? (current.completed_at ?? now) : null,
    updated_at: now,
    notes: stringValue(body.notes) ?? current.notes ?? "",
  };
  await input.store.writeOnboardingState(nextState);
  return nextState;
}

/**
 * Apply an already-confirmed onboarding draft in one pass. The caller owns
 * draft/confirmation state; this function only produces the durable workspace
 * projection and deliberately writes each target file once.
 */
export async function applyOnboardingDraftCommit(input: {
  store: WorkspaceStore;
  steps: Partial<Record<OnboardingStepKey, Record<string, unknown>>>;
  now?: string;
}): Promise<OnboardingStateYaml> {
  const now = input.now ?? new Date().toISOString();
  const portfolioInput = input.steps.portfolio ?? {};
  validateOnboardingPortfolioPayload(portfolioInput);
  for (const step of ["style", "review_schedule", "market_watch_schedule", "notification"] as const) {
    validateOnboardingStepPayload(step, input.steps[step] ?? {});
  }

  const [existingPortfolio, existingStrategy, existingSchedules, existingNotification, existingWatch, existingState] = await Promise.all([
    input.store.readPortfolio(),
    input.store.readStrategy(),
    input.store.readSchedules(),
    input.store.readNotification(),
    input.store.readWatch(),
    input.store.readOnboardingState(),
  ]);

  const portfolio = mergePortfolioDraft(existingPortfolio ?? {}, portfolioInput, now);
  const style = normalizeStyleProfile(input.steps.style ?? {});
  const strategy = {
    ...(existingStrategy ?? {}),
    profile: {
      ...(existingStrategy?.profile ?? {}),
      style: style.style ?? existingStrategy?.profile?.style ?? "自定义策略",
      selected_style_pack: style.selectedStylePack === null ? null : style.selectedStylePack ?? existingStrategy?.profile?.selected_style_pack ?? null,
      custom_style_enabled: typeof style.customStyleEnabled === "boolean" ? style.customStyleEnabled : existingStrategy?.profile?.custom_style_enabled ?? true,
      risk_preference: style.riskPreference ?? existingStrategy?.profile?.risk_preference ?? "",
      investment_horizon: style.investmentHorizon ?? existingStrategy?.profile?.investment_horizon ?? "",
    },
    buy_rules: style.buyRules ?? existingStrategy?.buy_rules ?? [],
    sell_rules: style.sellRules ?? existingStrategy?.sell_rules ?? [],
    risk_rules: style.riskRules ?? existingStrategy?.risk_rules ?? [],
    notes: style.notes ?? existingStrategy?.notes ?? "",
    last_confirmed_at: now,
  };

  const review = readReviewSchedule(input.steps.review_schedule ?? {});
  const marketWatch = readMarketWatchSchedule(input.steps.market_watch_schedule ?? {});
  const notificationMode = readNotificationMode(input.steps.notification ?? {}, existingSchedules ?? {});
  const notificationPolicy = marketWatchPolicy(notificationMode);
  const schedules = {
    ...(existingSchedules ?? {}),
    timezone: (existingSchedules ?? {}).timezone ?? "Asia/Shanghai",
    run_policy: {
      automatic_by_default: true,
      manual_trigger_allowed: true,
      skip_automatic_if_manual_report_exists: true,
      refresh_requires_user_confirmation: true,
      ...record((existingSchedules ?? {}).run_policy),
    },
    daily_review: { enabled: true, auto_run: true, default_time: "19:00", trading_days_only: true, ...record(review.daily_review) },
    weekly_review: { enabled: true, auto_run: true, default_time: "Saturday 09:00", ...record(review.weekly_review) },
    monthly_review: { enabled: true, auto_run: true, default_time: "day_1 09:00", review_previous_month: true, ...record(review.monthly_review) },
    company_financial_analysis: { enabled: true, trigger: "user_request_or_new_report_detected", ...record(review.company_financial_analysis) },
    market_watch: {
      enabled: true,
      auto_run: true,
      default_windows: ["09:55", "11:20", "14:30"],
      ...record((existingSchedules ?? {}).market_watch),
      ...marketWatch,
      ...notificationPolicy,
    },
  };
  const notification = {
    ...(existingNotification ?? {}),
    preference: { mode: notificationMode, label: NOTIFICATION_LABELS[notificationMode], description: NOTIFICATION_DESCRIPTIONS[notificationMode] },
    user_mode: (existingNotification ?? {}).user_mode ?? "working_professional",
    working_hours: {
      start: "09:00",
      end: "18:00",
      ...record((existingNotification ?? {}).working_hours),
      policy: notificationMode === "active_watch"
        ? "按用户设置的盘中简报时间推送摘要。"
        : notificationMode === "evening_summary"
          ? "盘中不主动推送，晚上统一查看复盘和关注事项。"
          : "盘中不主动推送普通信息，减少不必要打扰。",
    },
    do_not_disturb: { ...record((existingNotification ?? {}).do_not_disturb), enabled: notificationMode !== "active_watch", allow_p0_override: false },
    last_confirmed_at: now,
  };
  const watchOverrides = record((input.steps.watch_rules ?? {}).watchPolicy);
  const { default_check_windows: _windows, fixed_intraday_brief: _brief, ...safeWatchOverrides } = watchOverrides;
  const watch = {
    ...(existingWatch ?? {}),
    mode: typeof (existingWatch ?? {}).mode === "string" ? (existingWatch ?? {}).mode : "default",
    only_push_on_exception: notificationPolicy.only_push_on_exception,
    priority_policy: notificationMode === "active_watch"
      ? "用户偏好为积极盯盘：固定盘中简报时间推送摘要。"
      : "用户偏好为低打扰或晚间汇总：盘中不主动推送，由相应的摘要或复盘承接。",
    exception_rules: Array.isArray((existingWatch ?? {}).exception_rules) ? (existingWatch ?? {}).exception_rules : [],
    custom_rules: Array.isArray((existingWatch ?? {}).custom_rules) ? (existingWatch ?? {}).custom_rules : [],
    last_confirmed_at: now,
    confirmed_watch_rule_summary: [
      `已确认通知偏好：${NOTIFICATION_LABELS[notificationMode]}。`,
      NOTIFICATION_DESCRIPTIONS[notificationMode],
      "尚未创建具体明确规则；如需创建价格或指标提醒，必须另行确认。",
    ],
    ...safeWatchOverrides,
  };

  const completed = normalizeOnboardingState(existingState);
  const completedSteps = { ...(completed.steps ?? {}) };
  for (const step of ONBOARDING_STEPS) completedSteps[step] = { done: true, completed_at: completedSteps[step]?.completed_at ?? now };
  const state: OnboardingStateYaml = {
    ...completed,
    status: "completed",
    current_step: "completed",
    steps: completedSteps,
    completed_at: now,
    updated_at: now,
    notes: stringValue(portfolioInput.notes) ?? completed.notes ?? "",
  };

  await input.store.writePortfolio(portfolio);
  await input.store.writeStrategy(strategy);
  await input.store.writeSchedules(schedules);
  await input.store.writeNotification(notification);
  await input.store.writeWatch(watch);
  await verifyDraftCommit(input.store, style.style, notificationMode);
  // Rules are service-owned and are created after these files. The caller must
  // finalize the visible onboarding state only after rule creation also succeeds.
  return state;
}

/**
 * Reuses the draft's canonical merge/validation contract, then persists all
 * service-owned configuration projections in one SQLite transaction. It never
 * creates a Workspace or enables scheduler/push execution.
 */
export async function prepareMastraOnboardingDraftCommit(input: {
  userId: string;
  instanceId: string;
  projectId?: string;
  steps: Partial<Record<OnboardingStepKey, Record<string, unknown>>>;
  now?: string;
}): Promise<{ state: OnboardingStateYaml; persist(): void }> {
  const projectId = input.projectId || process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
  const portfolioRow = sqlite.prepare("SELECT portfolio_json AS value FROM mastra_portfolio_states WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string } | undefined;
  const profileRow = sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string } | undefined;
  const preferenceRow = sqlite.prepare("SELECT preferences_json AS value, source_checksums_json AS checksums FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string; checksums?: string } | undefined;
  if (!portfolioRow || !profileRow || !preferenceRow) throw new OnboardingContractError("MASTRA_PROJECTION_NOT_FOUND: onboarding requires imported portfolio, strategy and preferences projections", 409);
  const parse = (raw: string | undefined, label: string) => {
    try { const value = JSON.parse(raw || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object"); return value as Record<string, any>; }
    catch (error) { throw new OnboardingContractError(`MASTRA_PROJECTION_INVALID: ${label}: ${(error as Error).message}`, 500); }
  };
  let portfolio = parse(portfolioRow.value, "portfolio") as PortfolioYaml;
  let strategy = parse(profileRow.value, "strategy") as StrategyYaml;
  const preferences = parse(preferenceRow.value, "runtime preferences");
  let schedules = (preferences.schedules && typeof preferences.schedules === "object" ? preferences.schedules : {}) as SchedulesYaml;
  let notification = (preferences.notification && typeof preferences.notification === "object" ? preferences.notification : {}) as NotificationYaml;
  let watch = (preferences.watch && typeof preferences.watch === "object" ? preferences.watch : {}) as Record<string, unknown>;
  let state = normalizeOnboardingState(preferences.onboardingState as OnboardingStateYaml | null);
  const store: any = {
    readPortfolio: async () => portfolio, writePortfolio: async (value: PortfolioYaml) => { portfolio = value; },
    readStrategy: async () => strategy, writeStrategy: async (value: StrategyYaml) => { strategy = value; },
    readSchedules: async () => schedules, writeSchedules: async (value: SchedulesYaml) => { schedules = value; },
    readNotification: async () => notification, writeNotification: async (value: NotificationYaml) => { notification = value; },
    readWatch: async () => watch, writeWatch: async (value: Record<string, unknown>) => { watch = value; },
    readOnboardingState: async () => state, writeOnboardingState: async (value: OnboardingStateYaml) => { state = value; },
  };
  const nextState = await applyOnboardingDraftCommit({ store, steps: input.steps, now: input.now });
  const now = input.now || new Date().toISOString();
  // Product decision (2026-08-14): a user who finishes onboarding is schedulable.
  // Migrated targets keep their imported activation until explicitly changed.
  const schedulerActivation = nextState.status === "completed"
    ? "enabled"
    : preferences.schedulerActivation || "disabled_until_target_cold_start_and_explicit_enable";
  const nextPreferences = {
    ...preferences, schedules, notification, watch, onboardingState: nextState,
    sourceRevision: now,
    schedulerActivation,
  };
  return {
    state: nextState,
    persist() {
      sqlite.prepare("UPDATE mastra_portfolio_states SET portfolio_json=?, source_path=?, source_checksum=?, source_revision=?, migration_batch_id=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
        .run(JSON.stringify(portfolio), "service-owned://onboarding", `service:${now}`, now, "service-owned", now, input.userId, projectId, input.instanceId);
      sqlite.prepare("UPDATE mastra_project_profiles SET profile_json=?, source_path=?, source_checksum=?, source_revision=?, migration_batch_id=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
        .run(JSON.stringify(strategy), "service-owned://onboarding", `service:${now}`, now, "service-owned", now, input.userId, projectId, input.instanceId);
      sqlite.prepare("UPDATE mastra_runtime_preferences SET preferences_json=?, source_revision=?, migration_batch_id=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
        .run(JSON.stringify(nextPreferences), now, "service-owned", now, input.userId, projectId, input.instanceId);
    },
  };
}

export async function applyMastraOnboardingDraftCommit(input: {
  userId: string;
  instanceId: string;
  projectId?: string;
  steps: Partial<Record<OnboardingStepKey, Record<string, unknown>>>;
  now?: string;
}): Promise<OnboardingStateYaml> {
  const prepared = await prepareMastraOnboardingDraftCommit(input);
  sqlite.transaction(() => prepared.persist())();
  return prepared.state;
}

/**
 * Open a service-owned in-memory onboarding store for the Mastra backend.
 *
 * Unlike prepareMastraOnboardingDraftCommit (which requires imported
 * projections for migrated users), reads fall back to the same empty defaults
 * a fresh WorkspaceStore would return, so brand-new users can confirm
 * onboarding before any projection row exists. persist() upserts every
 * touched projection; the caller owns the wrapping SQLite transaction.
 * appendChangeLog is a no-op because durable audit goes through the
 * service-owned sandbox audit table, not a workspace JSONL file.
 */
export function openMastraOnboardingStore(input: {
  userId: string;
  instanceId: string;
  projectId?: string;
}): { store: any; persist(): void } {
  const projectId = input.projectId || process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
  const parse = (raw: string | undefined, label: string): Record<string, any> => {
    try {
      const value = JSON.parse(raw || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
      return value;
    } catch (error) {
      throw new OnboardingContractError(`MASTRA_PROJECTION_INVALID: ${label}: ${(error as Error).message}`, 500);
    }
  };
  const portfolioRow = sqlite.prepare("SELECT portfolio_json AS value FROM mastra_portfolio_states WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string } | undefined;
  const profileRow = sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string } | undefined;
  const preferenceRow = sqlite.prepare("SELECT preferences_json AS value FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(input.userId, projectId, input.instanceId) as { value?: string } | undefined;
  let portfolio = (portfolioRow ? parse(portfolioRow.value, "portfolio") : { holdings: [], watchlist: [], accounts: [] }) as PortfolioYaml;
  let strategy = (profileRow ? parse(profileRow.value, "strategy") : {}) as StrategyYaml;
  const preferences = preferenceRow ? parse(preferenceRow.value, "runtime preferences") : {};
  let schedules = (preferences.schedules && typeof preferences.schedules === "object" ? preferences.schedules : {}) as SchedulesYaml;
  let notification = (preferences.notification && typeof preferences.notification === "object" ? preferences.notification : {}) as NotificationYaml;
  let watch = (preferences.watch && typeof preferences.watch === "object" ? preferences.watch : {}) as Record<string, unknown>;
  let state = normalizeOnboardingState(preferences.onboardingState as OnboardingStateYaml | null);
  const store: any = {
    readPortfolio: async () => portfolio, writePortfolio: async (value: PortfolioYaml) => { portfolio = value; },
    readStrategy: async () => strategy, writeStrategy: async (value: StrategyYaml) => { strategy = value; },
    readSchedules: async () => schedules, writeSchedules: async (value: SchedulesYaml) => { schedules = value; },
    readNotification: async () => notification, writeNotification: async (value: NotificationYaml) => { notification = value; },
    readWatch: async () => watch, writeWatch: async (value: Record<string, unknown>) => { watch = value; },
    readOnboardingState: async () => state, writeOnboardingState: async (value: OnboardingStateYaml) => { state = value; },
    appendChangeLog: async () => undefined,
  };
  return {
    store,
    persist() {
      const now = new Date().toISOString();
      const upsertOwnedState = (table: string, valueColumn: string, valueJson: string) => {
        const exists = sqlite.prepare(`SELECT 1 AS one FROM ${table} WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1`)
          .get(input.userId, projectId, input.instanceId);
        if (exists) {
          sqlite.prepare(`UPDATE ${table} SET ${valueColumn}=?, source_path=COALESCE(source_path,'service-owned://onboarding'), source_checksum=COALESCE(source_checksum,?), source_revision=?, migration_batch_id=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?`)
            .run(valueJson, `service:${now}`, now, "service-owned", now, input.userId, projectId, input.instanceId);
        } else {
          sqlite.prepare(`INSERT INTO ${table} (user_id,project_id,instance_id,${valueColumn},source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(input.userId, projectId, input.instanceId, valueJson, "service-owned://onboarding", `service:${now}`, now, "service-owned", now, now);
        }
      };
      upsertOwnedState("mastra_portfolio_states", "portfolio_json", JSON.stringify(portfolio));
      upsertOwnedState("mastra_project_profiles", "profile_json", JSON.stringify(strategy));
      // Product decision (2026-08-14): a user who finishes onboarding is schedulable.
      // Migrated targets keep their imported activation until explicitly changed.
      const schedulerActivation = state.status === "completed"
        ? "enabled"
        : preferences.schedulerActivation || "disabled_until_target_cold_start_and_explicit_enable";
      const nextPreferences = {
        ...preferences, schedules, notification, watch, onboardingState: state,
        sourceRevision: now,
        schedulerActivation,
      };
      const preferenceExists = sqlite.prepare("SELECT 1 AS one FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
        .get(input.userId, projectId, input.instanceId);
      if (preferenceExists) {
        sqlite.prepare("UPDATE mastra_runtime_preferences SET preferences_json=?, source_revision=?, migration_batch_id=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
          .run(JSON.stringify(nextPreferences), now, "service-owned", now, input.userId, projectId, input.instanceId);
      } else {
        sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(input.userId, projectId, input.instanceId, JSON.stringify(nextPreferences), "{}", now, "service-owned", now, now);
      }
    },
  };
}

/**
 * Mark a draft commit visible only after every service-owned side effect has
 * succeeded. The key is persisted with the state so a worker retry cannot
 * append the same completion audit record again.
 */
export async function finalizeOnboardingDraftCommit(input: {
  store: WorkspaceStore;
  state: OnboardingStateYaml;
  commitKey: string;
  steps: string[];
}): Promise<void> {
  const current = await input.store.readOnboardingState() as (OnboardingStateYaml & { draft_commit_key?: string }) | null;
  if (current?.draft_commit_key === input.commitKey) return;
  await input.store.writeOnboardingState({
    ...input.state,
    draft_commit_key: input.commitKey,
  });
  await input.store.appendChangeLog({
    ts: input.state.updated_at ?? new Date().toISOString(),
    source: "mcp",
    type: "onboarding_draft_committed",
    summary: "已统一完成初始配置",
    details: { commit_key: input.commitKey, steps: input.steps },
  });
}

export function validateOnboardingPortfolioPayload(body: Record<string, unknown>) {
  const holdings = normalizePortfolioAssets(body.holdings);
  const watchlist = normalizePortfolioAssets(body.watchlist);
  if (holdings.length === 0 && watchlist.length === 0) {
    throw new OnboardingContractError("至少需要一个持仓或观察仓标的");
  }
  const missing = [...holdings, ...watchlist].filter((item) => !/^\d{6}$/.test(item.code));
  if (missing.length > 0) throw new OnboardingContractError("持仓和观察仓写入前必须补齐 6 位证券代码");
}

function mergePortfolioDraft(existing: Record<string, any>, body: Record<string, unknown>, now: string) {
  const merge = (current: unknown, input: unknown) => {
    const result = Array.isArray(current) ? [...current] : [];
    for (const item of normalizePortfolioAssets(input)) {
      const index = result.findIndex((value: any) => value?.code === item.code || value?.name === item.name);
      const next = { ...(index >= 0 ? result[index] : {}), ...item };
      if (index >= 0) result[index] = next;
      else result.push(next);
    }
    return result;
  };
  return {
    ...existing,
    cash: mergeCashDraft(existing.cash, body),
    holdings: merge(existing.holdings, body.holdings),
    watchlist: merge(existing.watchlist, body.watchlist),
    accounts: Array.isArray(existing.accounts) ? existing.accounts : [],
    last_confirmed_at: now,
    last_confirmed_by: "user",
  };
}

function mergeCashDraft(existing: unknown, body: Record<string, unknown>) {
  const current = record(existing);
  const cash = record(body.cash);
  const ratio = numericValue(body.cashPositionPercent ?? body.cash_position_percent ?? cash.ratio_percent ?? cash.ratioPercent ?? cash.allocationPercent ?? cash.allocation_percent ?? cash.approximatePositionPercent ?? cash.approximate_position_percent);
  const available = numericValue(cash.available ?? body.cashAvailable ?? body.cash_available);
  const previousNotes = stringValue(current.notes) ?? "";
  const ratioNote = ratio === undefined ? "" : `现金仓位约 ${ratio}%`;
  return {
    available: available ?? current.available ?? null,
    currency: stringValue(cash.currency) ?? current.currency ?? "CNY",
    locked: current.locked ?? null,
    safety_buffer: current.safety_buffer ?? null,
    ...current,
    ...cash,
    ...(ratio === undefined ? {} : { ratio_percent: ratio }),
    notes: ratioNote || previousNotes,
  };
}

function normalizePortfolioAssets(value: unknown): Array<Record<string, any> & { name: string; code: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const notes = String(item.notes ?? "");
      const noteCost = /成本\s*([0-9]+(?:\.[0-9]+)?)/.exec(notes)?.[1];
      const noteWeight = /仓位\s*([0-9]+(?:\.[0-9]+)?)\s*%/.exec(notes)?.[1];
      return {
      ...item,
      name: String(item.name ?? "").trim(),
      code: String(item.code ?? "").trim(),
      ...(numericValue(item.cost ?? item.costPrice ?? item.cost_price ?? noteCost) === undefined ? {} : { cost: numericValue(item.cost ?? item.costPrice ?? item.cost_price ?? noteCost) }),
      ...(numericValue(item.weight ?? item.positionPercent ?? item.position_percent ?? noteWeight) === undefined ? {} : { weight: numericValue(item.weight ?? item.positionPercent ?? item.position_percent ?? noteWeight) }),
      };
    })
    .filter((item) => item.name || item.code)
    .map((item) => ({ ...item, name: item.name || item.code }));
}

async function verifyDraftCommit(store: WorkspaceStore, expectedStyle: string | undefined, expectedNotificationMode: NotificationMode) {
  const [portfolio, strategy, schedules, notification, watch] = await Promise.all([
    store.readPortfolio(), store.readStrategy(), store.readSchedules(), store.readNotification(), store.readWatch(),
  ]);
  if (!portfolio?.last_confirmed_at) throw new OnboardingContractError("统一提交后 portfolio 未落盘", 500);
  if (!strategy?.last_confirmed_at || (expectedStyle && strategy.profile?.style !== expectedStyle)) throw new OnboardingContractError("统一提交后 strategy 未按草稿落盘", 500);
  if (!record(schedules).daily_review || !Array.isArray(record(record(schedules).market_watch).default_windows)) throw new OnboardingContractError("统一提交后 schedules 不完整", 500);
  if (record(notification?.preference).mode !== expectedNotificationMode) throw new OnboardingContractError("统一提交后通知偏好不一致", 500);
  if (!watch?.last_confirmed_at) throw new OnboardingContractError("统一提交后 watch 未落盘", 500);
}

function assertStepOrder(state: OnboardingStateYaml, step: OnboardingStepKey) {
  const missing = REQUIRED_BEFORE[step].filter((required) => state.steps?.[required]?.done !== true);
  if (missing.length > 0) {
    throw new OnboardingContractError(`不能跳过 onboarding 前置步骤；请先完成: ${missing.join(", ")}`, 409);
  }
}

export function validateOnboardingStepPayload(step: OnboardingStepKey, body: Record<string, unknown>) {
  if (step === "welcome" || step === "portfolio") {
    throw new OnboardingContractError(`${step} 不能通过 confirm-step 单独推进`);
  }
  if (step === "style") {
    const profile = normalizeStyleProfile(body);
    if (!profile.style && !profile.notes) {
      throw new OnboardingContractError("style 确认必须携带 styleProfile 的策略摘要，不能只推进 onboarding 状态");
    }
  }
  if (step === "review_schedule" && hasReviewInput(body)) {
    const schedule = readReviewSchedule(body);
    if (!record(schedule.daily_review).default_time && !record(schedule.weekly_review).default_time && !record(schedule.monthly_review).default_time) {
      throw new OnboardingContractError("review_schedule 包含复盘时间字段，但没有可识别的 default_time");
    }
  }
  if (step === "market_watch_schedule" && hasMarketWatchInput(body) && (readMarketWatchSchedule(body).default_windows ?? []).length === 0) {
    throw new OnboardingContractError("market_watch_schedule 包含盘中简报时间字段，但没有可识别的 HH:MM 时间");
  }
}

async function applyStepConfiguration(store: WorkspaceStore, step: OnboardingStepKey, body: Record<string, unknown>, now: string) {
  if (step === "style") await writeStyle(store, body, now);
  if (step === "review_schedule") await writeReviewSchedule(store, body);
  if (step === "market_watch_schedule") await writeMarketWatchSchedule(store, body);
  if (step === "notification") await writeNotification(store, body, now);
  if (step === "watch_rules") await writeWatchBoundary(store, body, now);
}

async function writeStyle(store: WorkspaceStore, body: Record<string, unknown>, now: string) {
  const profile = normalizeStyleProfile(body);
  const existing = await store.readStrategy() ?? {};
  await store.writeStrategy({
    ...existing,
    profile: {
      ...(existing.profile ?? {}),
      style: profile.style ?? existing.profile?.style ?? "自定义策略",
      selected_style_pack: profile.selectedStylePack === null ? null : profile.selectedStylePack ?? existing.profile?.selected_style_pack ?? null,
      custom_style_enabled: typeof profile.customStyleEnabled === "boolean"
        ? profile.customStyleEnabled
        : existing.profile?.custom_style_enabled ?? true,
      risk_preference: profile.riskPreference ?? existing.profile?.risk_preference ?? "",
      investment_horizon: profile.investmentHorizon ?? existing.profile?.investment_horizon ?? "",
    },
    buy_rules: profile.buyRules ?? existing.buy_rules ?? [],
    sell_rules: profile.sellRules ?? existing.sell_rules ?? [],
    risk_rules: profile.riskRules ?? existing.risk_rules ?? [],
    notes: profile.notes ?? existing.notes ?? "",
    last_confirmed_at: now,
  });
}

async function writeReviewSchedule(store: WorkspaceStore, body: Record<string, unknown>) {
  const schedules = await store.readSchedules() ?? {};
  const requested = readReviewSchedule(body);
  await store.writeSchedules({
    ...schedules,
    timezone: schedules.timezone ?? "Asia/Shanghai",
    run_policy: {
      automatic_by_default: true,
      manual_trigger_allowed: true,
      skip_automatic_if_manual_report_exists: true,
      refresh_requires_user_confirmation: true,
      ...record(schedules.run_policy),
    },
    daily_review: { enabled: true, auto_run: true, default_time: "19:00", trading_days_only: true, ...record(requested.daily_review) },
    weekly_review: { enabled: true, auto_run: true, default_time: "Saturday 09:00", ...record(requested.weekly_review) },
    monthly_review: { enabled: true, auto_run: true, default_time: "day_1 09:00", review_previous_month: true, ...record(requested.monthly_review) },
    company_financial_analysis: { enabled: true, trigger: "user_request_or_new_report_detected", ...record(requested.company_financial_analysis) },
  });
}

async function writeMarketWatchSchedule(store: WorkspaceStore, body: Record<string, unknown>) {
  const schedules = await store.readSchedules() ?? {};
  const requested = readMarketWatchSchedule(body);
  await store.writeSchedules({
    ...schedules,
    timezone: schedules.timezone ?? "Asia/Shanghai",
    market_watch: {
      enabled: true,
      auto_run: true,
      default_windows: ["09:55", "11:20", "14:30"],
      ...record(schedules.market_watch),
      ...requested,
    },
  });
}

async function writeNotification(store: WorkspaceStore, body: Record<string, unknown>, now: string) {
  const notification = await store.readNotification() ?? {};
  const schedules = await store.readSchedules() ?? {};
  const mode = readNotificationMode(body, schedules);
  const policy = marketWatchPolicy(mode);
  await store.writeNotification({
    ...notification,
    preference: { mode, label: NOTIFICATION_LABELS[mode], description: NOTIFICATION_DESCRIPTIONS[mode] },
    user_mode: notification.user_mode ?? "working_professional",
    working_hours: {
      start: "09:00",
      end: "18:00",
      ...record(notification.working_hours),
      policy: mode === "active_watch"
        ? "按用户设置的盘中简报时间推送摘要。"
        : mode === "evening_summary"
          ? "盘中不主动推送，晚上统一查看复盘和关注事项。"
          : "盘中不主动推送普通信息，减少不必要打扰。",
    },
    do_not_disturb: { ...record(notification.do_not_disturb), enabled: mode !== "active_watch", allow_p0_override: false },
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
      ...record(schedules.market_watch),
      ...policy,
    },
  });
}

async function writeWatchBoundary(store: WorkspaceStore, body: Record<string, unknown>, now: string) {
  const watch = await store.readWatch() ?? {};
  const notification = await store.readNotification() ?? {};
  const mode = normalizeNotificationMode(record(notification.preference).mode);
  const policy = marketWatchPolicy(mode);
  const overrides = record(body.watchPolicy);
  const { default_check_windows: _windows, fixed_intraday_brief: _brief, ...safeOverrides } = overrides;
  await store.writeWatch({
    ...watch,
    mode: typeof watch.mode === "string" ? watch.mode : "default",
    only_push_on_exception: policy.only_push_on_exception,
    priority_policy: mode === "active_watch"
      ? "用户偏好为积极盯盘：固定盘中简报时间推送摘要，重大风险单独提醒；事件优先级仍由系统内部判断。"
      : "用户偏好为低打扰/晚间汇总：盘中只打断可能需要当天处理的事项，其他进入晚间复盘或记录；事件优先级由系统内部判断。",
    exception_rules: Array.isArray(watch.exception_rules) && watch.exception_rules.length > 0 ? watch.exception_rules : [],
    custom_rules: Array.isArray(watch.custom_rules) ? watch.custom_rules : [],
    last_confirmed_at: now,
    confirmed_watch_rule_summary: [
      `已确认通知偏好：${NOTIFICATION_LABELS[mode]}。`,
      NOTIFICATION_DESCRIPTIONS[mode],
      "尚未创建具体明确规则；如需创建价格或指标提醒，必须另行确认。",
    ],
    ...safeOverrides,
  });
}

async function verifyStepConfiguration(store: WorkspaceStore, step: OnboardingStepKey, body: Record<string, unknown>) {
  if (step === "style") {
    const strategy = await store.readStrategy();
    const expected = normalizeStyleProfile(body).style;
    if (!strategy?.last_confirmed_at || (expected && strategy.profile?.style !== expected)) {
      throw new OnboardingContractError("style 已确认但 strategy.yaml 未按请求落盘", 500);
    }
  }
  if (step === "review_schedule") {
    const schedules = record(await store.readSchedules());
    if (!record(schedules.daily_review).default_time || !record(schedules.weekly_review).default_time || !record(schedules.monthly_review).default_time) {
      throw new OnboardingContractError("review_schedule 已确认但日/周/月复盘时间不完整", 500);
    }
  }
  if (step === "market_watch_schedule") {
    const actual = record(record(await store.readSchedules()).market_watch).default_windows;
    if (!Array.isArray(actual) || actual.length === 0) {
      throw new OnboardingContractError("market_watch_schedule 已确认但盘中简报时间为空", 500);
    }
  }
  if (step === "notification") {
    const expected = readNotificationMode(body, await store.readSchedules() ?? {});
    const actual = record((await store.readNotification())?.preference).mode;
    if (actual !== expected) throw new OnboardingContractError("notification 已确认但通知偏好未按请求落盘", 500);
  }
}

function normalizeStyleProfile(body: Record<string, unknown>) {
  const profile = record(body.styleProfile ?? body.style_profile);
  const selectedStylePack = profile.selectedStylePack ?? profile.selected_style_pack;
  const buyRules = profile.buyRules ?? profile.buy_rules ?? profile.entryRules ?? profile.entry_rules;
  const sellRules = profile.sellRules ?? profile.sell_rules ?? profile.exitRules ?? profile.exit_rules;
  const riskRules = profile.riskRules ?? profile.risk_rules;
  const notes = [
    profile.notes,
    profile.strategySummary,
    profile.strategy_summary,
    profile.summary,
    profile.corePrinciple,
    profile.core_principle,
    profile.riskNotes,
    profile.risk_notes,
    body.notes,
    body.summary,
  ].map(stringValue).find(Boolean);
  return {
    style: stringValue(profile.style ?? profile.name ?? body.style),
    notes,
    selectedStylePack: selectedStylePack === null ? null : stringValue(selectedStylePack),
    customStyleEnabled: typeof (profile.customStyleEnabled ?? profile.custom_style_enabled) === "boolean"
      ? Boolean(profile.customStyleEnabled ?? profile.custom_style_enabled)
      : undefined,
    riskPreference: stringValue(profile.riskPreference ?? profile.risk_preference),
    investmentHorizon: stringValue(profile.investmentHorizon ?? profile.investment_horizon ?? profile.holdingHorizon ?? profile.holding_horizon),
    buyRules: Array.isArray(buyRules) ? buyRules : undefined,
    sellRules: Array.isArray(sellRules) ? sellRules : undefined,
    riskRules: Array.isArray(riskRules) ? riskRules : undefined,
  };
}

function readReviewSchedule(body: Record<string, unknown>) {
  const input = record(body.reviewSchedule ?? body.review_schedule);
  const dailyTime = stringValue(body.dailyReviewTime ?? body.daily_review_time ?? body.time);
  return {
    daily_review: { ...record(input.daily_review), ...(dailyTime ? { default_time: dailyTime } : {}) },
    weekly_review: { ...record(input.weekly_review), ...(stringValue(body.weeklyReviewTime ?? body.weekly_review_time) ? { default_time: stringValue(body.weeklyReviewTime ?? body.weekly_review_time) } : {}) },
    monthly_review: { ...record(input.monthly_review), ...(stringValue(body.monthlyReviewTime ?? body.monthly_review_time) ? { default_time: stringValue(body.monthlyReviewTime ?? body.monthly_review_time) } : {}) },
    company_financial_analysis: record(input.company_financial_analysis),
  };
}

function readMarketWatchSchedule(body: Record<string, unknown>) {
  const input = record(body.marketWatchSchedule ?? body.market_watch_schedule);
  const rawWindows = input.default_windows ?? input.defaultWindows ?? body.marketWatchWindows ?? body.market_watch_windows ?? body.default_windows ?? body.defaultWindows;
  const windows = normalizeWindows(rawWindows);
  const pushMode = normalizePushMode(input.push_mode ?? input.pushMode ?? body.pushMode ?? body.push_mode);
  const onlyPush = typeof input.only_push_on_exception === "boolean"
    ? input.only_push_on_exception
    : pushMode === "scheduled_intraday_brief" ? false : true;
  return {
    ...(windows.length > 0 ? { default_windows: windows } : {}),
    custom_frequency: input.custom_frequency ?? null,
    only_push_on_exception: onlyPush,
    push_mode: pushMode ?? (onlyPush ? "exception_only" : "scheduled_intraday_brief"),
  };
}

function readNotificationMode(body: Record<string, unknown>, schedules: Record<string, unknown>): NotificationMode {
  const raw = body.notificationPreference ?? body.notification_preference ?? body.notification ?? body.preference ?? body.notification_mode ?? body.notificationMode ?? body.mode;
  if (raw !== undefined) return normalizeNotificationMode(record(raw).mode ?? raw);
  const marketWatch = record(schedules.market_watch);
  return marketWatch.only_push_on_exception === false || normalizePushMode(marketWatch.push_mode) === "scheduled_intraday_brief"
    ? "active_watch"
    : "low_disturbance";
}

function normalizeNotificationMode(value: unknown): NotificationMode {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "active_watch" || normalized === "active" || normalized === "积极盯盘") return "active_watch";
  if (normalized === "evening_summary" || normalized === "evening" || normalized === "晚间汇总") return "evening_summary";
  return "low_disturbance";
}

function marketWatchPolicy(mode: NotificationMode) {
  return mode === "active_watch"
    ? { only_push_on_exception: false, push_mode: "scheduled_intraday_brief" }
    : { only_push_on_exception: true, push_mode: "exception_only" };
}

function normalizeWindows(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeTime(item)).filter((item): item is string => Boolean(item)))];
}

function normalizeTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizePushMode(value: unknown): "exception_only" | "scheduled_intraday_brief" | undefined {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["scheduled_intraday_brief", "scheduled_brief", "every_check_brief", "active_watch"].includes(normalized)) return "scheduled_intraday_brief";
  if (["exception_only", "only_push_on_exception", "low_disturbance"].includes(normalized)) return "exception_only";
  return undefined;
}

function hasReviewInput(body: Record<string, unknown>) {
  return [body.reviewSchedule, body.review_schedule, body.dailyReviewTime, body.daily_review_time, body.weeklyReviewTime, body.weekly_review_time, body.monthlyReviewTime, body.monthly_review_time, body.time].some((value) => value !== undefined);
}

function hasMarketWatchInput(body: Record<string, unknown>) {
  const input = record(body.marketWatchSchedule ?? body.market_watch_schedule);
  return [body.marketWatchWindows, body.market_watch_windows, body.default_windows, body.defaultWindows, input.default_windows, input.defaultWindows].some(Array.isArray);
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numericValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}
