/**
 * 快速查日志通道。
 *
 * 输出:
 *   1. 最近 N 条 Codex ACP trace（含错误）
 *   2. 最近 N 条 chat_history
 *   3. dev 日志最后 40 行（ERROR 优先）
 *
 * 用法:
 *   node scripts/recent-logs.mjs           # 默认 10 条
 *   node scripts/recent-logs.mjs 20        # 20 条
 *   node scripts/recent-logs.mjs errors    # 只看错误
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";

const DB_PATH = process.env.DB_PATH || "./data/invest-agent.db";
const DEV_LOG = "/tmp/invest-agent-dev.log";
const limit = Number(process.argv[2]) || 10;
const onlyErrors = process.argv[2] === "errors";

if (!existsSync(DB_PATH)) {
  console.error(`db not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

function trunc(s, n = 200) {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

console.log(`\n┌─ Codex ACP traces (最近 ${limit} 条${onlyErrors ? ", 仅错误" : ""}) ──────────────────────────`);
const traces = db.prepare(
  onlyErrors
    ? `SELECT id, mode, status, user_text, reply_text_sanitized, error_message, elapsed_ms, created_at
       FROM codex_acp_traces WHERE status != 'success' ORDER BY id DESC LIMIT ?`
    : `SELECT id, mode, status, user_text, reply_text_sanitized, error_message, elapsed_ms, created_at
       FROM codex_acp_traces ORDER BY id DESC LIMIT ?`
).all(limit);

if (traces.length === 0) {
  console.log("│  (空)");
}
for (const t of traces) {
  const flag = t.status === "success" ? "✓" : t.status === "error" ? "✗" : "⚠";
  console.log(`│`);
  console.log(`│ ${flag} #${t.id} [${t.mode}] ${t.status} ${t.elapsed_ms}ms  ${t.created_at}`);
  console.log(`│   用户: ${trunc(t.user_text, 120)}`);
  if (t.reply_text_sanitized) {
    console.log(`│   回复: ${trunc(t.reply_text_sanitized, 200)}`);
  }
  if (t.error_message) {
    console.log(`│   错误: ${trunc(t.error_message, 300)}`);
  }
}

console.log(`\n┌─ chat_history (最近 ${limit} 条) ──────────────────────────`);
const chats = db.prepare(
  `SELECT id, role, content, created_at FROM chat_history ORDER BY id DESC LIMIT ?`
).all(limit);

if (chats.length === 0) {
  console.log("│  (空)");
}
for (const c of chats) {
  const tag = c.role === "user" ? "👤" : "🤖";
  console.log(`│ ${tag} #${c.id} ${c.created_at}`);
  console.log(`│   ${trunc(c.content, 300)}`);
}

db.close();

if (existsSync(DEV_LOG)) {
  console.log(`\n┌─ dev 日志 (最后 40 行, 仅 ERROR/WARN/ACP 关键事件) ──────────────────────────`);
  const lines = readFileSync(DEV_LOG, "utf-8").split("\n");
  const filtered = lines.filter(l =>
    /\[ERROR\]|\[WARN\]|Codex ACP|onboarding|首次对话|triage|FAIL|timeout|超时/i.test(l)
  );
  console.log(filtered.slice(-40).join("\n") || "(无匹配)");
}

console.log("\n");
