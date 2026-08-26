import assert from "node:assert/strict";
import test from "node:test";

import { hasExecutionBudgetForFallback, resolveTurnExecutionBudget } from "../src/runtime/execution-budget.js";
import { resolveInternalAutomationBudget } from "../src/runtime/agent.js";

test("turn execution budget caps every model attempt at the task deadline", () => {
  const nowMs = 1_000_000;
  assert.deepEqual(resolveTurnExecutionBudget({
    executionDeadlineMs: nowMs + 90_000,
    configuredTimeoutMs: 30 * 60_000,
    firstTokenTimeoutMs: 45_000,
    nowMs,
  }), {
    expired: false,
    remainingMs: 90_000,
    timeoutMs: 90_000,
    firstTokenTimeoutMs: 45_000,
  });
  assert.equal(resolveTurnExecutionBudget({
    executionDeadlineMs: nowMs,
    firstTokenTimeoutMs: 45_000,
    nowMs,
  }).expired, true);
});

test("automatic fallback requires enough remaining task budget", () => {
  const nowMs = 1_000_000;
  assert.equal(hasExecutionBudgetForFallback({ executionDeadlineMs: nowMs + 90_000, minimumRemainingMs: 120_000, nowMs }), false);
  assert.equal(hasExecutionBudgetForFallback({ executionDeadlineMs: nowMs + 121_000, minimumRemainingMs: 120_000, nowMs }), true);
  assert.equal(hasExecutionBudgetForFallback({ executionDeadlineMs: Number.NaN, minimumRemainingMs: 120_000, nowMs }), true);
});

test("generic automation internal hints cap max steps and preserve a fallback reserve", () => {
  assert.deepEqual(resolveInternalAutomationBudget({
    channel: "automation",
    taskType: "automation-execution",
    maxToolCalls: 50,
    attemptTimeoutMs: 900_000,
    fallbackMinRemainingMs: 300_000,
  }), {
    enabled: true,
    maxSteps: 30,
    attemptTimeoutMs: 480_000,
    fallbackMinRemainingMs: 300_000,
  });
  assert.deepEqual(resolveInternalAutomationBudget({
    channel: "api",
    taskType: "automation-execution",
    maxToolCalls: 1,
    fallbackMinRemainingMs: 1,
  }), {
    enabled: false,
    maxSteps: 20,
    fallbackMinRemainingMs: 120_000,
  });
});
