#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const userId = process.env.USER_ID || "primary";
const instanceId = process.env.INSTANCE_ID || "invest-agent-primary";
const date = process.env.REVIEW_DATE || "2099-01-02";
const backtestDate = process.env.BACKTEST_REVIEW_DATE || "2099-01-05";
const marker = `vp-smoke-${Date.now()}`;
const viewpointId = `20990102-01-${marker}`;

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
    headers: {
      "Content-Type": "application/json",
      "X-Invest-User-Id": userId,
      "X-Invest-Instance-Id": instanceId,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

const content = `${date} 收盘复盘

【核心结论】
这是一条用于验证观点闭环的测试复盘。

【观点追踪表】
| 编号 | 观点 | 依据 | 动作 | 验证条件 | 预计复盘日期 |
| --- | --- | --- | --- | --- | --- |
| ${viewpointId} | ${marker} 观察赣锋锂业回踩支撑后的量能变化 | 支撑附近但尚未重新放量确认 | 只观察，不追高 | 三个交易日内是否放量站回关键位 | 2099-01-05 |

仅供参考，不构成投资建议`;

const backtestContent = `${backtestDate} 收盘复盘

【核心结论】
这是一条用于验证上一轮观点回测同步的测试复盘。

【上一轮观点回测】
| 编号 | 状态 | 回测说明 |
| --- | --- | --- |
| ${viewpointId} | pending | ${marker} 仍需观察后续量能和关键价位，暂不判定有效或失效 |

【观点追踪表】
| 编号 | 观点 | 依据 | 动作 | 验证条件 | 预计复盘日期 |
| --- | --- | --- | --- | --- | --- |
| 20990105-01-${marker} | ${marker} 新一轮观察观点 | 回测后仍未完成验证 | 继续观察 | 后续是否完成确认 | 2099-01-08 |

仅供参考，不构成投资建议`;

console.log("# Review Viewpoint Smoke");
console.log(`baseUrl: ${baseUrl}`);
console.log(`userId: ${userId}`);
console.log(`instanceId: ${instanceId}`);
console.log(`date: ${date}`);
console.log("");

await postJson("/api/reviews/save", {
  userId,
  instanceId,
  date,
  content,
  summary: `${marker} review viewpoint smoke`,
});

const row = sqlite(
  `select viewpoint_id || '|' || status || '|' || expected_review_date || '|' || view from review_viewpoints where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and source_date='${sqlEscape(date)}' and viewpoint_id='${sqlEscape(viewpointId)}' limit 1;`
);
assert.ok(row, "expected review viewpoint row");
const [actualId, status, expectedReviewDate, view] = row.split("|");
assert.equal(actualId, viewpointId);
assert.equal(status, "open");
assert.equal(expectedReviewDate, "2099-01-05");
assert.match(view, new RegExp(marker));

const dashboard = await (await fetch(`${baseUrl}/api/dashboard?userId=${encodeURIComponent(userId)}&instanceId=${encodeURIComponent(instanceId)}`)).json();
assert.ok(Array.isArray(dashboard.reviewViewpoints), "dashboard must expose reviewViewpoints");
assert.ok(dashboard.reviewViewpoints.some((item) => item.viewpointId === viewpointId), "dashboard should include saved viewpoint");

await postJson("/api/reviews/save", {
  userId,
  instanceId,
  date: backtestDate,
  content: backtestContent,
  summary: `${marker} review viewpoint backtest smoke`,
});

const updated = sqlite(
  `select status || '|' || coalesce(resolution,'') || '|' || coalesce(resolved_at,'') from review_viewpoints where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and source_date='${sqlEscape(date)}' and viewpoint_id='${sqlEscape(viewpointId)}' limit 1;`
);
assert.ok(updated, "expected updated previous viewpoint");
const [updatedStatus, resolution, resolvedAt] = updated.split("|");
assert.equal(updatedStatus, "pending");
assert.match(resolution, new RegExp(marker));
assert.equal(resolvedAt, "");

const backtestRow = sqlite(
  `select status from review_viewpoints where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and source_date='${sqlEscape(backtestDate)}' and viewpoint_id='${sqlEscape(`20990105-01-${marker}`)}' limit 1;`
);
assert.equal(backtestRow, "open", "expected new viewpoint row from backtest review");

sqlite(`delete from review_viewpoints where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and (source_date='${sqlEscape(date)}' or source_date='${sqlEscape(backtestDate)}') and viewpoint_id like '%${sqlEscape(marker)}%';`);
sqlite(`delete from daily_plans where user_id='${sqlEscape(userId)}' and instance_id='${sqlEscape(instanceId)}' and (plan_date='${sqlEscape(date)}' or plan_date='${sqlEscape(backtestDate)}');`);

console.log(JSON.stringify({
  ok: true,
  viewpointId,
  status,
  updatedStatus,
  expectedReviewDate,
  cleaned: true,
}));
