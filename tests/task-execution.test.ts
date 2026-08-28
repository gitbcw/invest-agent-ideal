import assert from "node:assert/strict";
import test from "node:test";
import { classifyTaskError, executeWithRetryPolicy, isPastDeadline, resolveTaskTiming } from "../src/services/task-execution.js";

test("task timing keeps response and execution deadlines independent", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const timing = resolveTaskTiming({ now, responseBudgetMs: 5_000, executionBudgetMs: 120_000 });
  assert.equal(timing.acceptedAt, now.toISOString());
  assert.equal(timing.responseDeadlineAt, "2026-08-07T00:00:05.000Z");
  assert.equal(timing.executionDeadlineAt, "2026-08-07T00:02:00.000Z");
  assert.equal(isPastDeadline(timing.responseDeadlineAt, new Date("2026-08-07T00:00:06.000Z")), true);
  assert.equal(isPastDeadline(timing.executionDeadlineAt, new Date("2026-08-07T00:00:06.000Z")), false);
});

test("task timing defaults to a twenty-minute execution budget", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const timing = resolveTaskTiming({ now });
  assert.equal(timing.responseDeadlineAt, "2026-08-07T00:00:15.000Z");
  assert.equal(timing.executionDeadlineAt, "2026-08-07T00:20:00.000Z");
});

test("task errors expose stable retry and customer semantics", () => {
  const timeout = classifyTaskError(new Error("ACP request timed out"));
  assert.deepEqual(
    { category: timeout.category, code: timeout.code, retryable: timeout.retryable },
    { category: "timeout", code: "TASK_TIMEOUT", retryable: true },
  );

  const dependency = classifyTaskError(new Error("AI provider credential not configured"));
  assert.equal(dependency.category, "dependency_unavailable");
  assert.equal(dependency.retryable, false);

  const scope = classifyTaskError(new Error("ASSET_SCOPE_MISMATCH"));
  assert.equal(scope.category, "scope_or_permission");
  assert.equal(scope.retryable, false);

  const capacity = classifyTaskError(new Error("Selected model is at capacity. Some(ServerOverloaded)"));
  assert.deepEqual(
    { category: capacity.category, code: capacity.code, retryable: capacity.retryable },
    { category: "transient", code: "TASK_MODEL_CAPACITY", retryable: true },
  );
});

test("execution policy waits for the result and stops at the execution deadline", async () => {
  let attempts = 0;
  const result = await executeWithRetryPolicy(
    async () => {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return "done";
    },
    { executionBudgetMs: 100 },
  );
  assert.equal(result, "done");
  assert.equal(attempts, 1);

  await assert.rejects(
    executeWithRetryPolicy(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "late";
      },
      { executionBudgetMs: 10 },
    ),
    /TASK_EXECUTION_TIMEOUT/,
  );
});

test("retry policy backs off before retrying transient results (T-395 busy must not retry instantly)", async () => {
  const sleeps: number[] = [];
  const sleepImpl = async (ms: number) => { sleeps.push(ms); };
  let attempts = 0;
  const result = await executeWithRetryPolicy(
    async () => {
      attempts += 1;
      if (attempts === 1) return { data: { executionStatus: "failed", executionRetryable: true } };
      return { data: { ok: true } };
    },
    {
      executionBudgetMs: 60_000,
      isRetryableResult: (candidate: { data?: { executionStatus?: string; executionRetryable?: boolean } }) =>
        candidate.data?.executionStatus === "failed" && candidate.data?.executionRetryable === true,
      retryDelayForResult: () => 20_000,
      sleepImpl,
    },
  );
  assert.deepEqual(result, { data: { ok: true } });
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [20_000], "retryable transient result must wait out the backoff before retrying");
});

test("retry policy backoff that would exceed the budget fails fast instead of running once more", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  await assert.rejects(
    executeWithRetryPolicy(
      async () => {
        attempts += 1;
        return { data: { executionStatus: "failed", executionRetryable: true } };
      },
      {
        executionBudgetMs: 5,
        isRetryableResult: () => true,
        retryDelayForResult: () => 20_000,
        // 真睡：退避（被裁剪到剩余预算）耗尽 deadline 后，第二次 operation 直接超时。
        sleepImpl: async (ms: number) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, 6)); },
      },
    ),
    /TASK_EXECUTION_TIMEOUT/,
  );
  assert.equal(attempts, 1, "no extra operation run when the backoff alone exhausts the budget");
  assert.equal(sleeps.length, 1, "backoff runs once and is capped to the remaining budget");
  assert.ok(sleeps[0] <= 5, "backoff must be capped to the remaining budget, not the full delay");
});
