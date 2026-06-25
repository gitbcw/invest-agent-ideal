#!/usr/bin/env node
import assert from "node:assert/strict";
import { reviewViewpointBackend } from "../dist/lib/review-viewpoint-backend.js";

const userId = process.env.USER_ID || "primary";
const instanceId = process.env.INSTANCE_ID || "invest-agent-primary";
const date = process.env.REVIEW_DATE || "2099-01-02";
const backtestDate = process.env.BACKTEST_REVIEW_DATE || "2099-01-05";
const marker = `vp-smoke-${Date.now()}`;
const viewpointId = `20990102-01-${marker}`;

console.log("# Review Viewpoint Smoke");
console.log(`userId: ${userId}`);
console.log(`instanceId: ${instanceId}`);
console.log(`date: ${date}`);
console.log("");

const [created] = await reviewViewpointBackend.replaceByDate({
  userId,
  instanceId,
  sourceDate: date,
  viewpoints: [{
    viewpointId,
    view: `${marker} 观察赣锋锂业回踩支撑后的量能变化`,
    reason: "支撑附近但尚未重新放量确认",
    action: "只观察，不追高",
    validation: "三个交易日内是否放量站回关键位",
    expectedReviewDate: "2099-01-05",
  }],
});
assert.ok(created, "expected review viewpoint row");
assert.equal(created.viewpointId, viewpointId);
assert.equal(created.status, "open");
assert.equal(created.expectedReviewDate, "2099-01-05");
assert.match(created.view, new RegExp(marker));

const listed = await reviewViewpointBackend.list(userId, instanceId, { limit: 100 });
assert.ok(listed.some((item) => item.viewpointId === viewpointId), "list should include saved viewpoint");

const updated = await reviewViewpointBackend.resolve({
  userId,
  instanceId,
  sourceDate: date,
  viewpointId,
  status: "pending",
  resolution: `${marker} 仍需观察后续量能和关键价位，暂不判定有效或失效`,
});
assert.ok(updated, "expected updated previous viewpoint");
assert.equal(updated.status, "pending");
assert.match(updated.resolution ?? "", new RegExp(marker));
assert.equal(updated.resolvedAt, null);

const backtestViewpointId = `20990105-01-${marker}`;
const [backtestRow] = await reviewViewpointBackend.replaceByDate({
  userId,
  instanceId,
  sourceDate: backtestDate,
  viewpoints: [{
    viewpointId: backtestViewpointId,
    view: `${marker} 新一轮观察观点`,
    reason: "回测后仍未完成验证",
    action: "继续观察",
    validation: "后续是否完成确认",
    expectedReviewDate: "2099-01-08",
  }],
});
assert.equal(backtestRow.status, "open", "expected new viewpoint row from backtest review");

await reviewViewpointBackend.replaceByDate({ userId, instanceId, sourceDate: date, viewpoints: [] });
await reviewViewpointBackend.replaceByDate({ userId, instanceId, sourceDate: backtestDate, viewpoints: [] });

console.log(JSON.stringify({
  ok: true,
  viewpointId,
  status: created.status,
  updatedStatus: updated.status,
  expectedReviewDate: created.expectedReviewDate,
  cleaned: true,
}));
