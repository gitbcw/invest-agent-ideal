#!/usr/bin/env node
/**
 * T-506 复现补充步（owner 2026-09-14 授权复现的收尾）：对指定会话再发一轮「确认」，
 * 并用 user+时间窗（而非 conversation_id，实测审计行的 conversation 上下文不同源）
 * 打印全程工具审计与待确认草案键名结构。用法：
 *   node scripts/mgreplay-t506-repro-step.mjs <conversationId> [model]
 */
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const convId = process.argv[2];
const MODEL = process.argv[3] || "auto";
if (!convId) { console.error("usage: step <conversationId> [model]"); process.exit(2); }
const SCOPE = { userId: "mgreplay", projectId: "invest-agent", instanceId: "invest-agent-mgreplay" };
const startedAt = new Date().toISOString();

const { sqlite } = await import("../dist/db/index.js");
const { chatViaConversationLog } = await import("../dist/services/conversation-log.js");

function auditLines() {
  const rows = sqlite.prepare("SELECT id, operation, status, request_body, result_summary, created_at FROM sandbox_audit_logs WHERE user_id = ? AND instance_id = ? AND created_at >= ? ORDER BY id").all("mgreplay", SCOPE.instanceId, "2026-09-14T14:30:00");
  return rows.map((r) => {
    let keys = "";
    try {
      const b = JSON.parse(r.request_body ?? "{}");
      keys = Object.keys(b).sort().join("+");
      if (b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)) keys += ` | payload:${Object.keys(b.payload).sort().join("+")}`;
    } catch { keys = "unparsable"; }
    return `${r.id} ${r.created_at.slice(11, 19)} ${r.operation} ${r.status} keys=[${keys}]${r.status !== "success" ? " err=" + (r.result_summary ?? "").slice(0, 90) : ""}`;
  });
}

const pendingRows = sqlite.prepare("SELECT id, operation, status, request_body, created_at FROM pending_sandbox_confirmations WHERE conversation_id = ? ORDER BY created_at DESC").all(convId);
console.log(`[step] confirmations for ${convId}:`);
for (const r of pendingRows) {
  let keys = "";
  try { keys = Object.keys(JSON.parse(r.request_body ?? "{}")).sort().join("+"); } catch { keys = "unparsable"; }
  console.log(`  ${r.created_at.slice(11, 19)} ${r.status} ${r.operation} draftKeys=[${keys}] id=${r.id.slice(0, 8)}`);
}

console.log("[step] sending confirm turn…");
const t0 = Date.now();
try {
  const r = await chatViaConversationLog({
    ...SCOPE, conversationId: convId, text: "确认",
    ...(MODEL !== "auto" ? { model: MODEL } : {}),
    idempotencyKey: `${convId}-t3-${Date.now().toString(36)}`,
  });
  const reply = typeof r.assistantMessage?.content === "string" ? r.assistantMessage.content : "";
  console.log(`[step] t3: ok ${Math.round((Date.now() - t0) / 1000)}s replyLen=${reply.length}`);
  console.log(`[step] t3 head=${JSON.stringify(reply.slice(0, 260))}`);
} catch (e) {
  console.log(`[step] t3 THREW ${Math.round((Date.now() - t0) / 1000)}s ${String(e).slice(0, 300)}`);
}

console.log("[step] full audit window:");
for (const l of auditLines()) console.log("  " + l);
const propose = sqlite.prepare("SELECT status, count(*) n FROM sandbox_audit_logs WHERE user_id = ? AND instance_id = ? AND operation = ? AND created_at >= ? GROUP BY status").all("mgreplay", SCOPE.instanceId, "method_changes.propose", "2026-09-14T14:30:00");
console.log("[step] propose verdicts:", JSON.stringify(propose));
const traces = sqlite.prepare("SELECT agent_model, status, elapsed_ms, reply_chars FROM agent_traces WHERE conversation_id = ? ORDER BY created_at").all(convId);
for (const t of traces) console.log(`[step] trace ${t.agent_model} ${t.status} ${Math.round((t.elapsed_ms ?? 0) / 1000)}s replyChars=${t.reply_chars}`);
const candidates = sqlite.prepare("SELECT count(*) n FROM method_change_candidates WHERE user_id = ? AND instance_id = ?").get("mgreplay", SCOPE.instanceId);
console.log(`[step] mgreplay method_change_candidates total=${candidates.n}`);
console.log(`[step] startedAt=${startedAt}`);
process.exit(0);
