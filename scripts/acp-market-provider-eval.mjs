import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const runId = "market-mcp-acp-20260726";
const userId = "eval-market-mcp-20260726";
const instanceId = "invest-agent-eval-market-mcp-20260726";
const tradeDate = process.env.EVAL_TRADE_DATE?.trim();
const variant = tradeDate ? `-${tradeDate}` : "";
const conversationId = `${runId}${variant}`;

if (!process.env.TDX_MCP_API_KEY && !process.env.TUSHARE_TOKEN) {
  throw new Error("Set at least one optional market provider credential for this evaluation.");
}

const { ensureWorkspace } = await import("../dist/lib/workspace.js");
const { WorkspaceStore } = await import("../dist/lib/workspace-store.js");
const { chatViaConversationLog, getConversation } = await import("../dist/services/conversation-log.js");
const { sqlite } = await import("../dist/db/index.js");
const { config } = await import("../dist/lib/config.js");

const workspace = await ensureWorkspace({ userId, tenantId: userId, projectId: instanceId });
const store = new WorkspaceStore(userId);
await store.writeOnboardingState({
  version: 1,
  status: "completed",
  current_step: "completed",
  steps: {},
  completed_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  notes: "Retained isolated ACP market-provider evaluation fixture.",
});

const result = await chatViaConversationLog({
  userId,
  instanceId,
  projectId: instanceId,
  assistantId: instanceId,
  conversationId,
  userMessageId: `${runId}${variant}-1`,
  idempotencyKey: `${runId}${variant}-1`,
  text: tradeDate
    ? `请使用服务层工具查询贵州茅台（600519）在 ${tradeDate} 的 PE、PB、换手率和量比；请明确说明是否成功使用该交易日补全日频估值，数据来源、日期和数据缺口；不要写入任何用户配置。`
    : "请使用可用的服务层工具查询贵州茅台（600519）的 PE、PB、ROE、营业收入和归母净利润。请返回数据来源、报告期和数据缺口；不要写入任何用户配置。",
});

const conversation = getConversation({ userId, instanceId, projectId: instanceId, assistantId: instanceId, conversationId });
const trace = sqlite.prepare(`
  SELECT status, elapsed_ms AS elapsedMs, reply_text_sanitized AS replyText
  FROM codex_acp_traces
  WHERE user_id = ? AND instance_id = ? AND conversation_id = ?
  ORDER BY created_at DESC LIMIT 1
`).get(userId, instanceId, conversationId);
const audits = sqlite.prepare(`
  SELECT operation, resource_type AS resourceType, result_summary AS resultSummary, status
  FROM sandbox_audit_logs
  WHERE user_id = ? AND instance_id = ? AND conversation_id = ?
  ORDER BY created_at ASC
`).all(userId, instanceId, conversationId);
const telemetryFile = path.join(
  config.runtimeData.sourceTelemetryDir,
  `${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" })}.jsonl`,
);
const telemetry = await readFile(telemetryFile, "utf8")
  .then((text) => text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.userId === userId))
  .catch(() => []);

assert.equal(trace?.status, "success", "ACP trace must succeed");
assert.ok(conversation?.messages.some((message) => message.role === "assistant"), "assistant reply must be persisted");
assert.ok(audits.some((row) => row.operation === "market.fundamentals" && row.status === "success"), "ACP must call market.fundamentals through the service MCP");

console.log(JSON.stringify({
  runId,
  userId,
  instanceId,
  conversationId,
  workspacePath: workspace.path,
  retention: "retain",
  trace,
  assistantReply: result.assistantMessage.content,
  audits,
  telemetry,
}, null, 2));
