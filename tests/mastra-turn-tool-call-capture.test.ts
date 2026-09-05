import assert from "node:assert/strict";
import test from "node:test";

import {
  createMastraTurnRunner,
  mapMastraToolCalls,
  mergeMastraToolCallsAndResults,
  type MastraAgentLike,
} from "../src/mastra/index.js";

/**
 * Mastra >= 1.5x aggregate output shape: chunks wrap the data in `payload`.
 * This was the G23 root cause — the mapper read top-level fields only, so
 * every aggregate chunk was dropped and agent_traces.tool_calls stayed empty.
 */
function fakeMastraAggregateAgent(calls: unknown[], results: unknown[], text = "完成"): MastraAgentLike {
  return {
    stream() {
      return {
        text: Promise.resolve(text),
        textStream: (async function* () {
          yield text;
        })(),
        usage: Promise.resolve({ inputTokens: 12, outputTokens: 8, totalTokens: 20 }),
        toolCalls: Promise.resolve(calls),
        toolResults: Promise.resolve(results),
        modelId: "fake-model",
      };
    },
  };
}

test("aggregate payload-wrapped toolCalls/toolResults map to terminal-state summaries (G23)", async () => {
  const runner = createMastraTurnRunner({
    agent: fakeMastraAggregateAgent(
      [{ type: "tool-call", payload: { toolCallId: "call-1", toolName: "portfolio.read", args: { scope: "default" } } }],
      [{ type: "tool-result", payload: { toolCallId: "call-1", toolName: "portfolio.read", result: { holdings: [] }, isError: false } }],
    ),
  });

  const result = await runner({ conversationId: "conv-tool-capture", text: "看下持仓" });

  assert.equal(result.text, "完成");
  assert.ok(result.toolCalls, "toolCalls must be captured from aggregate getters");
  assert.equal(result.toolCalls!.length, 1);
  const call = result.toolCalls![0];
  assert.equal(call.toolCallId, "call-1");
  assert.equal(call.toolName, "portfolio.read");
  assert.equal(call.status, "success");
  assert.ok(call.inputChars && call.inputChars > 0, "input size retained from call chunk");
  assert.ok(call.outputChars && call.outputChars > 0, "output size retained from result chunk");
  assert.ok(call.completedAt, "terminal completion time present");
  assert.equal(result.budget.timing.toolCallEvents, 1);
});

test("failed tool results surface status error and results without calls are kept standalone", async () => {
  const merged = mergeMastraToolCallsAndResults(
    [{ type: "tool-call", payload: { toolCallId: "a", toolName: "watchlist.add", args: { code: "600519" } } }],
    [
      { type: "tool-result", payload: { toolCallId: "a", toolName: "watchlist.add", result: { error: "CONFIRMATION_REQUIRED" }, isError: true } },
      { type: "tool-result", payload: { toolCallId: "b", toolName: "research.web_search", result: { items: [] }, isError: false } },
    ],
  );
  assert.ok(merged);
  assert.equal(merged!.length, 2);
  const failed = merged!.find((call) => call.toolCallId === "a");
  const standalone = merged!.find((call) => call.toolCallId === "b");
  assert.equal(failed!.status, "error");
  assert.equal(standalone!.status, "success");
  assert.equal(standalone!.toolName, "research.web_search");
});

test("legacy flat tool-call chunk shape still maps", () => {
  const mapped = mapMastraToolCalls([
    { toolCallId: "legacy-1", toolName: "plans.read", input: { limit: 5 }, status: "success" },
  ]);
  assert.ok(mapped);
  assert.equal(mapped![0].toolCallId, "legacy-1");
  assert.equal(mapped![0].status, "success");
});

test("fullStream tool chunks (v5 tool-input/tool-output event names) are collected", async () => {
  const agent: MastraAgentLike = {
    stream() {
      return {
        fullStream: (async function* () {
          yield { type: "start" };
          yield { type: "text-delta", text: "分析" };
          yield { type: "tool-input-start", payload: { toolCallId: "t1", toolName: "market_watch.snapshot" } };
          yield { type: "tool-output-available", payload: { toolCallId: "t1", toolName: "market_watch.snapshot", input: {}, output: { window: "am" } } };
          yield { type: "finish", usage: { totalTokens: 9 } };
        })(),
      };
    },
  };
  const runner = createMastraTurnRunner({ agent });
  const result = await runner({ conversationId: "conv-stream-tools", text: "盯盘" });
  assert.ok(result.toolCalls);
  assert.equal(result.toolCalls![0].toolCallId, "t1");
  assert.equal(result.toolCalls![0].toolName, "market_watch.snapshot");
  assert.equal(result.text, "分析");
});

test("timeout turn carries observed tool payloads on the error (T-459 abort-path capture)", async () => {
  // 2026-09-04 mg 持仓复盘 atrun_061599bc 超时被杀后 automation_tool_payloads
  // 零落库：载荷采集点在成功路径（run-turn 成功收尾），超时 reject 直接进
  // catch，只有 T-327 的调用元数据被带出、正文全丢。修复后 catch 从流事件
  // sink 同源采集。此测试锁住该行为：流挂起不结束，timeoutMs 触发 race 杀轮。
  const agent: MastraAgentLike = {
    stream() {
      return {
        fullStream: (async function* () {
          yield { type: "tool-input-start", payload: { toolCallId: "tc-timeout", toolName: "mdt_call", args: { dataset: "kline", symbol: "600519" } } };
          yield { type: "tool-output-available", payload: { toolCallId: "tc-timeout", toolName: "mdt_call", output: { rows: [["2026-09-04"]] } } };
          yield { type: "text-delta", text: "分析中" };
          await new Promise<void>(() => {});
        })(),
      };
    },
  };
  const runner = createMastraTurnRunner({ agent });
  await assert.rejects(
    runner({ conversationId: "conv-timeout-payload", text: "复盘", timeoutMs: 50 }),
    (error: unknown) => {
      const e = error as import("../src/mastra/types.js").MastraTurnError & { code?: string };
      assert.equal(e.code, "MASTRA_TURN_TIMEOUT");
      assert.ok(Array.isArray(e.toolCalls) && e.toolCalls.length > 0, "T-327: observed call metadata retained");
      assert.ok(Array.isArray(e.toolPayloads) && e.toolPayloads.length > 0, "T-459: payloads retained on timeout path");
      const payload = e.toolPayloads![0];
      assert.equal(payload.toolCallId, "tc-timeout");
      assert.equal(payload.toolName, "mdt_call");
      assert.ok(payload.input?.text.includes("600519"), "input args serialized");
      assert.ok(payload.output?.text.includes("2026-09-04"), "output result serialized");
      return true;
    },
  );
});
