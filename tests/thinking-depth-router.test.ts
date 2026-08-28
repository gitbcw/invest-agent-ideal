import assert from "node:assert/strict";
import test from "node:test";

import { classifyThinkingDepth, THINKING_DEPTH_AUTOMATION_RULES, THINKING_DEPTH_ROUTING_RULES } from "../src/services/thinking-depth-router.js";

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
    { name: "bad-depth", fetchImpl: okFetch('{"depth":"ultra"}') },
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

test("routing ruleset stays versioned and model-readable (owner 2026-08-27; max cut 2026-08-28)", async () => {
  assert.ok(THINKING_DEPTH_ROUTING_RULES.includes("拿不准时选 low"), "fail-toward-low must stay explicit");
  assert.ok(THINKING_DEPTH_ROUTING_RULES.includes("high"), "high tier must be defined");
  // 2026-08-28 裁撤 max 档（Z.ai bench：Flash High→Max 仅 +约1pp 而 token 近乎
  // 翻倍；实盘零命中）——规则集不得再向裁判提供 max 输出选项。
  assert.ok(!/"depth":"low"或"high"或"max"/.test(THINKING_DEPTH_ROUTING_RULES), "ruleset must not offer max to the judge");
  assert.ok(THINKING_DEPTH_ROUTING_RULES.includes("极限深度要求"), "extreme-depth requests must be redirected to high");
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

test("automation-mode routing judges task instructions with the automation ruleset", async () => {
  const deep = await classifyThinkingDepth({
    text: "每周复盘\n生成周度深度复盘报告：趋势研判、逻辑归因、下周策略论证\n输出模式: {\"mode\":\"none\"}",
    mode: "automation",
    env,
    fetchImpl: okFetch('{"depth":"high","reason":"叙述性研判产出"}'),
  });
  assert.equal(deep.depth, "high");
  const contract = await classifyThinkingDepth({
    text: "每天行业复盘\n读取绑定工作簿表尾追加当日行业复盘行\n输出模式: {\"mode\":\"update\"}",
    mode: "automation",
    env,
    fetchImpl: okFetch('{"depth":"low","reason":"表格契约任务"}'),
  });
  assert.equal(contract.depth, "low");
});

test("two tiers map to gateway depth aliases, judge max collapses to high (max cut 2026-08-28)", async () => {
  const { THINKING_DEPTH_MODELS } = await import("../src/services/thinking-depth-router.js");
  assert.deepEqual(THINKING_DEPTH_MODELS, { low: "glm-5.3-flash", high: "glm-5.3-flash-high" });
  // 裁撤 max 后裁判违规输出 max 时降档收敛到 high，保留高深度意图。
  const collapsed = await classifyThinkingDepth({ text: "穷尽分析一下", env, fetchImpl: okFetch('{"depth":"max","reason":"极限深度"}') });
  assert.equal(collapsed.depth, "high");
  assert.ok(collapsed.reason.startsWith("max-collapsed-high"));
  const runnerSource = await (await import("node:fs/promises")).readFile(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.ok(runnerSource.includes('mode: "automation"'), "runner must classify task instructions in automation mode");
  assert.ok(runnerSource.includes("_thinkingDepthHint: thinkingDecision"), "runner must pass the hint through message context");
  const agentSource = await (await import("node:fs/promises")).readFile(new URL("../src/runtime/agent.ts", import.meta.url), "utf8");
  assert.ok(agentSource.includes("_thinkingDepthHint"), "agent must consume the automation hint");
});

test("retired glm-5.3-flash-max alias stays priced for historical trace recompute", async () => {
  const { computeModelCost } = await import("../src/services/model-pricing.js");
  const cost = computeModelCost("glm-5.3-flash-max", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost.source, "priced");
  assert.equal(cost.amount, 3.6);
});

test("automation ruleset v2 puts contract tasks decisively at low (mg 2026-08-27 backfill lesson)", async () => {
  // 实盘教训：控盘度复盘（update 契约 + 逐股推算字样）被判 high → 570s 超时。
  // 补丁后最高优先级条款必须压过「需要推算」。
  assert.ok(THINKING_DEPTH_AUTOMATION_RULES.includes("最高优先级条款"), "precedence clause must exist");
  assert.ok(THINKING_DEPTH_AUTOMATION_RULES.includes("此条款优先于其他一切条款"), "explicit precedence must be stated");
  // T-396：临时例句锚定已移除——根因是 runtime 层规则集错配（已修），不是规则集缺陷。
  assert.ok(!THINKING_DEPTH_AUTOMATION_RULES.includes("临时补丁"), "temporary anchor sentence must stay removed");
});

test("automation messages must not enter the interactive judge (T-396 runtime ruleset mismatch fix)", async () => {
  // 2026-08-27 实盘根因：channel="automation" 的 userChannel 兜底为 "api"，
  // 执行文本被交互规则集二次裁判并覆盖 runner 判定（hint 分支不可达死代码），
  // 同一任务 low/high/low/high 翻转全部发生在这一层。修复后 automation 消息
  // 只认 runner hint；交互裁判仅服务真人消息。
  const source = await (await import("node:fs/promises")).readFile(new URL("../src/runtime/agent.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes('channel !== "automation"'),
    "interactive judge branch must exclude channel=automation messages",
  );
  assert.ok(
    source.includes("else if (channel === \"automation\""),
    "automation hint branch must stay reachable",
  );
});
