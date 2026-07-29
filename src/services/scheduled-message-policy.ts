import { beijingDateKey, nextAshareTradingDay } from "../lib/market-calendar.js";

export type ScheduledMessageKind = "daily_review" | "weekly_review" | "monthly_review" | "market_watch" | "rule_alert";

export interface ScheduledMessagePolicy {
  id: string;
  generationMaxAttempts: number;
  deliveryMaxAttempts: number;
  expiresAt: (scheduledFor: Date) => string;
}

const HOUR = 60 * 60 * 1000;

const POLICIES: Record<ScheduledMessageKind, ScheduledMessagePolicy> = {
  daily_review: {
    id: "scheduled-daily-review-v1",
    generationMaxAttempts: 3,
    deliveryMaxAttempts: 5,
    expiresAt: (scheduledFor) => atBeijingTime(nextTradingDate(scheduledFor), 8, 30),
  },
  weekly_review: {
    id: "scheduled-weekly-review-v1",
    generationMaxAttempts: 3,
    deliveryMaxAttempts: 5,
    expiresAt: (scheduledFor) => {
      const next = Date.parse(atBeijingTime(nextTradingDate(scheduledFor), 9, 0));
      return new Date(Math.min(next, scheduledFor.getTime() + 96 * HOUR)).toISOString();
    },
  },
  monthly_review: {
    id: "scheduled-monthly-review-v1",
    generationMaxAttempts: 3,
    deliveryMaxAttempts: 5,
    expiresAt: (scheduledFor) => new Date(scheduledFor.getTime() + 72 * HOUR).toISOString(),
  },
  market_watch: {
    id: "scheduled-market-watch-v1",
    generationMaxAttempts: 1,
    deliveryMaxAttempts: 5,
    expiresAt: (scheduledFor) => new Date(scheduledFor.getTime() + 90 * 60 * 1000).toISOString(),
  },
  rule_alert: {
    id: "scheduled-rule-alert-v1",
    generationMaxAttempts: 1,
    deliveryMaxAttempts: 5,
    expiresAt: (scheduledFor) => new Date(scheduledFor.getTime() + 30 * 60 * 1000).toISOString(),
  },
};

export function getScheduledMessagePolicy(kind: ScheduledMessageKind): ScheduledMessagePolicy {
  return POLICIES[kind];
}

export function scheduledMessageIdempotencyKey(input: {
  instanceId: string;
  userId: string;
  kind: ScheduledMessageKind;
  businessPeriod: string;
}): string {
  return `scheduled:${input.instanceId}:${input.userId}:${input.kind}:${input.businessPeriod}`;
}

export function resolveScheduledMessageExpiry(kind: ScheduledMessageKind, scheduledFor: Date): {
  expiresAt: string;
  retryPolicy: string;
  maxAttempts: number;
} {
  const policy = getScheduledMessagePolicy(kind);
  return { expiresAt: policy.expiresAt(scheduledFor), retryPolicy: policy.id, maxAttempts: policy.deliveryMaxAttempts };
}

function nextTradingDate(scheduledFor: Date): string {
  return nextAshareTradingDay(scheduledFor) ?? addCalendarDays(beijingDateKey(scheduledFor), 1);
}

function atBeijingTime(dateKey: string, hour: number, minute: number): string {
  return new Date(`${dateKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`).toISOString();
}

function addCalendarDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingDateKey(date);
}
