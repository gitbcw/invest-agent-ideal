import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetToolResultOffloadForTest,
  __toolResultOffloadSizeForTest,
  maybeOffloadToolResult,
  readFullToolResultOffload,
  readToolResultOffload,
  registerToolResultOffload,
  type ToolResultOffloadScope,
} from "../src/mastra/tool-result-offload.js";

const scope: ToolResultOffloadScope = { userId: "u1", projectId: "invest-agent", instanceId: "i1", conversationId: "c1" };
const otherUser: ToolResultOffloadScope = { userId: "u2", projectId: "invest-agent", instanceId: "i1", conversationId: "c2" };
const sameConversationOtherUser: ToolResultOffloadScope = { userId: "u2", projectId: "invest-agent", instanceId: "i1", conversationId: "c1" };

test("register + slice read roundtrip", () => {
  __resetToolResultOffloadForTest();
  const content = "x".repeat(50_000);
  const ref = registerToolResultOffload(scope, "market-data-tool", "get_zt_pool", content);
  assert.ok(ref.startsWith("tr-"));
  const first = readToolResultOffload(scope, ref, 0, 8_000);
  assert.ok(!("error" in first));
  assert.equal(first!.chars, 8_000);
  assert.equal(first!.total_chars, 50_000);
  assert.equal(first!.remaining_chars, 42_000);
  const second = readToolResultOffload(scope, ref, 49_990, 8_000);
  assert.equal(second!.chars, 10);
  assert.equal(second!.remaining_chars, 0);
});

test("scope isolation: cross-user and cross-conversation denied", () => {
  __resetToolResultOffloadForTest();
  const ref = registerToolResultOffload(scope, "mdt", "t", "abc");
  assert.equal((readToolResultOffload(otherUser, ref, 0, 100) as { error: string }).error, "TOOL_RESULT_REF_FORBIDDEN");
  assert.equal((readToolResultOffload(sameConversationOtherUser, ref, 0, 100) as { error: string }).error, "TOOL_RESULT_REF_FORBIDDEN");
  // 同 user 同 instance、scope 未带 conversationId（程序化消费方）可读。
  const programmatic: ToolResultOffloadScope = { userId: "u1", projectId: "invest-agent", instanceId: "i1" };
  assert.ok(!("error" in readToolResultOffload(programmatic, ref, 0, 100)));
  assert.equal(readFullToolResultOffload(otherUser, ref), null);
  assert.equal(readFullToolResultOffload(programmatic, ref), "abc");
});

test("unknown or malformed ref returns structured error", () => {
  __resetToolResultOffloadForTest();
  assert.equal((readToolResultOffload(scope, "tr-nothing", 0, 100) as { error: string }).error, "TOOL_RESULT_REF_NOT_FOUND");
});

test("maybeOffloadToolResult: undersized and unrecognized shapes pass through unchanged", () => {
  __resetToolResultOffloadForTest();
  const small = "short";
  assert.equal(maybeOffloadToolResult(small, scope, "mdt", "t", 20_000), small);
  const cyclic: unknown = {};
  (cyclic as Record<string, unknown>).self = cyclic;
  // 序列化失败 → 原样返回，不影响调用。
  assert.equal(maybeOffloadToolResult(cyclic, scope, "mdt", "t", 20_000), cyclic);
  assert.equal(__toolResultOffloadSizeForTest(), 0);
});

test("maybeOffloadToolResult: oversized string becomes preview envelope with ref", () => {
  __resetToolResultOffloadForTest();
  const content = Array.from({ length: 6_000 }, (_, i) => `row-${i}-数据`).join("\n");
  const rewritten = maybeOffloadToolResult(content, scope, "market-data-tool", "get_hist_klines", 20_000);
  assert.equal(typeof rewritten, "string");
  const envelope = JSON.parse(rewritten as string) as { status: string; result_ref: string; preview: string; original_chars: number; instruction: string };
  assert.equal(envelope.status, "data_truncated_preview");
  assert.ok(envelope.result_ref.startsWith("tr-"));
  assert.equal(envelope.original_chars, content.length);
  assert.ok(content.startsWith(envelope.preview), "preview is a verbatim head of the original");
  assert.ok(envelope.preview.length < content.length);
  assert.ok(envelope.instruction.includes("toolresult.read"));
  // 全量可经 ref 分片取回。
  assert.equal(readFullToolResultOffload(scope, envelope.result_ref), content);
});

test("maybeOffloadToolResult: text block and array shapes preserve envelope structure", () => {
  __resetToolResultOffloadForTest();
  const big = "y".repeat(30_000);
  const block = { type: "text", text: big } as { type: string; text: string };
  const rewrittenBlock = maybeOffloadToolResult(block, scope, "mdt", "t", 20_000) as { type: string; text: string };
  assert.equal(rewrittenBlock.type, "text");
  assert.equal(JSON.parse(rewrittenBlock.text).status, "data_truncated_preview");
  const blocks = [{ type: "text", text: big }, { type: "other" }];
  const rewrittenArray = maybeOffloadToolResult(blocks, scope, "mdt", "t", 20_000) as Array<{ type: string; text?: string }>;
  assert.equal(rewrittenArray.length, 2);
  assert.equal(rewrittenArray[1].type, "other");
  assert.equal(JSON.parse(rewrittenArray[0].text!).status, "data_truncated_preview");
});

test("maybeOffloadToolResult: MCP content-block shape gets the envelope in-place", () => {
  __resetToolResultOffloadForTest();
  const big = JSON.stringify({ columns: ["代码"], rows: Array.from({ length: 3000 }, (_, i) => [`60000${i % 10}`, `名称${i}`, i]) });
  const result = { content: [{ type: "text", text: big }] };
  const rewritten = maybeOffloadToolResult(result, scope, "market-data-tool", "get_zt_pool", 20_000) as { content: Array<{ type: string; text: string }> };
  assert.equal(rewritten.content.length, 1);
  assert.equal(rewritten.content[0].type, "text");
  const envelope = JSON.parse(rewritten.content[0].text) as { status: string; result_ref: string };
  assert.equal(envelope.status, "data_truncated_preview");
  assert.equal(readFullToolResultOffload(scope, envelope.result_ref), big);
});

test("maybeOffloadToolResult: MCP structuredContent plain object becomes the envelope (2026-10-09 镜像回归)", () => {
  __resetToolResultOffloadForTest();
  // @mastra/mcp 对带 structuredContent 的工具直接返回解析后的普通对象
  // （{columns, rows, meta}）。回归背景：该形态未覆盖时改写不生效，掉回旧
  // 处理器 requires_smaller_query 截断（rows_visible_to_model=0），模型把
  // 大 limit 的真实数据读成「工具返回空」盲试 20 次。
  const rows = Array.from({ length: 3000 }, (_, i) => [`60000${i % 10}`, `名称${i}`, i]);
  const structured = { columns: ["代码", "名称", "序号"], rows, meta: { total: 3000 } };
  const rewritten = maybeOffloadToolResult(structured, scope, "market-data-tool", "get_zt_pool", 20_000) as { status: string; result_ref: string; preview: string; original_chars: number };
  assert.equal(rewritten.status, "data_truncated_preview");
  assert.ok(rewritten.result_ref.startsWith("tr-"));
  assert.ok(JSON.stringify(structured).startsWith(rewritten.preview));
  assert.equal(readFullToolResultOffload(scope, rewritten.result_ref), JSON.stringify(structured));
});

test("store cap evicts oldest entries", () => {
  __resetToolResultOffloadForTest();
  const refs: string[] = [];
  for (let i = 0; i < 160; i++) {
    refs.push(registerToolResultOffload(scope, "mdt", `t${i}`, `content-${i}`));
  }
  assert.ok(__toolResultOffloadSizeForTest() <= 150);
  // 最早注册的条目已被淘汰。
  assert.equal((readToolResultOffload(scope, refs[0], 0, 10) as { error: string }).error, "TOOL_RESULT_REF_NOT_FOUND");
});
