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
