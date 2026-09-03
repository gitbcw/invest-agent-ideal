import { sqlite } from "../db/index.js";

/**
 * T-459 TRACE 载荷的 90 天滚动清理。只删 automation_tool_payloads（观测
 * 数据），不触碰 run/trace 主体记录。owner 2026-09-03 契约裁决的保留窗口。
 */
export const TRACE_PAYLOAD_RETENTION_DAYS_DEFAULT = 90;

export function resolveTracePayloadRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.TRACE_PAYLOAD_RETENTION_DAYS || "", 10);
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 3650) : TRACE_PAYLOAD_RETENTION_DAYS_DEFAULT;
}

export function purgeExpiredAutomationToolPayloads(input: { now?: Date; limit?: number } = {}): {
  retentionDays: number;
  cutoff: string;
  deleted: number;
} {
  const now = input.now ?? new Date();
  const retentionDays = resolveTracePayloadRetentionDays();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), 50_000);
  const info = sqlite
    .prepare("DELETE FROM automation_tool_payloads WHERE id IN (SELECT id FROM automation_tool_payloads WHERE created_at < ? LIMIT ?)")
    .run(cutoff, limit);
  return { retentionDays, cutoff, deleted: info.changes };
}
