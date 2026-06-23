#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const instanceId = process.env.INSTANCE_ID || "invest-agent-primary";
const conversationId = process.env.CONVERSATION_ID || `readonly-weixin-${Date.now()}`;
const accountId = process.env.ACCOUNT_ID || "readonly-weixin-smoke-bot";

const cases = [
  { message: "查看我的持仓", expectedMode: /fast-(admin-)?portfolio-query/ },
  { message: "查看我的自选股", expectedMode: /fast-(admin-)?watchlist-query/ },
  { message: "查看我的提醒列表", expectedMode: /fast-(admin-)?alert-query/ },
  { message: "查看我的复盘记录", expectedMode: /fast-(admin-)?review-records-query/ },
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
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

console.log("# WeChat Readonly Smoke");
console.log(`baseUrl: ${baseUrl}`);
console.log(`instanceId: ${instanceId}`);
console.log(`conversationId: ${conversationId}`);
console.log("");

for (const [index, item] of cases.entries()) {
  const data = await postJson("/api/testing/weixin-simulate", {
    message: item.message,
    conversationId,
    instanceId,
    accountId,
  });
  assert.ok(data.text && typeof data.text === "string", `${item.message} must return text`);
  assert.doesNotMatch(data.text, /localhost|\/api\/|Codex|Hermes|ACP|token|\.codex|src\//i, `${item.message} leaked internal text`);

  const trace = sqlite(
    `select mode || '|' || status || '|' || coalesce(elapsed_ms,'') from codex_acp_traces where conversation_id='${sqlEscape(conversationId)}' order by id desc limit 1;`
  );
  assert.ok(trace, `${item.message} must create trace`);
  const [mode, status, elapsedMs] = trace.split("|");
  assert.match(mode, item.expectedMode, `${item.message} should use readonly fast path, got ${mode}`);
  assert.equal(status, "success", `${item.message} trace must succeed`);

  console.log(`## Turn ${index + 1}`);
  console.log(`用户：${item.message}`);
  console.log(`模式：${mode}`);
  console.log(`耗时：${data.elapsedMs}ms / trace ${elapsedMs || "-"}ms`);
  console.log(`助手：${data.text.slice(0, 240).replace(/\s+/g, " ")}`);
  console.log("");
}

console.log(JSON.stringify({
  ok: true,
  cases: cases.length,
  conversationId,
  instanceId,
}));
