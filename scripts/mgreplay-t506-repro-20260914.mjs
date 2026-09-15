#!/usr/bin/env node
/**
 * T-506 活体复现（owner 2026-09-14 晚授权「按建议复现一下看看」）。
 * 场景：mgreplay 名下 web 会话走「方法修改提报」全流程——请求 → 模型注册确认草案
 * （confirmations.request）→ 用户回「确认」→ 模型执行 method_changes.propose。
 * 观测：①草案 payload 键名结构（是否含 proposedChange/reason，对照 9-13 畸形注册
 * change_type/document/target_files/title）；②执行阶段是否复现 A（缺字段）/B（payload
 * mismatch）拒收弹球；③轮末是否空回复。逐轮可指定模型（D25 per-turn model）做对照。
 * 安全：mgreplay 独立 scope、合成请求文本、无真实用户数据；若 propose 成功仅在
 * mgreplay 名下产生一条 method_change_candidate（候选不自动生效）。
 * 用法（生产 /home/claude/invest-agent-mastra 下执行）：
 *   node scripts/mgreplay-t506-repro-20260914.mjs auto|gpt-5.6-terra|glm-5.3-flash|deepseek-flash
 */
import { writeFileSync, mkdirSync } from "node:fs";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const MODEL = process.argv[2] || "auto";
const OUT_DIR = "data/t506-repro-20260914";
const SCOPE = { userId: "mgreplay", projectId: "invest-agent", instanceId: "invest-agent-mgreplay" };
// 自然口吻、轻微欠定式——让模型自己选草案 schema，才能暴露注册畸形。
const REQUEST_TEXT = "帮我把方法改一下：技术分析方法里加一条「涨停次日不追高」的纪律，替换掉现在「强势股可追涨」的表述，理由是最近追涨连续止损。用正式的方法修改提报流程提交。";
const CONFIRM_TEXT = "确认";

const { sqlite } = await import("../dist/db/index.js");
const { createConversationSession, chatViaConversationLog } = await import("../dist/services/conversation-log.js");

const convId = `web_t506repro_${MODEL.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36)}`;
createConversationSession({ scope: SCOPE, conversationId: convId, channel: "web", title: "T-506 复现（方法修改提报）" });
console.log(`[t506] model=${MODEL} conversation=${convId}`);

async function turn(label, text) {
  const started = Date.now();
  try {
    const r = await chatViaConversationLog({
      ...SCOPE, conversationId: convId, text,
      ...(MODEL !== "auto" ? { model: MODEL } : {}),
      idempotencyKey: `${convId}-${label}`,
    });
    const reply = typeof r.assistantMessage?.content === "string" ? r.assistantMessage.content : JSON.stringify(r.assistantMessage?.content ?? "");
    console.log(`[t506] ${label}: ok ${Math.round((Date.now() - started) / 1000)}s replyLen=${reply.length} trace=${r.traceId ?? "none"}`);
    console.log(`[t506] ${label}: head=${JSON.stringify(reply.slice(0, 200))}`);
    return { ok: true, reply };
  } catch (e) {
    console.log(`[t506] ${label}: THREW ${Math.round((Date.now() - started) / 1000)}s ${String(e).slice(0, 300)}`);
    return { ok: false, error: String(e).slice(0, 500) };
  }
}

function auditLines() {
  const rows = sqlite.prepare("SELECT id, operation, status, request_body, result_summary FROM sandbox_audit_logs WHERE conversation_id = ? ORDER BY id").all(convId);
  return rows.map((r) => {
    let keys = "";
    try {
      const b = JSON.parse(r.request_body ?? "{}");
      keys = Object.keys(b).sort().join("+");
      if (b.payload && typeof b.payload === "object" && !Array.isArray(b.payload)) keys += ` | payload:${Object.keys(b.payload).sort().join("+")}`;
    } catch { keys = "unparsable"; }
    return `${r.id} ${r.operation} ${r.status} keys=[${keys}]${r.status !== "success" ? " err=" + (r.result_summary ?? "").slice(0, 90) : ""}`;
  });
}

const t1 = await turn("t1-request", REQUEST_TEXT);
console.log("[t506] audit after t1:");
for (const l of auditLines()) console.log("  " + l);

const pending = sqlite.prepare("SELECT id, operation, resource_type, status FROM pending_sandbox_confirmations WHERE conversation_id = ? ORDER BY created_at DESC").all(convId);
const open = pending.filter((r) => r.status === "pending");
const traceRows = sqlite.prepare("SELECT agent_model, status, elapsed_ms, reply_chars, reply_text_raw FROM agent_traces WHERE conversation_id = ? ORDER BY created_at").all(convId);

let t2 = null;
if (open.length === 0) {
  console.log(`[t506] no pending confirmation after t1 (rows=${pending.length}) — draft stage not reached`);
} else {
  console.log(`[t506] pending confirmation: ${open[0].id} operation=${open[0].operation}`);
  t2 = await turn("t2-confirm", CONFIRM_TEXT);
  console.log("[t506] audit after t2:");
  for (const l of auditLines()) console.log("  " + l);
}

const proposeRows = sqlite.prepare("SELECT status, result_summary, count(*) n FROM sandbox_audit_logs WHERE conversation_id = ? AND operation = ? GROUP BY status, result_summary").all(convId, "method_changes.propose");
console.log("[t506] propose verdicts:");
for (const r of proposeRows) console.log(`  ${r.status} ×${r.n} :: ${(r.result_summary ?? "").slice(0, 110)}`);
console.log("[t506] traces:");
for (const t of traceRows) console.log(`  ${t.agent_model} ${t.status} ${Math.round((t.elapsed_ms ?? 0) / 1000)}s replyChars=${t.reply_chars}`);

mkdirSync(OUT_DIR, { recursive: true });
const out = {
  model: MODEL, conversationId: convId, createdAt: new Date().toISOString(),
  t1: { ok: t1.ok, replyHead: (t1.reply ?? t1.error ?? "").slice(0, 400) },
  t2: t2 ? { ok: t2.ok, replyHead: (t2.reply ?? t2.error ?? "").slice(0, 400) } : null,
  audit: auditLines(), proposeRows, traces: traceRows.map((t) => ({ model: t.agent_model, status: t.status, replyChars: t.reply_chars })),
};
writeFileSync(`${OUT_DIR}/run-${MODEL.replace(/[^a-z0-9]/gi, "")}.json`, JSON.stringify(out, null, 2));
console.log(`[t506] saved → ${OUT_DIR}/run-${MODEL.replace(/[^a-z0-9]/gi, "")}.json`);
process.exit(0);
