/**
 * A-share market calendar helpers.
 *
 * Holiday data is based on SSE's 2026 annual market closure notice.
 * Temporary suspensions are intentionally out of scope.
 */

const ASHARE_FULL_DAY_CLOSURES = new Set([
  // 2026 New Year
  "2026-01-01",
  "2026-01-02",
  "2026-01-03",
  // 2026 Spring Festival
  "2026-02-15",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-02-19",
  "2026-02-20",
  "2026-02-21",
  "2026-02-22",
  "2026-02-23",
  // 2026 Qingming Festival
  "2026-04-04",
  "2026-04-05",
  "2026-04-06",
  // 2026 Labor Day
  "2026-05-01",
  "2026-05-02",
  "2026-05-03",
  "2026-05-04",
  "2026-05-05",
  // 2026 Dragon Boat Festival
  "2026-06-19",
  "2026-06-20",
  "2026-06-21",
  // 2026 Mid-Autumn Festival
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  // 2026 National Day
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
]);

export function beijingNow(date = new Date()): Date {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

export function beijingDateKey(date = new Date()): string {
  const bj = beijingNow(date);
  return `${bj.getFullYear()}-${String(bj.getMonth() + 1).padStart(2, "0")}-${String(bj.getDate()).padStart(2, "0")}`;
}

export function resolveCalendarQueryInstant(dateKey?: string, now = new Date()): Date {
  if (!dateKey || dateKey === beijingDateKey(now)) {
    return new Date(now.getTime());
  }
  return new Date(`${dateKey}T00:00:00+08:00`);
}

export function isAshareTradingDay(date = new Date()): boolean {
  const bj = beijingNow(date);
  const day = bj.getDay();
  if (day === 0 || day === 6) return false;
  return !ASHARE_FULL_DAY_CLOSURES.has(beijingDateKey(date));
}

export function isAshareTradingTime(date = new Date()): boolean {
  if (!isAshareTradingDay(date)) return false;
  const bj = beijingNow(date);
  const timeNum = bj.getHours() * 100 + bj.getMinutes();
  return (timeNum >= 930 && timeNum <= 1130) || (timeNum >= 1300 && timeNum <= 1500);
}

export type AshareMarketSession =
  | "closed"
  | "pre_market"
  | "morning"
  | "lunch_break"
  | "afternoon"
  | "post_market";

export interface AshareCalendarReport {
  market: "CN_A_SHARE";
  dateKey: string;
  timezone: "Asia/Shanghai";
  isTradingDay: boolean;
  isTradingTime: boolean;
  session: AshareMarketSession;
  previousTradingDay: string | null;
  nextTradingDay: string | null;
  source: {
    provider: "service_calendar_cn_ashare";
    confidence: "medium";
    warnings: string[];
  };
}

export function ashareMarketSession(date = new Date()): AshareMarketSession {
  const bj = beijingNow(date);
  const timeNum = bj.getHours() * 100 + bj.getMinutes();
  if (!isAshareTradingDay(date)) return "closed";
  if (timeNum < 930) return "pre_market";
  if (timeNum <= 1130) return "morning";
  if (timeNum < 1300) return "lunch_break";
  if (timeNum <= 1500) return "afternoon";
  return "post_market";
}

export function previousAshareTradingDay(date = new Date()): string | null {
  return findAshareTradingDay(date, -1);
}

export function nextAshareTradingDay(date = new Date()): string | null {
  return findAshareTradingDay(date, 1);
}

export function ashareCalendarReport(date = new Date()): AshareCalendarReport {
  const dateKey = beijingDateKey(date);
  const warnings: string[] = [];
  if (!dateKey.startsWith("2026-")) {
    warnings.push("calendar_holiday_table_only_verified_for_2026");
  }
  return {
    market: "CN_A_SHARE",
    dateKey,
    timezone: "Asia/Shanghai",
    isTradingDay: isAshareTradingDay(date),
    isTradingTime: isAshareTradingTime(date),
    session: ashareMarketSession(date),
    previousTradingDay: previousAshareTradingDay(date),
    nextTradingDay: nextAshareTradingDay(date),
    source: {
      provider: "service_calendar_cn_ashare",
      confidence: "medium",
      warnings,
    },
  };
}

function findAshareTradingDay(date: Date, direction: -1 | 1): string | null {
  const bj = beijingNow(date);
  for (let i = 1; i <= 20; i += 1) {
    const candidate = new Date(bj.getTime());
    candidate.setDate(bj.getDate() + i * direction);
    if (isAshareTradingDay(candidate)) return beijingDateKey(candidate);
  }
  return null;
}
