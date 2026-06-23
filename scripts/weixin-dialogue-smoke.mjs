#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const instanceId = process.env.INSTANCE_ID || "invest-agent-jr-method-tester-2";
const userId = process.env.USER_ID || "jr-method-tester-2";
const conversationId = process.env.CONVERSATION_ID || `sim-weixin-${Date.now()}`;
const accountId = process.env.ACCOUNT_ID || "sim-weixin-bot";
const seedContext = process.env.SEED_CONTEXT !== "false";
const cleanup = process.env.CLEANUP !== "false";
const cleanupWatchlistCodes = ["002230", "603019", "300418"];

const messages = process.argv.slice(2);
const scriptMessages = messages.length > 0
  ? messages
  : [
      "把上面这3个股票加入到我的自选股",
      "查看我的自选股",
      "黄金ETF 518880 上涨5%的时候提醒我",
      "确认",
      "查看我的提醒列表",
    ];

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function sqlite(sql) {
  const result = spawnSync("sqlite3", ["./data/invest-agent.db", sql], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

console.log(`# WeChat Dialogue Smoke`);
console.log(`baseUrl: ${baseUrl}`);
console.log(`instanceId: ${instanceId}`);
console.log(`userId: ${userId}`);
console.log(`conversationId: ${conversationId}`);
console.log("");

if (seedContext) {
  const now = new Date().toISOString();
  const seed = "如果只选3个放自选池，我建议先看：科大讯飞(002230)、中科曙光(603019)、昆仑万维(300418)。";
  sqlite(
    `insert into chat_history(user_id,instance_id,conversation_id,role,content,created_at) values('${userId.replace(/'/g, "''")}','${instanceId.replace(/'/g, "''")}','${conversationId.replace(/'/g, "''")}','assistant','${seed.replace(/'/g, "''")}','${now}');`
  );
  console.log(`Seed：${seed}`);
  console.log("");
}

for (const [index, message] of scriptMessages.entries()) {
  const data = await postJson("/api/testing/weixin-simulate", {
    message,
    conversationId,
    instanceId,
    accountId,
  });
  const trace = sqlite(
    `select id || '|' || mode || '|' || status || '|' || coalesce(elapsed_ms,'') from codex_acp_traces where conversation_id='${conversationId.replace(/'/g, "''")}' order by id desc limit 1;`
  );
  console.log(`## Turn ${index + 1}`);
  console.log(`用户：${message}`);
  console.log(`助手：${data.text || ""}`);
  console.log(`耗时：${data.elapsedMs}ms`);
  if (trace) {
    const [id, mode, status, elapsedMs] = trace.split("|");
    console.log(`Trace：#${id} ${mode} ${status} ${elapsedMs}ms`);
  } else {
    console.log(`Trace：未找到`);
  }
  console.log("");
}

if (cleanup) {
  sqlite(
    `delete from watchlist where user_id='${userId.replace(/'/g, "''")}' and instance_id='${instanceId.replace(/'/g, "''")}' and stock_code in (${cleanupWatchlistCodes.map((code) => `'${code}'`).join(",")}) and source='ai_conversation' and reason='来自最近对话，用户确认加入自选';`
  );
  console.log(`Cleanup：已清理默认 smoke 加入的自选测试标的（如存在）。`);
}
