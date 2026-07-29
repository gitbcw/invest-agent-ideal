import assert from "node:assert/strict";
import test from "node:test";
import { resolveScheduledMessageExpiry, scheduledMessageIdempotencyKey } from "../src/services/scheduled-message-policy.js";

test("scheduled review policies freeze distinct Beijing expiry windows", () => {
  const fridayEvening = new Date("2026-07-24T11:00:00.000Z");
  const daily = resolveScheduledMessageExpiry("daily_review", fridayEvening);
  const weekly = resolveScheduledMessageExpiry("weekly_review", fridayEvening);
  const monthly = resolveScheduledMessageExpiry("monthly_review", fridayEvening);

  assert.equal(daily.expiresAt, "2026-07-27T00:30:00.000Z");
  assert.equal(weekly.expiresAt, "2026-07-27T01:00:00.000Z");
  assert.equal(monthly.expiresAt, "2026-07-27T11:00:00.000Z");
  assert.equal(daily.maxAttempts, 5);
  assert.match(daily.retryPolicy, /^scheduled-daily-review-/);
});

test("scheduled message idempotency is stable across retries and scoped to the instance", () => {
  const first = scheduledMessageIdempotencyKey({
    instanceId: "invest-agent-112",
    userId: "112",
    kind: "daily_review",
    businessPeriod: "2026-07-29",
  });
  const retry = scheduledMessageIdempotencyKey({
    instanceId: "invest-agent-112",
    userId: "112",
    kind: "daily_review",
    businessPeriod: "2026-07-29",
  });
  const otherInstance = scheduledMessageIdempotencyKey({
    instanceId: "invest-agent-113",
    userId: "112",
    kind: "daily_review",
    businessPeriod: "2026-07-29",
  });

  assert.equal(first, retry);
  assert.notEqual(first, otherInstance);
});
