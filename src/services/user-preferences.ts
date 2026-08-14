import { sqlite } from "../db/index.js";
import { DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { WorkspaceStore, type NotificationYaml, type SchedulesYaml, type OnboardingStateYaml, type WatchYaml } from "../lib/workspace-store.js";

export interface UserPreferenceStore {
  readSchedules(): Promise<SchedulesYaml | null>;
  readNotification(): Promise<NotificationYaml | null>;
  writeSchedules(value: SchedulesYaml): Promise<void>;
  writeNotification(value: NotificationYaml): Promise<void>;
  readOnboardingState?(): Promise<OnboardingStateYaml | null>;
  writeOnboardingState?(value: OnboardingStateYaml): Promise<void>;
  readWatch?(): Promise<WatchYaml | null>;
  writeWatch?(value: WatchYaml): Promise<void>;
  appendChangeLogOnce?: (...args: any[]) => Promise<any>;
}

export class MastraUserPreferenceStore implements UserPreferenceStore {
  constructor(private readonly userId: string, private readonly instanceId: string, private readonly projectId = process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID) {}

  private read(): { schedules: SchedulesYaml; notification: NotificationYaml; onboardingState: OnboardingStateYaml | null; watch: WatchYaml } {
    const row = sqlite.prepare(
      "SELECT preferences_json AS preferencesJson FROM mastra_runtime_preferences WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
    ).get(this.userId, this.projectId, this.instanceId) as { preferencesJson?: string } | undefined;
    if (!row) return { schedules: {}, notification: {}, onboardingState: null, watch: {} };
    try {
      const value = JSON.parse(row.preferencesJson || "{}");
      return {
        schedules: record(value?.schedules) as SchedulesYaml,
        notification: record(value?.notification) as NotificationYaml,
        onboardingState: record(value?.onboardingState) as OnboardingStateYaml,
        watch: record(value?.watch) as WatchYaml,
      };
    } catch (error) {
      throw new Error(`MASTRA_PROJECTION_INVALID: runtime preferences payload is invalid: ${(error as Error).message}`);
    }
  }

  private write(next: { schedules: SchedulesYaml; notification: NotificationYaml; onboardingState?: OnboardingStateYaml | null; watch?: WatchYaml }): void {
    const now = new Date().toISOString();
    const current = this.read();
    const payload = JSON.stringify({ schedules: next.schedules, notification: next.notification, onboardingState: next.onboardingState ?? current.onboardingState, watch: next.watch ?? current.watch });
    sqlite.transaction(() => {
      const existing = sqlite.prepare(
        "SELECT source_checksums_json AS sourceChecksumsJson FROM mastra_runtime_preferences WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
      ).get(this.userId, this.projectId, this.instanceId) as { sourceChecksumsJson?: string } | undefined;
      const checksums = existing?.sourceChecksumsJson || "{}";
      if (existing) {
        sqlite.prepare(
          "UPDATE mastra_runtime_preferences SET preferences_json = ?, source_checksums_json = ?, source_revision = ?, migration_batch_id = ?, updated_at = ? WHERE user_id = ? AND project_id = ? AND instance_id = ?",
        ).run(payload, checksums, currentRevision(next.schedules, next.notification), "service-owned", now, this.userId, this.projectId, this.instanceId);
      } else {
        sqlite.prepare(
          "INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).run(this.userId, this.projectId, this.instanceId, payload, checksums, currentRevision(next.schedules, next.notification), "service-owned", now, now);
      }
    })();
  }

  async readSchedules() { return this.read().schedules; }
  async readNotification() { return this.read().notification; }
  async writeSchedules(value: SchedulesYaml) { const current = this.read(); this.write({ schedules: value, notification: current.notification }); }
  async writeNotification(value: NotificationYaml) { const current = this.read(); this.write({ schedules: current.schedules, notification: value }); }
  async readOnboardingState() { return this.read().onboardingState; }
  async writeOnboardingState(value: OnboardingStateYaml) { const current = this.read(); this.write({ schedules: current.schedules, notification: current.notification, onboardingState: value }); }
  async readWatch() { return this.read().watch; }
  async writeWatch(value: WatchYaml) { const current = this.read(); this.write({ schedules: current.schedules, notification: current.notification, onboardingState: current.onboardingState, watch: value }); }
}

export type NotificationPreferenceMode = "low_disturbance" | "active_watch" | "evening_summary";

export interface UserPreferenceChangeInput {
  reviewSchedule?: Record<string, unknown>;
  marketWatchSchedule?: Record<string, unknown>;
  notificationPreference?: string | Record<string, unknown>;
  expectedLastConfirmedAt?: string | null;
  confirmationId?: string;
}

export interface UserPreferenceChangePlan {
  schedules: SchedulesYaml;
  notification: NotificationYaml;
  currentRevision: string | null;
  changedPaths: string[];
  alreadyApplied?: boolean;
}

const NOTIFICATION_LABELS: Record<NotificationPreferenceMode, string> = {
  low_disturbance: "低打扰",
  active_watch: "积极盯盘",
  evening_summary: "晚间汇总",
};

const NOTIFICATION_DESCRIPTIONS: Record<NotificationPreferenceMode, string> = {
  low_disturbance: "盘中不主动推送普通信息，减少不必要打扰。",
  active_watch: "在每个盘中简报时间推送持仓与市场摘要。",
  evening_summary: "盘中不主动推送，晚上统一查看复盘和关注事项。",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeMode(value: unknown): NotificationPreferenceMode | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "low_disturbance" || raw === "低打扰") return "low_disturbance";
  if (raw === "active_watch" || raw === "active" || raw === "积极盯盘") return "active_watch";
  if (raw === "evening_summary" || raw === "evening" || raw === "晚间汇总") return "evening_summary";
  return null;
}

function currentRevision(schedules: SchedulesYaml, notification: NotificationYaml): string | null {
  const revisions = [schedules.last_confirmed_at, notification.last_confirmed_at]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return revisions.at(-1) ?? null;
}

function validateReviewSchedule(value: Record<string, unknown>) {
  const sections = ["daily_review", "weekly_review", "monthly_review", "company_financial_analysis"]
    .map((key) => record(value[key]))
    .filter((section) => Object.keys(section).length > 0);
  if (sections.length === 0) throw new Error("reviewSchedule 至少需要一个复盘配置段");
  for (const section of sections) {
    if (section.default_time !== undefined && typeof section.default_time !== "string") {
      throw new Error("reviewSchedule.default_time 必须是字符串");
    }
  }
}

function validateMarketWatchSchedule(value: Record<string, unknown>) {
  if (value.default_windows !== undefined) {
    if (!Array.isArray(value.default_windows) || !value.default_windows.every((item) => typeof item === "string" && /^\d{2}:\d{2}$/.test(item))) {
      throw new Error("marketWatchSchedule.default_windows 必须是 HH:MM 字符串数组");
    }
  }
  if (value.custom_frequency !== undefined && value.custom_frequency !== null) {
    if (typeof value.custom_frequency !== "number" || !Number.isFinite(value.custom_frequency) || value.custom_frequency <= 0) {
      throw new Error("marketWatchSchedule.custom_frequency 必须是正数或 null");
    }
  }
  if (!Object.keys(value).length) throw new Error("marketWatchSchedule 不能为空");
}

function notificationMode(value: string | Record<string, unknown>): NotificationPreferenceMode {
  const mode = normalizeMode(typeof value === "string" ? value : value.mode);
  if (!mode) throw new Error("notificationPreference.mode 必须是 low_disturbance、active_watch 或 evening_summary");
  return mode;
}

function marketWatchPolicy(mode: NotificationPreferenceMode) {
  return mode === "active_watch"
    ? { only_push_on_exception: false, push_mode: "scheduled_intraday_brief" }
    : { only_push_on_exception: true, push_mode: "exception_only" };
}

export async function planUserPreferenceChange(store: UserPreferenceStore, input: UserPreferenceChangeInput): Promise<UserPreferenceChangePlan> {
  const schedules = await store.readSchedules() ?? {};
  const notification = await store.readNotification() ?? {};
  const hasReview = input.reviewSchedule !== undefined;
  const hasMarketWatch = input.marketWatchSchedule !== undefined;
  const hasNotification = input.notificationPreference !== undefined;
  if (!hasReview && !hasMarketWatch && !hasNotification) throw new Error("至少需要修改一项用户偏好");

  const requestedPaths = new Set<string>();
  if (hasReview || hasMarketWatch || hasNotification) requestedPaths.add("config/schedules.yaml");
  if (hasNotification) requestedPaths.add("config/notification.yaml");

  if (hasReview) validateReviewSchedule(record(input.reviewSchedule));
  if (hasMarketWatch) validateMarketWatchSchedule(record(input.marketWatchSchedule));
  const mode = hasNotification
    ? notificationMode(input.notificationPreference as string | Record<string, unknown>)
    : null;

  const current = currentRevision(schedules, notification);
  const alreadyApplied = Boolean(input.confirmationId)
    && [...requestedPaths].every((relativePath) => relativePath === "config/schedules.yaml"
      ? schedules.last_confirmation_id === input.confirmationId
      : notification.last_confirmation_id === input.confirmationId);
  if (alreadyApplied) {
    return {
      schedules,
      notification,
      currentRevision: current,
      changedPaths: [...requestedPaths],
      alreadyApplied: true,
    };
  }
  if (input.expectedLastConfirmedAt !== undefined && input.expectedLastConfirmedAt !== current) {
    throw new Error("用户偏好配置已发生变化，请重新读取后生成草案");
  }

  const now = new Date().toISOString();
  const nextSchedules: SchedulesYaml = { ...schedules };
  const nextNotification: NotificationYaml = { ...notification };
  const changedPaths: string[] = [];

  if (hasReview) {
    const requested = record(input.reviewSchedule);
    nextSchedules.daily_review = { enabled: true, auto_run: true, ...record(schedules.daily_review), ...record(requested.daily_review) };
    nextSchedules.weekly_review = { enabled: true, auto_run: true, ...record(schedules.weekly_review), ...record(requested.weekly_review) };
    nextSchedules.monthly_review = { enabled: true, auto_run: true, ...record(schedules.monthly_review), ...record(requested.monthly_review) };
    nextSchedules.company_financial_analysis = { enabled: true, ...record(schedules.company_financial_analysis), ...record(requested.company_financial_analysis) };
    nextSchedules.last_confirmed_at = now;
    if (input.confirmationId) nextSchedules.last_confirmation_id = input.confirmationId;
    changedPaths.push("config/schedules.yaml");
  }

  if (hasMarketWatch) {
    nextSchedules.market_watch = {
      enabled: true,
      auto_run: true,
      ...record(schedules.market_watch),
      ...record(input.marketWatchSchedule),
    };
    nextSchedules.last_confirmed_at = now;
    if (input.confirmationId) nextSchedules.last_confirmation_id = input.confirmationId;
    changedPaths.push("config/schedules.yaml");
  }

  if (mode) {
    nextNotification.preference = {
      mode,
      label: NOTIFICATION_LABELS[mode],
      description: NOTIFICATION_DESCRIPTIONS[mode],
    };
    nextNotification.working_hours = {
      start: "09:00",
      end: "18:00",
      ...record(notification.working_hours),
      policy: mode === "active_watch"
        ? "按用户设置的盘中简报时间推送摘要。"
        : mode === "evening_summary"
          ? "盘中不主动推送，晚上统一查看复盘和关注事项。"
          : "盘中不主动推送普通信息，减少不必要打扰。",
    };
    nextNotification.do_not_disturb = { ...record(notification.do_not_disturb), enabled: mode !== "active_watch", allow_p0_override: false };
    nextNotification.last_confirmed_at = now;
    if (input.confirmationId) nextNotification.last_confirmation_id = input.confirmationId;
    nextSchedules.market_watch = {
      enabled: true,
      auto_run: true,
      default_windows: ["09:55", "11:20", "14:30"],
      custom_frequency: null,
      ...record(nextSchedules.market_watch),
      ...marketWatchPolicy(mode),
    };
    nextSchedules.last_confirmed_at = now;
    if (input.confirmationId) nextSchedules.last_confirmation_id = input.confirmationId;
    changedPaths.push("config/notification.yaml", "config/schedules.yaml");
  }

  return {
    schedules: nextSchedules,
    notification: nextNotification,
    currentRevision: current,
    changedPaths: [...new Set(changedPaths)],
    alreadyApplied: false,
  };
}

export async function applyUserPreferenceChange(store: UserPreferenceStore, input: UserPreferenceChangeInput): Promise<UserPreferenceChangePlan & { revision: string }> {
  const previousSchedules = await store.readSchedules();
  const previousNotification = await store.readNotification();
  const plan = await planUserPreferenceChange(store, input);
  const revision = plan.schedules.last_confirmed_at ?? plan.notification.last_confirmed_at;
  if (typeof revision !== "string") throw new Error("用户偏好写入未生成 revision");
  if (plan.alreadyApplied) return { ...plan, revision };
  try {
    if (plan.changedPaths.includes("config/schedules.yaml")) await store.writeSchedules(plan.schedules);
    if (plan.changedPaths.includes("config/notification.yaml")) await store.writeNotification(plan.notification);
    const savedSchedules = await store.readSchedules();
    const savedNotification = await store.readNotification();
    if (plan.changedPaths.includes("config/schedules.yaml") && savedSchedules?.last_confirmed_at !== revision) throw new Error("schedules 回读校验失败");
    if (plan.changedPaths.includes("config/notification.yaml") && savedNotification?.last_confirmed_at !== revision) throw new Error("notification 回读校验失败");
    return { ...plan, schedules: savedSchedules ?? {}, notification: savedNotification ?? {}, revision };
  } catch (error) {
    if (previousSchedules) await store.writeSchedules(previousSchedules);
    if (previousNotification) await store.writeNotification(previousNotification);
    throw error;
  }
}
