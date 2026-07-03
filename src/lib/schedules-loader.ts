/**
 * 读取用户 workspace/config/schedules.yaml,提供"当前分钟是否命中"判断。
 * schedules.yaml 模板见 templates/workspace/config/schedules.yaml。
 *
 * 时间格式:
 *   daily:   "HH:MM"                            例如 "19:00"
 *   weekly:  "Saturday HH:MM" 或 "<dow> HH:MM"  例如 "Saturday 09:00"
 *   monthly: "day_<N> HH:MM"                     例如 "day_1 09:00" (每月 N 号)
 *
 * 命中判断使用北京时间 (Asia/Shanghai),与 templates 中默认 timezone 一致。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { resolveWorkspacePath } from "./workspace.js";
import { logger } from "./logger.js";
import { beijingDateKey, beijingNow, isAshareTradingDay } from "./market-calendar.js";

export { beijingDateKey, beijingNow };

export interface ScheduleEntry {
  enabled: boolean;
  auto_run?: boolean;
  default_time?: string;
  trading_days_only?: boolean;
}

export interface SchedulesYaml {
  timezone?: string;
  run_policy?: {
    automatic_by_default?: boolean;
    manual_trigger_allowed?: boolean;
    skip_automatic_if_manual_report_exists?: boolean;
    refresh_requires_user_confirmation?: boolean;
  };
  daily_review?: ScheduleEntry;
  weekly_review?: ScheduleEntry;
  monthly_review?: ScheduleEntry;
  company_financial_analysis?: ScheduleEntry & { trigger?: string };
  market_watch?: ScheduleEntry & {
    default_windows?: string[];
    custom_frequency?: number | null;
    only_push_on_exception?: boolean;
    push_mode?: string;
  };
}

const DOW_TOKENS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DOW_ABBR: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function emptySchedules(): SchedulesYaml {
  return {};
}

/** 读取 workspace 的 schedules.yaml;workspace 不存在或文件缺失则返回空对象。 */
export function readSchedules(userId: string): SchedulesYaml {
  try {
    const wsRoot = resolveWorkspacePath(userId);
    if (!existsSync(join(wsRoot, "AGENTS.md"))) return emptySchedules();
    const file = join(wsRoot, "config", "schedules.yaml");
    if (!existsSync(file)) return emptySchedules();
    const doc = parse(readFileSync(file, "utf-8")) ?? {};
    return doc as SchedulesYaml;
  } catch (error) {
    logger.warn(`schedules.read failed user=${userId}: ${(error as Error).message}`);
    return emptySchedules();
  }
}

interface BjClock {
  hour: number;
  minute: number;
  day: number; // 0..6, 0=Sunday
  dayOfMonth: number; // 1..31
}

function bjClock(now = new Date()): BjClock {
  const bj = beijingNow(now);
  return { hour: bj.getHours(), minute: bj.getMinutes(), day: bj.getDay(), dayOfMonth: bj.getDate() };
}

export function isBeijingTradingDay(now = new Date()): boolean {
  return isAshareTradingDay(now);
}

function parseTimePart(token: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function parseDow(token: string): number | null {
  const lower = token.toLowerCase();
  if (DOW_TOKENS[lower] !== undefined) return DOW_TOKENS[lower];
  if (DOW_ABBR[lower] !== undefined) return DOW_ABBR[lower];
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) return numeric;
  return null;
}

function parseDayOfMonth(token: string): number | null {
  const m = /^day_(\d{1,2})$/i.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  if (day < 1 || day > 31) return null;
  return day;
}

/** 判断某 schedule 条目是否在当前 bj 分钟命中。default_time 缺失则返回 false。 */
export function entryHitsNow(entry: ScheduleEntry | undefined, now = new Date()): boolean {
  if (!entry || entry.enabled === false || entry.auto_run === false) return false;
  if (entry.trading_days_only === true && !isBeijingTradingDay(now)) return false;
  const time = entry.default_time?.trim();
  if (!time) return false;
  const parts = time.split(/\s+/);
  const clock = bjClock(now);
  if (parts.length === 1) {
    const t = parseTimePart(parts[0]);
    if (!t) return false;
    return t.hour === clock.hour && t.minute === clock.minute;
  }
  if (parts.length === 2) {
    const head = parts[0].toLowerCase();
    const t = parseTimePart(parts[1]);
    if (!t) return false;
    if (head.startsWith("day_")) {
      const dom = parseDayOfMonth(parts[0]);
      if (dom == null) return false;
      return dom === clock.dayOfMonth && t.hour === clock.hour && t.minute === clock.minute;
    }
    const dow = parseDow(parts[0]);
    if (dow == null) return false;
    return dow === clock.day && t.hour === clock.hour && t.minute === clock.minute;
  }
  return false;
}
