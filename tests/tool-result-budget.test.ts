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

test("real SDK array prompt blocks oversized MCP result without mutating stored history", () => {
  const value = { content: [{ type: "text", text: "x".repeat(134846) }] };
  const prompt = [toolMessage("mcp-real", { type: "json", value })];
  const processor = createToolResultBudgetProcessor({});
  const result = processor.processLLMRequest({ prompt }) as { prompt: typeof prompt };
  assert.ok(Array.isArray(result.prompt));
  const notice = JSON.parse(result.prompt[0].content[0].output as string);
  assert.equal(notice.status, "requires_smaller_query");
  assert.equal(notice.rows_visible_to_model, 0);
  assert.equal(value.content[0].text.length, 134846);
  assert.equal(processor.processLLMRequest({ prompt: result.prompt }), undefined);
  assert.equal(createToolResultBudgetProcessor({ TOOL_RESULT_BUDGET_CHARS: "0" }).processLLMRequest({ prompt }), undefined);
});

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
  const part = (result.messages[1].content as Array<{ type: string; toolCallId?: string; output: unknown }>)[0];
  assert.equal(part.toolCallId, "t1");
  // 2026-10-11 契约：V2 prompt 的 tool-result output 必须是字符串（对象形状会被
  // openai 兼容网关拒绝：content should be a string or a list）
  assert.equal(typeof part.output, "string", "output must be a plain string");
  const out = part.output as string;
  assert.ok(out.length < 21_500, `truncated length ${out.length}`);
  assert.ok(out.includes("截断"), "truncation notice must be appended");
  assert.equal(JSON.parse(out).rows_visible_to_model, 0);
  assert.ok(!out.includes("数".repeat(100)), "partial rows must not masquerade as usable data");
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
  const part = (result.messages[0].content as Array<{ output: unknown }>)[0];
  assert.equal(typeof part.output, "string");
  assert.ok((part.output as string).includes("截断"), "json output gets truncated as text");
});

test("structured row results retain coverage metadata instead of only a misleading head slice", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ date: `2026-09-${String((i % 30) + 1).padStart(2, "0")}`, symbol: `S${i}`, volume: i }));
  const prompt = { messages: [toolMessage("rows", { type: "text", text: JSON.stringify({ columns: ["date", "symbol", "volume"], rows, meta: { source: "mcp" } }) })] };
  const result = applyToolResultBudget(prompt, 2000);
  const output = (result.messages[0].content as Array<{ output: string }>)[0].output;
  assert.match(output, /data_truncated_for_context/);
  assert.match(output, /returned_rows/);
  assert.match(output, /更小的 limit/);
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
