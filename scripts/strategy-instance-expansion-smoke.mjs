#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const instanceId = process.env.INSTANCE_ID || "invest-agent-jr-method-tester-2";
const userId = process.env.USER_ID || "jr-method-tester-2";
const conversationId = process.env.CONVERSATION_ID || `strategy-expansion-smoke-${Date.now()}`;
const accountId = process.env.ACCOUNT_ID || "strategy-expansion-smoke-bot";
const cleanup = process.env.CLEANUP !== "false";
const marker = `smoke-${Date.now()}`;
const changeText = `以后这个实例做技术提醒时，只有回踩到支撑并重新放量站稳，才升级成重点提醒。${marker}`;

function sqlEscape(value) {
  return String(value).replace(/'/g, "''");
}

function sqlite(sql) {
  const result = spawnSync("sqlite3", ["./data/invest-agent.db", sql], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite failed: ${sql}`);
  }
  return result.stdout.trim();
}

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

async function send(message) {
  return postJson("/api/testing/weixin-simulate", {
    message,
    conversationId,
    instanceId,
    accountId,
  });
}

console.log("# Strategy Instance Expansion Smoke");
console.log(`baseUrl: ${baseUrl}`);
console.log(`instanceId: ${instanceId}`);
console.log(`userId: ${userId}`);
console.log(`conversationId: ${conversationId}`);
console.log("");

const draftReply = await send(changeText);
console.log("## Draft");
console.log(`用户：${changeText}`);
console.log(`助手：${draftReply.text}`);
console.log("");

assert.match(draftReply.text, /变更：/);
assert.match(draftReply.text, /个性化展开/);
assert.match(draftReply.text, /不修改受保护的策略骨架/);

const pendingTask = sqlite(
  `select id || '|' || type || '|' || status || '|' || target_operation from conversation_tasks where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and conversation_id='${sqlEscape(conversationId)}' order by created_at desc limit 1;`
);
assert.ok(pendingTask, "expected pending conversation task");
const [taskId, taskType, taskStatus, targetOperation] = pendingTask.split("|");
assert.equal(taskType, "strategy_instance_expansion_draft");
assert.equal(taskStatus, "pending");
assert.equal(targetOperation, "strategy.instance_expansion.propose");

const confirmReply = await send("确认");
console.log("## Confirm");
console.log("用户：确认");
console.log(`助手：${confirmReply.text}`);
console.log("");

assert.match(confirmReply.text, /已确认写入实例展开候选/);
assert.match(confirmReply.text, /还没有修改受保护骨架/);

const completedTask = sqlite(
  `select status || '|' || coalesce(result_summary,'') from conversation_tasks where id='${sqlEscape(taskId)}';`
);
const [completedStatus, resultSummary] = completedTask.split("|");
assert.equal(completedStatus, "completed");
assert.match(resultSummary, /strategy instance expansion candidate/);

const candidate = sqlite(
  `select id || '|' || affected_resource || '|' || status || '|' || source_type || '|' || proposed_change from method_change_candidates where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and proposed_change like '%${sqlEscape(marker)}%' order by id desc limit 1;`
);
assert.ok(candidate, "expected method change candidate");
const [candidateId, affectedResource, candidateStatus, sourceType, proposedChange] = candidate.split("|");
assert.equal(affectedResource, "strategy_skill_instance_expansion");
assert.equal(candidateStatus, "proposed");
assert.equal(sourceType, "conversation_instance_expansion");
assert.match(proposedChange, new RegExp(marker));

if (cleanup) {
  sqlite(`delete from method_change_candidates where id=${Number(candidateId)};`);
  sqlite(`delete from conversation_tasks where id='${sqlEscape(taskId)}';`);
  console.log(`Cleanup：已清理候选 ${candidateId} 和任务 ${taskId}。`);
}

console.log(JSON.stringify({
  ok: true,
  taskId,
  candidateId,
  affectedResource,
  sourceType,
  cleaned: cleanup,
}));
