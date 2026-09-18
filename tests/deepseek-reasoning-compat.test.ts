import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DeepseekReasoningCompatProcessor,
  ensureDeepseekReasoningPlaceholders,
  isDeepseekModel,
} from "../src/mastra/deepseek-reasoning-compat.js";

/**
 * 回归背景：2026-09-18 生产事故（111 daily-review 19:00 失败，2026-09-15 mg 同源）。
 * DeepSeek 网关对流式请求要求：历史 assistant 消息带 tool_calls 时必须携带
 * reasoning_content 字段（空串可过），字段缺失 → 400。序列化层只在 reasoning 文本
 * 非空时输出该字段，故占位必须是非空白文本。
 */
const toolCallPart = { type: "tool-call", toolCallId: "call_00", toolName: "get_price", input: {} };

function assistantMessage(parts: unknown[]) {
  return { role: "assistant", content: parts };
}

test("isDeepseekModel matches gateway descriptor, string, object and array forms", () => {
  assert.equal(isDeepseekModel("gateway/deepseek-flash"), true);
  assert.equal(isDeepseekModel({ id: "gateway/deepseek-flash" }), true);
  assert.equal(isDeepseekModel({ modelId: "deepseek-flash", url: "https://x" }), true);
  assert.equal(isDeepseekModel([{ model: { modelId: "deepseek-flash" } }]), true);
  assert.equal(isDeepseekModel("gateway/glm-5.3-flash"), false);
  assert.equal(isDeepseekModel({ id: "gateway/qwen3.8-flash" }), false);
  assert.equal(isDeepseekModel(undefined), false);
  assert.equal(isDeepseekModel(() => "deepseek"), false);
});

test("tool-call assistant without reasoning part gains a placeholder that survives serialization", () => {
  const prompt = [
    { role: "system", content: "s" },
    { role: "user", content: "u" },
    assistantMessage([{ type: "text", text: "查询" }, toolCallPart]),
    { role: "tool", content: [{ type: "text", text: "1500" }] },
  ];
  const patched = ensureDeepseekReasoningPlaceholders(prompt);
  assert.ok(patched, "expected mutation");
  const asst = patched[2] as { content: Array<{ type: string; text?: string }> };
  const reasoning = asst.content.find((part) => part.type === "reasoning");
  assert.ok(reasoning, "placeholder reasoning part inserted");
  // 序列化条件是 reasoning.length > 0（非空即输出字段）；网关校验只查字段存在
  // （生产实验：空串/单空格/占位文本均 200）。占位符只需长度非零。
  assert.ok(typeof reasoning?.text === "string" && reasoning.text.length > 0, "placeholder text must be non-empty");
  // 非 assistant 消息与已有 parts 不被破坏。
  assert.equal(patched[0], prompt[0]);
  assert.equal(patched[1], prompt[1]);
});

test("tool-call assistant with empty-string reasoning part gets a non-empty placeholder text", () => {
  const prompt = [assistantMessage([{ type: "reasoning", text: "" }, toolCallPart])];
  const patched = ensureDeepseekReasoningPlaceholders(prompt);
  assert.ok(patched);
  const asst = patched[0] as { content: Array<{ type: string; text?: string }> };
  const reasoning = asst.content.filter((part) => part.type === "reasoning");
  assert.equal(reasoning.length, 1, "no duplicate part added");
  assert.ok((reasoning[0]?.text ?? "").length > 0, "empty reasoning text must be replaced with non-empty placeholder");
});

test("usable reasoning text and tool-call-free assistants are left untouched", () => {
  const withReasoning = [assistantMessage([{ type: "reasoning", text: "思考中" }, toolCallPart])];
  assert.equal(ensureDeepseekReasoningPlaceholders(withReasoning), undefined);

  const textOnly = [assistantMessage([{ type: "text", text: "回答" }])];
  assert.equal(ensureDeepseekReasoningPlaceholders(textOnly), undefined);

  const stringContent = [assistantMessage("纯文本回答")];
  assert.equal(ensureDeepseekReasoningPlaceholders(stringContent), undefined);

  assert.equal(ensureDeepseekReasoningPlaceholders("not-an-array"), undefined);
});

test("processor only rewrites prompts for deepseek models", () => {
  const processor = new DeepseekReasoningCompatProcessor();
  const prompt = [assistantMessage([toolCallPart])];

  const deepseekResult = processor.processLLMRequest({ prompt, model: { id: "gateway/deepseek-flash" } });
  assert.ok(deepseekResult?.prompt, "deepseek prompt rewritten");

  assert.equal(processor.processLLMRequest({ prompt, model: { id: "gateway/glm-5.3-flash" } }), undefined);
  assert.equal(processor.processLLMRequest({ prompt, model: undefined }), undefined);
});

test("original prompt objects are not mutated in place", () => {
  const original = assistantMessage([{ type: "text", text: "查询" }, toolCallPart]);
  const prompt = [original];
  const patched = ensureDeepseekReasoningPlaceholders(prompt);
  assert.ok(patched);
  assert.notEqual(patched[0], original, "assistant message replaced with a copy");
  assert.equal((original.content as unknown[]).length, 2, "original parts array untouched");
  assert.equal(prompt[0], original, "input array element identity preserved");
});
