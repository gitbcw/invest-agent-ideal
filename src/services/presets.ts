/**
 * Preset registry and application (personalized configuration).
 *
 * Per the "generic capabilities + personalized configuration" principle, the
 * system only provides capabilities; a preset is a named, versioned bundle of
 * configuration data (task templates + delivery policy defaults). Applying a
 * preset instantiates its automation tasks (paused until executors activate
 * them) and writes the delivery-compatible preference fields so the current
 * preference-driven scheduler keeps working during the migration window.
 */
import { sqlite } from "../db/index.js";
import { DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import { MastraUserPreferenceStore } from "./user-preferences.js";
import { activateAutomationTask, createAutomationTask } from "./automation-tasks.js";
import { getScheduledTaskType } from "./scheduled-task-types.js";
import type { AutomationScope } from "./automation-tasks.js";

export interface PresetTaskTemplate {
  taskType: string;
  name: string;
  schedule: {
    frequency: "daily" | "trading_days" | "weekdays" | "weekly" | "monthly";
    time: string;
    timezone: string;
    weekdays?: number[];
    monthlyDay?: number;
    windows?: string[];
  };
}

export interface PresetDefinition {
  id: string;
  version: string;
  kind: "usage-mode" | "strategy" | "rhythm" | "content";
  name: string;
  description: string;
  /** Task instances to create on apply (usage-mode/rhythm packs). */
  taskTemplates?: PresetTaskTemplate[];
  /** Strategy-pack payloads (kind:"strategy"): written into the user's trading-strategy library on apply. */
  strategyTemplates?: Array<{ key: string; name: string; applicability?: string; body: string }>;
  /** Delivery-policy defaults; the semantics belong to this preset, not the system. */
  deliveryPolicy?: {
    onlyPushOnException?: boolean;
  };
}

const BEIJING = "Asia/Shanghai";

export const PRESETS: Record<string, PresetDefinition> = {
  "low-disturbance-review": {
    id: "low-disturbance-review",
    version: "1",
    kind: "usage-mode",
    name: "低打扰复盘型",
    description: "交易日收盘复盘 + 周期复盘 + 盘中只推例外事项。适合以复盘驱动决策、不希望盘中被频繁打扰的用户。",
    taskTemplates: [
      { taskType: "scheduled-daily-review", name: "日复盘", schedule: { frequency: "trading_days", time: "19:00", timezone: BEIJING } },
      { taskType: "scheduled-weekly-review", name: "周复盘", schedule: { frequency: "weekly", time: "09:00", timezone: BEIJING, weekdays: [6] } },
      { taskType: "scheduled-monthly-review", name: "月复盘", schedule: { frequency: "monthly", time: "09:00", timezone: BEIJING, monthlyDay: 1 } },
      { taskType: "scheduled-market-watch", name: "盘中盯盘", schedule: { frequency: "trading_days", time: "14:30", timezone: BEIJING, windows: ["09:55", "11:20", "14:30"] } },
    ],
    deliveryPolicy: { onlyPushOnException: true },
  },
  "strategy-trend-following": {
    id: "strategy-trend-following",
    version: "1",
    kind: "strategy",
    name: "趋势跟踪包",
    description: "跟随中期趋势：均线之上持有，回踩确认加减仓，跌破趋势线离场。",
    strategyTemplates: [
      {
        key: "trend-following-core",
        name: "趋势跟踪（核心）",
        applicability: "有明确中期趋势的标的；震荡市不适用",
        body: "1. 以 20/60 日均线判断趋势方向，价格站上均线且均线向上才可持有。\n2. 回踩 20 日均线不破且缩量，可加仓一步；跌破 60 日均线减半，收盘确认。\n3. 跌破趋势线或前低，全部离场，不抄底不摊薄。\n4. 每次操作以收盘价确认，盘中波动不触发。",
      },
      {
        key: "trend-following-risk",
        name: "趋势跟踪（风控）",
        applicability: "所有趋势持仓",
        body: "1. 单标的最大仓位固定，加仓后不超过上限。\n2. 连续两次止损后暂停该标的开新仓，复盘后再评估。\n3. 亏损达到预设幅度无条件降仓，不与趋势判断冲突。",
      },
    ],
  },
  "strategy-value-reversion": {
    id: "strategy-value-reversion",
    version: "1",
    kind: "strategy",
    name: "价值回归包",
    description: "围绕估值中枢低吸高抛：低估分批买、回归卖出，基本面恶化即离场。",
    strategyTemplates: [
      {
        key: "value-reversion-core",
        name: "价值回归（核心）",
        applicability: "有稳定盈利和估值锚的标的；强周期顶底慎用",
        body: "1. 以估值分位和盈利质量确定估值中枢，低估区分批建仓。\n2. 回归合理估值分位分批卖出，不追求卖在最高。\n3. 基本面恶化（盈利逻辑破坏、治理风险）无论盈亏立即离场。",
      },
      {
        key: "value-reversion-risk",
        name: "价值回归（风控）",
        applicability: "所有价值持仓",
        body: "1. 越跌越买有次数与仓位上限，不无限摊薄。\n2. 单标的亏损达到上限停止补仓，只评估是否离场。\n3. 持有逻辑记录在案，逻辑消失即卖出理由成立。",
      },
    ],
  },
};

/**
 * O1 default-usage-mode contract: silently apply the default preset when the
 * scope owns no typed scheduled tasks yet. Idempotent — scopes that already
 * configured tasks (any kind) keep their configuration untouched.
 */
export async function ensureDefaultUsageMode(scope: AutomationScope, presetId = "low-disturbance-review"): Promise<PresetApplyResult | null> {
  const existing = sqlite.prepare(
    "SELECT 1 AS one FROM automation_tasks WHERE user_id=? AND project_id=? AND instance_id=? AND task_type IS NOT NULL LIMIT 1",
  ).get(scope.userId, scope.projectId, scope.instanceId);
  if (existing) return null;
  return applyPreset(scope, presetId);
}

export function getPreset(id: string): PresetDefinition {
  const preset = PRESETS[id];
  if (!preset) throw new Error(`PRESET_UNKNOWN: ${id}`);
  return preset;
}

export function listStrategyPacks(): PresetDefinition[] {
  return Object.values(PRESETS).filter((preset) => preset.kind === "strategy");
}

/**
 * O2 strategy-pack application: write the pack's strategy templates into the
 * scope's trading-strategy library (upsert by key — user-edited bodies with
 * the same key are preserved, matching the library's own semantics).
 */
export async function applyStrategyPack(scope: AutomationScope, presetId: string): Promise<{ presetId: string; presetVersion: string; applied: string[] }> {
  const preset = getPreset(presetId);
  if (preset.kind !== "strategy") throw new Error(`PRESET_NOT_STRATEGY_PACK: ${presetId}`);
  const { readMastraTradingStrategies, writeMastraTradingStrategy } = await import("../lib/mastra-strategy-library.js");
  const applied: string[] = [];
  for (const template of preset.strategyTemplates ?? []) {
    const existing = readMastraTradingStrategies(scope).find((item) => item.key === template.key);
    if (existing) continue;
    writeMastraTradingStrategy(scope, { key: template.key, name: template.name, applicability: template.applicability, body: template.body });
    applied.push(template.key);
  }
  return { presetId: preset.id, presetVersion: preset.version, applied };
}

export interface PresetApplyResult {
  presetId: string;
  presetVersion: string;
  created: Array<{ taskId: string; taskType: string }>;
  skipped: Array<{ taskType: string; reason: "existing_task" }>;
}

/**
 * Apply a preset to a scope. Existing tasks of the same registered type are
 * skipped (never overwritten). Tasks are created paused; the compat delivery
 * preferences are written so the current scheduler honors the preset today.
 */
export async function applyPreset(scope: AutomationScope, presetId: string): Promise<PresetApplyResult> {
  const preset = getPreset(presetId);
  if (preset.kind !== "usage-mode") throw new Error(`PRESET_NOT_USAGE_MODE: ${presetId} (kind=${preset.kind})`);
  const created: PresetApplyResult["created"] = [];
  const skipped: PresetApplyResult["skipped"] = [];
  for (const template of preset.taskTemplates ?? []) {
    const definition = getScheduledTaskType(template.taskType);
    const existing = sqlite.prepare(
      "SELECT task_id AS taskId FROM automation_tasks WHERE user_id=? AND project_id=? AND instance_id=? AND task_type=? LIMIT 1",
    ).get(scope.userId, scope.projectId, scope.instanceId, template.taskType) as { taskId: string } | undefined;
    if (existing) {
      skipped.push({ taskType: template.taskType, reason: "existing_task" });
      continue;
    }
    const task = await createAutomationTask({
      ...scope,
      taskId: `preset_${preset.id}_${template.taskType}`,
      name: template.name,
      description: `${preset.name} · ${definition.description}`,
      taskType: template.taskType,
      schedule: template.schedule,
      instruction: definition.defaultInstruction,
      output: { mode: "none" },
      // market-watch pushes conditionally (NO_PUSH semantics); reviews publish
      // through reviews.save, so their task-level delivery stays "none".
      delivery: template.taskType === "scheduled-market-watch" ? { mode: "wechat_on_condition", conditionVersion: 1 } : { mode: "none" },
    });
    await activateAutomationTask({ ...scope, taskId: task.taskId });
    created.push({ taskId: task.taskId, taskType: template.taskType });
  }
  await writePresetCompatPreferences(scope, preset);
  return { presetId: preset.id, presetVersion: preset.version, created, skipped };
}

/**
 * Migration-window compatibility: mirror the preset's scheduling semantics
 * into the runtime preferences the current scheduler reads. Removed when the
 * task-driven executor (design doc P2/P3) becomes authoritative.
 */
async function writePresetCompatPreferences(scope: AutomationScope, preset: PresetDefinition): Promise<void> {
  const projectId = scope.projectId || DEFAULT_PROJECT_ID;
  const store = new MastraUserPreferenceStore(scope.userId, scope.instanceId, projectId);
  const current = (await store.readSchedules()) ?? {};
  const next: Record<string, unknown> = { ...current, timezone: (current as { timezone?: string }).timezone ?? BEIJING };
  for (const template of preset.taskTemplates ?? []) {
    if (template.taskType === "scheduled-daily-review") {
      next.daily_review = { enabled: true, auto_run: true, default_time: template.schedule.time, trading_days_only: true };
    } else if (template.taskType === "scheduled-weekly-review") {
      next.weekly_review = { enabled: true, auto_run: true, default_time: `Saturday ${template.schedule.time}` };
    } else if (template.taskType === "scheduled-monthly-review") {
      next.monthly_review = { enabled: true, auto_run: true, default_time: `day_${template.schedule.monthlyDay ?? 1} ${template.schedule.time}`, review_previous_month: true };
    } else if (template.taskType === "scheduled-market-watch") {
      next.market_watch = {
        enabled: true,
        auto_run: true,
        default_windows: template.schedule.windows ?? [template.schedule.time],
        ...(preset.deliveryPolicy?.onlyPushOnException === false ? {} : { push_mode: "exception_only" }),
      };
    }
  }
  await store.writeSchedules(next as never);
  // Onboarding-completion semantic (G18): applying a usage mode makes the
  // scope schedulable until P4b retires the activation gate.
  const existing = sqlite.prepare("SELECT preferences_json AS value FROM mastra_runtime_preferences WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(scope.userId, projectId, scope.instanceId) as { value?: string } | undefined;
  const preferences = existing ? JSON.parse(existing.value || "{}") : {};
  preferences.schedulerActivation = "enabled";
  if (existing) {
    sqlite.prepare("UPDATE mastra_runtime_preferences SET preferences_json=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
      .run(JSON.stringify(preferences), new Date().toISOString(), scope.userId, projectId, scope.instanceId);
  } else {
    const now = new Date().toISOString();
    sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(scope.userId, projectId, scope.instanceId, JSON.stringify(preferences), "{}", now, "service-owned", now, now);
  }
}
