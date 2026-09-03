/** Portal 用量查询的日期边界：created_at 存 UTC，页面日期是北京日历日。 */

import { beijingDateKey } from "../lib/market-calendar.js";

const USAGE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function shanghaiDayBoundary(day: string, endOfDay: boolean): string | null {
  const date = new Date(`${day}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * 解析 Portal 用量查询区间。裸 YYYY-MM-DD 按北京日历日解释，换算为对应 UTC 瞬间；
 * 完整时间戳原样透传；缺省回退为北京「今天」与近 30 天。
 */
export function usageRange(message: { payload?: unknown }): { from: string; to: string } {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const fromRaw = typeof payload.from === "string" ? payload.from : "";
  const toRaw = typeof payload.to === "string" ? payload.to : "";
  const now = new Date();
  const from = USAGE_DAY_RE.test(fromRaw) ? shanghaiDayBoundary(fromRaw, false) : fromRaw || null;
  const to = USAGE_DAY_RE.test(toRaw) ? shanghaiDayBoundary(toRaw, true) : toRaw || null;
  return {
    from: from ?? shanghaiDayBoundary(beijingDateKey(new Date(now.getTime() - 29 * 24 * 3600 * 1000)), false)!,
    to: to ?? shanghaiDayBoundary(beijingDateKey(now), true)!,
  };
}
