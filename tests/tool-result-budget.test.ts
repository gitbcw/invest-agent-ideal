import assert from "node:assert/strict";
import test from "node:test";

import {
  applyToolResultBudget,
  createToolResultBudgetProcessor,
  DEFAULT_TOOL_RESULT_BUDGET_CHARS,
  toolResultBudgetChars,
} from "../src/mastra/tool-result-budget.js";

function toolMessage(toolCallId: string, output: unknown) {
  return { role: "tool", content: [{ type: "tool-result", toolCallId, output }] };
}

test("budget switch: default 20k, env overrides, 0 disables", () => {
  assert.equal(toolResultBudgetChars({}), DEFAULT_TOOL_RESULT_BUDGET_CHARS);
  assert.equal(toolResultBudgetChars({ TOOL_RESULT_BUDGET_CHARS: "5000" }), 5000);
  assert.equal(toolResultBudgetChars({ TOOL_RESULT_BUDGET_CHARS: "0" }), 0);
  assert.equal(toolResultBudgetChars({ TOOL_RESULT_BUDGET_CHARS: "not-a-number" }), DEFAULT_TOOL_RESULT_BUDGET_CHARS);
});

test("applyToolResultBudget truncates oversized tool results and keeps toolCallId", () => {
  const big = "数".repeat(30_000);
  const prompt = {
    messages: [
      { role: "user", content: [{ type: "text", text: "研究" }] },
      toolMessage("t1", { type: "text", text: big }),
    ],
  };
  const result = applyToolResultBudget(prompt, 20_000);
  assert.notEqual(result, prompt, "oversized prompt must be rewritten");
  const part = (result.messages[1].content as Array<{ type: string; toolCallId?: string; output: { text: string } }>)[0];
  assert.equal(part.toolCallId, "t1");
  assert.ok(part.output.text.length < 21_500, `truncated length ${part.output.text.length}`);
  assert.ok(part.output.text.includes("截断"), "truncation notice must be appended");
  assert.ok(part.output.text.startsWith("数".repeat(20_000).slice(0, 100)), "head of result is preserved");
});

test("applyToolResultBudget passes through prompt unchanged when within budget or disabled", () => {
  const prompt = { messages: [toolMessage("t1", { type: "text", text: "短结果" })] };
  assert.equal(applyToolResultBudget(prompt, 20_000), prompt);
  const bigPrompt = { messages: [toolMessage("t1", { type: "text", text: "x".repeat(50_000) })] };
  assert.equal(applyToolResultBudget(bigPrompt, 0), bigPrompt, "0 budget disables truncation");
});

test("applyToolResultBudget serializes json-value outputs for budgeting", () => {
  const rows = Array.from({ length: 5_000 }, (_, i) => ({ code: `60000${i}`, name: `股票${i}`, 涨跌幅: i % 10 }));
  const prompt = { messages: [toolMessage("t-json", { type: "json", value: { rows } })] };
  const result = applyToolResultBudget(prompt, 20_000);
  const part = (result.messages[0].content as Array<{ output: { text: string } }>)[0];
  assert.ok(part.output.text.includes("截断"), "json output gets truncated as text");
});

test("processor returns rewritten prompt only when changed", () => {
  const processor = createToolResultBudgetProcessor({ TOOL_RESULT_BUDGET_CHARS: "100" });
  assert.equal(processor.id, "tool-result-budget");
  const small = { messages: [toolMessage("t1", { type: "text", text: "ok" })] };
  assert.equal(processor.processLLMRequest?.({ prompt: small } as never), undefined);
  const huge = { messages: [toolMessage("t2", { type: "text", text: "y".repeat(500) })] };
  const outcome = processor.processLLMRequest?.({ prompt: huge } as never) as { prompt: typeof huge };
  assert.ok(outcome?.prompt, "oversized prompt is returned rewritten");
  assert.equal(
    (outcome.prompt.messages[0].content as Array<{ toolCallId: string }>)[0].toolCallId,
    "t2",
  );
});
