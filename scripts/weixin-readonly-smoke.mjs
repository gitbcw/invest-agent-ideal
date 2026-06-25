#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const instanceId = process.env.INSTANCE_ID || "invest-agent-primary";
const conversationId = process.env.CONVERSATION_ID || `readonly-weixin-${Date.now()}`;
const accountId = process.env.ACCOUNT_ID || "readonly-weixin-smoke-bot";

const cases = [
  { message: "查看我的持仓" },
  { message: "查看我的自选股" },
  { message: "查看我的提醒列表" },
  { message: "查看我的复盘记录" },
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

function businessCounts() {
  return sqlite(`
    select
      (select count(*) from portfolio where instance_id='${sqlEscape(instanceId)}') || '|' ||
      (select count(*) from watchlist where instance_id='${sqlEscape(instanceId)}') || '|' ||
      (select count(*) from stock_plans where instance_id='${sqlEscape(instanceId)}') || '|' ||
      (select count(*) from alerts where instance_id='${sqlEscape(instanceId)}') || '|' ||
      (select count(*) from alert_rules where instance_id='${sqlEscape(instanceId)}');
  `);
}

console.log("# WeChat Readonly Smoke");
console.log(`baseUrl: ${baseUrl}`);
console.log(`instanceId: ${instanceId}`);
console.log(`conversationId: ${conversationId}`);
console.log("");

const beforeCounts = businessCounts();

for (const [index, item] of cases.entries()) {
  const data = await postJson("/api/testing/weixin-simulate", {
    message: item.message,
    conversationId,
    instanceId,
    accountId,
  });
  assert.ok(data.text && typeof data.text === "string", `${item.message} must return text`);
  assert.doesNotMatch(data.text, /localhost|\/api\/|Codex|Hermes|ACP|token|\.codex|src\//i, `${item.message} leaked internal text`);

  console.log(`## Turn ${index + 1}`);
  console.log(`用户：${item.message}`);
  console.log(`耗时：${data.elapsedMs}ms`);
  console.log(`助手：${data.text.slice(0, 240).replace(/\s+/g, " ")}`);
  console.log("");
}

const afterCounts = businessCounts();
assert.equal(afterCounts, beforeCounts, "readonly messages must not mutate portfolio/watchlist/plans/alerts");

console.log(JSON.stringify({
  ok: true,
  cases: cases.length,
  conversationId,
  instanceId,
  businessCounts: afterCounts,
}));
