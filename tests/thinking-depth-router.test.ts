import assert from "node:assert/strict";
import test from "node:test";

import { classifyThinkingDepth, THINKING_DEPTH_ROUTING_RULES } from "../src/services/thinking-depth-router.js";

const env = { MASTRA_GATEWAY_BASE_URL: "https://gateway.invalid/v1", MASTRA_GATEWAY_API_KEY: "test-key" };

function okFetch(content: string) {
  return (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;
}

test("thinking depth router maps classifier JSON to decisions", async () => {
  const high = await classifyThinkingDepth({ text: "分析万孚生物半年报现金流与存货", env, fetchImpl: okFetch('{"depth":"high","reason":"财报深度分析"}') });
  assert.deepEqual(high, { depth: "high", reason: "财报深度分析" });
  const low = await classifyThinkingDepth({ text: "早报", env, fetchImpl: okFetch('{"depth":"low","reason":"简报"}') });
  assert.equal(low.depth, "low");
  // 裁判输出带前言时仍能抽出 JSON（思考模型常见形态）。
  const preamble = await classifyThinkingDepth({ text: "继续完善策略", env, fetchImpl: okFetch('好的，这是判断：{"depth":"high","reason":"策略迭代"}') });
  assert.equal(preamble.depth, "high");
});

test("thinking depth router fails open to low on every failure mode", async () => {
  const cases: Array<{ name: string; fetchImpl: typeof fetch }> = [
    { name: "http-500", fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch },
    { name: "garbage", fetchImpl: okFetch("我不会输出 JSON") },
    { name: "bad-depth", fetchImpl: okFetch('{"depth":"max"}') },
    { name: "abort", fetchImpl: (async () => { throw new Error("This operation was aborted"); }) as unknown as typeof fetch },
  ];
  for (const c of cases) {
    const decision = await classifyThinkingDepth({ text: "任意消息", env, fetchImpl: c.fetchImpl });
    assert.equal(decision.depth, "low", c.name);
  }
  // 网关未配置/空文本：直接跳过（low）。
  assert.equal((await classifyThinkingDepth({ text: "hi", env: {}, fetchImpl: okFetch('{"depth":"high"}') })).depth, "low");
  assert.equal((await classifyThinkingDepth({ text: "  ", env, fetchImpl: okFetch('{"depth":"high"}') })).depth, "low");
});

test("routing ruleset stays versioned and model-readable (owner 2026-08-27)", async () => {
  assert.ok(THINKING_DEPTH_ROUTING_RULES.includes("拿不准时选 low"), "fail-toward-low must stay explicit");
  assert.ok(THINKING_DEPTH_ROUTING_RULES.includes("high"), "high tier must be defined");
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/runtime/agent.ts", import.meta.url), "utf8");
  assert.ok(source.includes("classifyThinkingDepth"), "agent must consult the router for interactive glm turns");
  assert.ok(source.includes('selectedModel === "glm-5.3-flash"'), "router only engages on the glm base model");
});

test("glm-5.3-flash-high alias is priced as the base model", async () => {
  const { computeModelCost } = await import("../src/services/model-pricing.js");
  const cost = computeModelCost("glm-5.3-flash-high", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost.source, "priced");
  assert.equal(cost.amount, 3.6);
});
