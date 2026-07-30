import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPushSummary } from "../src/handlers/review.js";

test("review push summary keeps actionable sections and removes low-value details", () => {
  const review = `2026-06-23 收盘复盘

【市场概况】
上证指数 +0.40%

【今日提醒】
P0（需确认）：赛轮轮胎接近支撑，待验证。

## 七、明日操作与观察
赛轮轮胎：只看支撑是否有效。

【主力控盘情况】
当前未接入可靠的主力控盘确定性数据源。

【预案建议】
可以说“按建议设置预案”快速创建。`;

  const summary = buildReviewPushSummary(review, "2026-06-23");
  assert.match(summary, /【2026-06-23 复盘摘要】/);
  assert.match(summary, /核心判断/);
  assert.match(summary, /今日提醒/);
  assert.match(summary, /明日只看/);
  assert.match(summary, /查看今日复盘/);
  assert.ok(summary.length <= 1200);
  assert.doesNotMatch(summary, /主力控盘情况|按建议设置预案/);
});

test("review push summary falls back to useful prose or an explicit empty summary", () => {
  const savedOnly = buildReviewPushSummary(
    "完整复盘已保存。需要展开可以回复「查看今日复盘」。",
    "2026-06-23",
  );
  assert.match(savedOnly, /今日复盘已生成，核心结论见完整复盘/);
  assert.doesNotMatch(savedOnly, /- 完整复盘已保存/);

  const looseReview = buildReviewPushSummary(`
# 2026-06-24 日复盘

今日主要指数全线收红，成长风格反弹较强。
账户仍空仓，未参与反弹。
明日继续观察企稳持续性，不追涨。
`, "2026-06-24");
  assert.match(looseReview, /今日主要指数全线收红/);
  assert.doesNotMatch(looseReview, /今日复盘已生成，核心结论见完整复盘/);
});
