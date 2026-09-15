#!/usr/bin/env node
/**
 * T-506 复现循环驱动：新建或续跑一个 mgreplay web 会话，请求方法修改提报后，
 * 最多补 N 轮「确认」，直到 method_changes.propose 出现成败终态或轮回复空。
 * 用法：node scripts/mgreplay-t506-repro-loop.mjs <model|auto> [existingConversationId]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import process from "node:process";

process.env.WORKSPACE_BACKEND ??= "mastra";
const MODEL = process.argv[2] || "auto";
const EXISTING = process.argv[3] || "";
const OUT_DIR = "data/t506-repro-20260914";
const SCOPE = { userId: "mgreplay", projectId: "invest-agent", instanceId: "invest-agent-mgreplay" };
const REQUEST_TEXT = "帮我把方法改一下：技术分析方法里加一条「涨停次日不追高」的纪律，替换掉现在「强势股可追涨」的表述，理由是最近追涨连续止损。用正式的方法修改提报流程提交。";
const MAX_CONFIRM_TURNS = 3;

const { sqlite } = await import("../dist/db/index.js");
const { createConversationSession, chatViaConversationLog } = await import("../dist/services/conversation-log.js");

const convId = EXISTING || `web_t506repro_${MODEL.replace(/[^a-z0-9]/gi, "")}_${Date.now().toString(36)}`;
if (!EXISTING) createConversationSession({ scope: SCOPE, conversationId: convId, channel: "web", title: "T-506 复现（方法修改提报）" });
console.log(`[t506-loop] model=${MODEL} conversation=${convId} ${EXISTING ? "(continue)" : "(new)"}`);

async function sendTurn(label, text) {
  const started = Date.now();
  try {
    const r = await chatViaConversationLog({
      ...SCOPE, conversationId: convId, text,
      ...(MODEL !== "auto" ? { model: MODEL } : {}),
      idempotencyKey: `${convId}-${label}-${Date.now().toString(36)}`,
    });
    const reply = typeof r.assistantMessage?.content === "string" ? r.assistantMessage.content : "";
    console.log(`[t506-loop] ${label}: ok ${Math.round((Date.now() - started) / 1000)}s replyLen=${reply.length}`);
    console.log(`[t506-loop] ${label}: head=${JSON.stringify(reply.slice(0, 180))}`);
    return { ok: true, reply };
  } catch (e) {
    console.log(`[t506-loop] ${label}: THREW ${Math.round((Date.now() - started) / 1000)}s ${String(e).slice(0, 240)}`);
    return { ok: false, error: String(e).slice(0, 400) };
  }
}

const RUN_SINCE = new Date().toISOString().slice(0, 19).replace("T", "T"); // 本进程起点，隔离历史 run 的审计
const proposeState = () => sqlite.prepare(
  "SELECT status, count(*) n FROM sandbox_audit_logs WHERE user_id = ? AND instance_id = ? AND operation = ? AND created_at >= ? GROUP BY status"
).all("mgreplay", SCOPE.instanceId, "method_changes.propose", RUN_SINCE);
const proposeSucceeded = () => proposeState().some((r) => r.status === "success");
const pendingDraft = () => sqlite.prepare(
  "SELECT id, request_body, created_at FROM pending_sandbox_confirmations WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
).get(convId);
const draftKeys = (row) => { try { return Object.keys(JSON.parse(row.request_body ?? "{}")).sort().join("+"); } catch { return "unparsable"; } };

const log = { model: MODEL, conversationId: convId, turns: [], drafts: [] };

if (!EXISTING) {
  const t1 = await sendTurn("t1-request", REQUEST_TEXT);
  log.turns.push({ label: "t1", ...t1 });
}
const d0 = pendingDraft();
if (d0) { console.log(`[t506-loop] current pending draft: ${draftKeys(d0)} @${d0.created_at.slice(11, 19)}`); log.drafts.push({ at: d0.created_at, keys: draftKeys(d0) }); }

for (let i = 1; i <= MAX_CONFIRM_TURNS; i += 1) {
  if (proposeSucceeded()) { console.log("[t506-loop] propose already succeeded — stop"); break; }
  const t = await sendTurn(`confirm-${i}`, "确认");
  log.turns.push({ label: `confirm-${i}`, ...t });
  const d = pendingDraft();
  if (d) log.drafts.push({ at: d.created_at, keys: draftKeys(d) });
  const pv = proposeState();
  console.log(`[t506-loop] propose verdicts now: ${JSON.stringify(pv)}`);
  if (proposeSucceeded()) { console.log("[t506-loop] SUCCESS — propose landed"); break; }
  if (!t.ok || t.reply.length === 0) { console.log("[t506-loop] empty/failed turn — stop (empty-response signature)"); break; }
  const asksConfirm = /确认/.test(t.reply) && (t.reply.includes("再回复") || t.reply.includes("请回复") || t.reply.includes("等待你的确认") || t.reply.includes("等待确认"));
  if (!asksConfirm) { console.log("[t506-loop] reply no longer asks for confirmation — stop"); break; }
}

const traces = sqlite.prepare("SELECT agent_model, status, elapsed_ms, reply_chars, created_at FROM agent_traces WHERE conversation_id = ? ORDER BY created_at").all(convId);
console.log("[t506-loop] traces:");
for (const t of traces) console.log(`  ${t.created_at.slice(11, 19)} ${t.agent_model} ${t.status} ${Math.round((t.elapsed_ms ?? 0) / 1000)}s replyChars=${t.reply_chars}`);
const candidates = sqlite.prepare("SELECT count(*) n FROM method_change_candidates WHERE user_id = ? AND instance_id = ?").get("mgreplay", SCOPE.instanceId);
console.log(`[t506-loop] mgreplay candidates total=${candidates.n} | propose verdicts=${JSON.stringify(proposeState())}`);
log.traces = traces.map((t) => ({ at: t.created_at, model: t.agent_model, status: t.status, replyChars: t.reply_chars }));
log.propose = proposeState(); log.candidatesTotal = candidates.n;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/loop-${MODEL.replace(/[^a-z0-9]/gi, "")}-${convId.slice(-6)}.json`, JSON.stringify(log, null, 2));
console.log(`[t506-loop] saved → ${OUT_DIR}/loop-${MODEL.replace(/[^a-z0-9]/gi, "")}-${convId.slice(-6)}.json`);
process.exit(0);
