#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { methodChangeBackend } from "../dist/lib/method-change-backend.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const instanceId = process.env.INSTANCE_ID || "invest-agent-jr-method-tester-2";
const userId = process.env.USER_ID || "jr-method-tester-2";
const conversationId = process.env.CONVERSATION_ID || `strategy-expansion-smoke-${Date.now()}`;
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

async function proposeMethodChange() {
  return methodChangeBackend.propose({
    userId,
    instanceId,
    sourceType: "conversation_instance_expansion",
    proposedChange: changeText,
    reason: "用户明确表达了会改变技术提醒升级标准的实例级偏好，需要先作为策略实例展开候选记录。",
    affectedResource: "strategy_skill_instance_expansion",
    decisionNote: JSON.stringify({ conversationId }),
  });
}

console.log("# Strategy Instance Expansion Smoke");
console.log(`instanceId: ${instanceId}`);
console.log(`userId: ${userId}`);
console.log(`conversationId: ${conversationId}`);
console.log("");

const proposed = await proposeMethodChange();
console.log("## Propose");
console.log(`候选：${changeText}`);
console.log(JSON.stringify(proposed, null, 2));
console.log("");

assert.equal(proposed.userId, userId);
assert.equal(proposed.affectedResource, "strategy_skill_instance_expansion");
assert.equal(proposed.status, "proposed");
assert.equal(proposed.sourceType, "conversation_instance_expansion");
assert.match(proposed.proposedChange, new RegExp(marker));

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
  console.log(`Cleanup：已清理候选 ${candidateId}。`);
}

console.log(JSON.stringify({
  ok: true,
  candidateId,
  affectedResource,
  sourceType,
  cleaned: cleanup,
}));
