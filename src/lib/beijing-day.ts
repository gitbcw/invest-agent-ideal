/** 北京日历日统一口径：事件时间戳以 UTC ISO 落库，按天统计/「今天」判断一律归北京日历日。 */

import { beijingDateKey } from "./market-calendar.js";

/**
 * SQL：把 created_at（UTC ISO 串）归到北京日历日的表达式。
 * SQLite 无时区库，固定 +8 小时；GROUP BY / 区间过滤都应使用它而不是 substr(created_at,1,10)。
 */
export const CREATED_AT_BEIJING_DAY_SQL = "substr(datetime(substr(created_at, 1, 19), '+8 hours'), 1, 10)";

/** 把 dateKey（YYYY-MM-DD）或 ISO 时间戳归到北京日历日；无法解析返回 null。 */
export function beijingDayOf(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : beijingDateKey(date);
}
