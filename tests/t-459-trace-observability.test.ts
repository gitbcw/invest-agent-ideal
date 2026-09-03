import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * T-459 TRACE 可观测性验收（契约 contracts/T-459.md 的 [auto] 项）：
 * ① 载荷截断（32KB 头尾保留 + truncated 标记 + 总量）；
 * ② 自动化 run（runId 存在）载荷落库、交互会话不落；
 * ③ automation_task_revisions 编辑来源（portal/agent/script/system/unknown）；
 * ④ 90 天滚动清理只删过期载荷行。
 */
const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-t459-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "t459.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const trace = await import("../src/runtime/trace.js");
  const automation = await import("../src/services/automation-tasks.js");
  const retention = await import("../src/services/trace-payload-retention.js");
  return { db, trace, automation, retention };
})();

test("serializeTracePayload：未超限原样保留，超限头尾保留并标记总量", async () => {
  const { serializeTracePayload, TRACE_PAYLOAD_MAX_CHARS } = await import("../src/lib/trace-payload.js");
  const small = serializeTracePayload({ rows: [[1, 2], [3, 4]] });
  assert.equal(small.truncated, false);
  assert.ok(small.text.includes("rows"));
  assert.equal(small.totalChars, small.text.length);

  const bigInput = "x".repeat(TRACE_PAYLOAD_MAX_CHARS * 3);
  const big = serializeTracePayload(bigInput);
  assert.equal(big.truncated, true);
  assert.equal(big.totalChars, bigInput.length);
  assert.ok(big.text.includes("[trace-payload truncated:"));
  // 头尾都在：开头是 x 连续段，结尾也是 x 连续段，中段被截断标记打断。
  assert.ok(big.text.startsWith("xxx"));
  assert.ok(big.text.endsWith("xxx"));
  assert.ok(big.text.length <= TRACE_PAYLOAD_MAX_CHARS + 200);

  const jsonBig = serializeTracePayload({ data: "y".repeat(TRACE_PAYLOAD_MAX_CHARS * 2) });
  assert.equal(jsonBig.truncated, true);
  assert.ok(jsonBig.text.startsWith('{"data":"yyy'));
});

test("collectMastraToolPayloads：call/result 按 toolCallId 合并且保留载荷", async () => {
  const { collectMastraToolPayloads } = await import("../src/mastra/run-turn.js");
  const payloads = collectMastraToolPayloads(
    [{ toolCallId: "tc-1", toolName: "get_hist_kline", serverId: "market-data-tool", args: { symbol: "600519", limit: 10 } }],
    [{ payload: { toolCallId: "tc-1", result: { columns: ["date"], rows: [["2026-09-03"]] } } }],
    "2026-09-03T12:00:00.000Z",
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].toolCallId, "tc-1");
  assert.equal(payloads[0].toolName, "get_hist_kline");
  assert.ok(payloads[0].input?.text.includes("600519"));
  assert.ok(payloads[0].output?.text.includes("2026-09-03"));

  const errored = collectMastraToolPayloads([], [{ id: "tc-2", isError: true, error: "boom" }]);
  assert.equal(errored[0].status, "error");
  assert.ok(errored[0].output?.text.includes("boom"));

  assert.deepEqual(collectMastraToolPayloads([{ noId: true }], []), []);
});

test("自动化 run（runId）载荷落库，交互会话（无 runId）不落", async () => {
  const { db, trace } = await fixture;
  const { sqlite } = db;
  await trace.recordAgentTrace({
    traceId: "t459-trace-1",
    runId: "atrun_t459-run-1",
    taskId: "at_t459-task",
    userId: "t459-user", projectId: "invest-agent", instanceId: "t459-instance",
    conversationId: "automation-run:atrun_t459-run-1", channel: "automation",
    userText: "执行一个受控的通用自动化任务。",
    mode: "automation", status: "success",
    toolCalls: [{ toolCallId: "tc-1", inputChars: 20, outputChars: 30 }],
    toolPayloads: [
      { toolCallId: "tc-1", serverId: "market-data-tool", toolName: "get_hist_kline", status: "success", startedAt: "2026-09-03T12:00:00.000Z", input: { text: '{"symbol":"600519"}', truncated: false, totalChars: 19 }, output: { text: "z".repeat(40000), truncated: true, totalChars: 120000 } },
    ],
  });
  const rows = sqlite.prepare("SELECT * FROM automation_tool_payloads WHERE run_id = 'atrun_t459-run-1'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool_call_id, "tc-1");
  assert.equal(rows[0].input_truncated, 0);
  assert.equal(rows[0].output_truncated, 1);
  assert.equal(rows[0].output_total_chars, 120000);
  assert.equal(rows[0].trace_id, "t459-trace-1");

  await trace.recordAgentTrace({
    traceId: "t459-trace-2",
    userId: "t459-user", projectId: "invest-agent", instanceId: "t459-instance",
    conversationId: "chat-conversation", channel: "web",
    userText: "聊天消息", mode: "chat", status: "success",
    toolPayloads: [{ toolCallId: "tc-chat", status: "success", startedAt: "2026-09-03T12:05:00.000Z", input: { text: "secret-adjacent", truncated: false, totalChars: 15 } }],
  });
  const chatRows = sqlite.prepare("SELECT COUNT(*) AS n FROM automation_tool_payloads WHERE trace_id = 't459-trace-2'").get();
  assert.equal(chatRows.n, 0);
});

test("任务修订编辑来源：显式来源落库，缺省显式 unknown 不伪装", async () => {
  const { db, automation } = await fixture;
  const { sqlite } = db;
  const scope = { userId: "t459-user2", projectId: "invest-agent", instanceId: "t459-instance2" };
  const schedule = { frequency: "daily" as const, time: "07:30", timezone: "Asia/Shanghai" };

  const created = await automation.createAutomationTask({
    ...scope,
    taskId: "at_t459_created",
    name: "来源测试-创建",
    instruction: "测试指令",
    schedule,
    output: { mode: "none" },
    delivery: { mode: "none" },
    editSource: "portal",
    editSourceRef: "portal-req-1",
  });
  const createdRow = sqlite.prepare("SELECT edit_source, edit_source_ref FROM automation_task_revisions WHERE revision_id = ?").get(created.currentRevisionId);
  assert.equal(createdRow.edit_source, "portal");
  assert.equal(createdRow.edit_source_ref, "portal-req-1");

  const updated = await automation.updateAutomationTask({
    ...scope,
    taskId: created.taskId,
    expectedRevision: created.currentRevision,
    instruction: "更新后的指令",
    editSource: "agent",
    editSourceRef: "atrun_agent-run",
  });
  const updatedRow = sqlite.prepare("SELECT edit_source, edit_source_ref FROM automation_task_revisions WHERE revision_id = ?").get(updated.currentRevisionId);
  assert.equal(updatedRow.edit_source, "agent");
  assert.equal(updatedRow.edit_source_ref, "atrun_agent-run");

  const untouched = await automation.updateAutomationTask({
    ...scope,
    taskId: created.taskId,
    expectedRevision: updated.currentRevision,
    instruction: "再更新一次（无来源）",
  });
  const untouchedRow = sqlite.prepare("SELECT edit_source FROM automation_task_revisions WHERE revision_id = ?").get(untouched.currentRevisionId);
  assert.equal(untouchedRow.edit_source, "unknown");

  const bogus = await automation.updateAutomationTask({
    ...scope,
    taskId: created.taskId,
    expectedRevision: untouched.currentRevision,
    instruction: "伪造来源测试",
    editSource: "nonsense" as never,
  });
  const bogusRow = sqlite.prepare("SELECT edit_source FROM automation_task_revisions WHERE revision_id = ?").get(bogus.currentRevisionId);
  assert.equal(bogusRow.edit_source, "unknown");
});

test("90 天滚动清理：只删过期载荷行，不碰主体记录", async () => {
  const { db, retention } = await fixture;
  const { sqlite } = db;
  const now = new Date("2026-09-03T12:00:00.000Z");
  const insert = sqlite.prepare("INSERT INTO automation_tool_payloads (run_id, user_id, instance_id, tool_call_id, created_at) VALUES (?, 'u', 'i', 'tc', ?)");
  insert.run("atrun_old", "2026-05-01T00:00:00.000Z");
  insert.run("atrun_edge", "2026-06-05T00:00:00.000Z"); // 距 now 90 天边界外（91 天）
  insert.run("atrun_recent", "2026-09-01T00:00:00.000Z");
  sqlite.prepare("INSERT INTO agent_traces (trace_id, user_id, conversation_id, channel, user_text, mode, status, created_at) VALUES ('keep-trace', 'u', 'c', 'automation', 'x', 'automation', 'success', '2026-05-01T00:00:00.000Z')").run();

  const result = retention.purgeExpiredAutomationToolPayloads({ now });
  assert.equal(result.deleted, 2);
  const remaining = sqlite.prepare("SELECT run_id FROM automation_tool_payloads ORDER BY run_id").all().map((r: { run_id: string }) => r.run_id);
  assert.deepEqual(remaining.filter((runId) => runId.startsWith("atrun_old") || runId.startsWith("atrun_edge")), []);
  assert.ok(remaining.includes("atrun_recent"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM agent_traces WHERE trace_id = 'keep-trace'").get().n, 1);
});
