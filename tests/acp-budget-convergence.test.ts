import assert from "node:assert/strict";
import test from "node:test";
import {
  AcpBudgetExhaustedError,
  AcpBudgetRun,
  TOOL_BUDGET_EXHAUSTED_CODE,
  detectAcpBudgetExhaustion,
  probeAcpCapabilities,
} from "../src/acp/budget-convergence.js";
import { ResponseCollector } from "../src/acp/stdio-agent.js";
import { validatePortalRuntimeTimeouts } from "../src/acp/agent.js";

test("ACP capability probe records conservative terminal fallback", () => {
  const probe = probeAcpCapabilities(
    {
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } },
    },
    { cancel() {}, newSession() {} },
  );

  assert.deepEqual(
    {
      protocolVersion: probe.protocolVersion,
      cancel: probe.cancel,
      conversationContextReuse: probe.conversationContextReuse,
      sameTurnToolRevocation: probe.sameTurnToolRevocation,
      supplementalSynthesis: probe.supplementalSynthesis,
      synthesisStrategy: probe.synthesisStrategy,
    },
    {
      protocolVersion: 1,
      cancel: "supported",
      conversationContextReuse: "supported",
      sameTurnToolRevocation: "unsupported",
      supplementalSynthesis: "unsupported",
      synthesisStrategy: "terminal_only",
    },
  );
  assert.ok(probe.evidence.some((item) => item.includes("no standard same-turn MCP revocation")));
});

test("explicit ACP metadata is required before selecting a synthesis strategy", () => {
  const sameTurn = probeAcpCapabilities({
    protocolVersion: 1,
    agentCapabilities: {
      _meta: { "invest-agent": { budgetControl: { sameTurnToolRevocation: true } } },
    },
  }, { cancel() {}, newSession() {} });
  assert.equal(sameTurn.sameTurnToolRevocation, "supported");
  assert.equal(sameTurn.synthesisStrategy, "same_turn");

  const supplemental = probeAcpCapabilities({
    protocolVersion: 1,
    agentCapabilities: {
      _meta: { "invest-agent": { budgetControl: { supplementalSynthesis: true } } },
    },
  }, { cancel() {}, newSession() {}, unstable_resumeSession() {} });
  assert.equal(supplemental.supplementalSynthesis, "supported");
  assert.equal(supplemental.synthesisStrategy, "supplemental_session");
});

test("budget run converges from rejection to synthesis-only and terminal state deterministically", () => {
  let now = 1_000;
  const run = new AcpBudgetRun({ now: () => now, convergenceMs: 100 });
  assert.equal(run.snapshot().state, "open");
  assert.equal(run.markBudgetExhausted("identical_calls"), true);
  assert.equal(run.markBudgetExhausted("total_calls"), false, "first exhaustion type is stable");
  assert.equal(run.enterSynthesisOnly(), true);
  run.recordToolCall();
  assert.equal(run.snapshot().toolCallsAfterExhaustion, 1);
  assert.equal(run.isConvergenceExpired(), false);
  now = 1_100;
  assert.equal(run.isConvergenceExpired(), true);
  run.terminalFail();
  assert.deepEqual(run.snapshot(), {
    state: "terminal_failed",
    startedAt: 1_000,
    exhaustedAt: 1_000,
    exhaustionType: "identical_calls",
    convergenceDeadlineAt: 1_100,
    toolCallsAfterExhaustion: 1,
  });
  const error = new AcpBudgetExhaustedError(run.snapshot());
  assert.equal(error.code, TOOL_BUDGET_EXHAUSTED_CODE);
  assert.equal(error.message, TOOL_BUDGET_EXHAUSTED_CODE);
});

test("a run that never exhausts the budget records completed terminal state", () => {
  const run = new AcpBudgetRun({ now: () => 4_000 });
  run.complete();
  assert.equal(run.snapshot().state, "completed");
  assert.equal(run.snapshot().toolCallsAfterExhaustion, 0);
});

test("Runtime requires an ACP timeout below the total Portal execution budget", () => {
  assert.doesNotThrow(() => validatePortalRuntimeTimeouts(600_000, 1_200_000));
  assert.throws(
    () => validatePortalRuntimeTimeouts(1_200_000, 1_200_000),
    /must be less than/,
  );
});

test("observer budget errors are detected without retaining request arguments", () => {
  assert.equal(
    detectAcpBudgetExhaustion({
      rawOutput: {
        isError: true,
        error: { code: -32001, message: "External MCP total external tool-call budget is exhausted" },
      },
    }),
    "total_calls",
  );
  assert.equal(
    detectAcpBudgetExhaustion({
      errorClass: "MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED",
      arguments: { symbol: "600519" },
    }),
    "identical_calls",
  );
});

test("repeated budget rejection fixture invokes the fail-closed hook once", () => {
  const observed: string[] = [];
  let toolCalls = 0;
  const run = new AcpBudgetRun({ now: () => 2_000, convergenceMs: 50 });
  const collector = new ResponseCollector({
    onToolCall: () => { toolCalls += 1; },
    onBudgetExhausted: (type) => {
      if (!run.markBudgetExhausted(type)) return;
      run.enterSynthesisOnly();
      observed.push(type);
    },
  });
  const update = (rawOutput: unknown) => collector.handleUpdate({
    sessionId: "budget-fixture",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: `call-${toolCalls + observed.length + 1}`,
      status: "failed",
      rawOutput,
    },
  } as never);

  update({ errorClass: "MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED" });
  update({ errorClass: "MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED" });
  update({ errorClass: "MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED" });

  assert.equal(toolCalls, 3, "fixture emits one call event per rejected invocation");
  assert.deepEqual(observed, ["identical_calls"]);
  assert.equal(collector.toText(), "");
});
