#!/usr/bin/env node
/**
 * 烟测:主动推送不能串到错误用户/会话,调度推送不能插队用户正在等待的复杂分析。
 *
 * 用法:npm run build && node scripts/push-routing-contract-smoke.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const weixinSource = readFileSync("src/channels/weixin-mobile.ts", "utf-8");
const queueSource = readFileSync("src/services/push-queue.ts", "utf-8");
const schedulerSource = readFileSync("src/scheduler/index.ts", "utf-8");

assert.ok(
  weixinSource.includes("eq(channelIdentities.userId, userId)"),
  "instance push routing must also constrain channel identity by userId"
);
assert.ok(
  weixinSource.includes("markWeixinComplexTaskActive"),
  "complex ACK path must mark active WeChat analysis"
);
assert.ok(
  weixinSource.includes("clearWeixinComplexTaskActive"),
  "complex task finally block must clear active WeChat analysis"
);
assert.ok(
  queueSource.includes("hasActiveWeixinComplexTask"),
  "push queue must check active WeChat analysis before sending scheduler pushes"
);
assert.ok(
  queueSource.includes("DEFERABLE_SOURCES") && queueSource.includes("\"scheduler\""),
  "only deferable scheduler-like pushes should be delayed"
);
assert.ok(
  queueSource.includes("user has active complex analysis"),
  "deferred scheduler pushes should record the active-analysis reason"
);
const schedulableUserIdsFunction = schedulerSource.match(/async function getSchedulableUserIds\(\)[\s\S]*?\n}\n/)?.[0] ?? "";
assert.ok(schedulableUserIdsFunction, "getSchedulableUserIds function must exist");
assert.ok(
  schedulableUserIdsFunction.includes("from(channelIdentities)"),
  "review scheduler user scan should be based on WeChat channel identities"
);
assert.ok(
  !schedulableUserIdsFunction.includes("from(users)"),
  "review scheduler user scan must not include every active test/eval user"
);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "push routing is constrained by userId + instanceId",
    "active complex analysis is marked and cleared",
    "scheduler pushes are deferred while user waits for analysis",
    "review scheduler avoids all-active-user fanout",
  ],
}, null, 2));
