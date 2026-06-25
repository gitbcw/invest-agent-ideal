/**
 * 烟测:微信复盘推送摘要不再直接推完整复盘。
 *
 * 用法:npm run build && node scripts/review-push-summary-smoke.mjs
 */

import { buildReviewPushSummary } from "../dist/handlers/review.js";

const review = `2026-06-23 收盘复盘

【市场概况】
上证指数 +0.40%
创业板指 -0.20%

【持仓情况】
赛轮轮胎(601058) 最新价 11.30, 今日 +1.2%, 接近支撑区。
赣锋锂业(002460) 最新价 66.20, 今日 -0.8%, 仍需观察。

【今日提醒】
P0(需确认):
  赛轮轮胎: 价格接近 11.22 支撑（待验证）
P1(关注): 2 条

【AI 分析】
事实: 今日指数分化,持仓整体波动不大。
推断: 赛轮轮胎仍以支撑位验证为核心,赣锋锂业暂不追。
建议: 明日先看价格是否站稳关键位置。

## 七、明日操作与观察
赛轮轮胎: 观点 / 理由 / 操作 / 验证点：只看 11.22 支撑是否有效。
赣锋锂业: 观点 / 理由 / 操作 / 验证点：不追涨，等量能确认。

【观点追踪表】
| 编号 | 今日观点 | 理由 | 操作建议 | 验证点 | 预计复盘时间 |
| 20260623-01 | 赛轮轮胎支撑待验证 | 接近支撑 | 观察 | 11.22 | 2026-06-26 |

【主力控盘情况】
当前未接入可靠的主力控盘/筹码集中度/逐笔成交确定性数据源，本次不据此作判断。

【预案建议】（以下股票暂无交易预案，基于近20日K线估算）
- 某股票(000001): 支撑 10 | 压力 12
可以说"按建议设置预案"快速创建（用 K 线估算值）

仅供参考，不构成投资建议`;

const summary = buildReviewPushSummary(review, "2026-06-23");

function assert(cond, label) {
  if (!cond) {
    console.error(`✗ ${label}`);
    console.error(summary);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

assert(summary.includes("【2026-06-23 复盘摘要】"), "包含日期标题");
assert(summary.includes("核心判断"), "包含核心判断");
assert(summary.includes("今日提醒"), "包含今日提醒");
assert(summary.includes("明日只看"), "包含明日只看");
assert(summary.includes("查看今日复盘"), "引导查看完整复盘");
assert(summary.length <= 1200, "摘要长度受控");
assert(!summary.includes("主力控盘情况"), "不推送主力控盘缺口章节标题");
assert(!summary.includes("当前未接入可靠的主力控盘"), "不推送低价值数据缺口");
assert(!summary.includes("按建议设置预案"), "不推送快捷创建预案话术");

const alreadySavedOnly = buildReviewPushSummary("完整复盘已保存。需要展开可以回复「查看今日复盘」。", "2026-06-23");
assert(alreadySavedOnly.includes("今日复盘已生成，核心结论见完整复盘。"), "过滤保存提示后使用摘要兜底");
assert(!alreadySavedOnly.includes("- 完整复盘已保存"), "保存提示不进入核心判断");

const looseReview = buildReviewPushSummary(`
# 2026-06-24 日复盘

今日主要指数全线收红，成长风格反弹较强。
账户仍空仓，无自选、预案和提醒，未参与反弹。
明日继续观察企稳持续性，不追涨。
完整复盘已保存。需要展开可以回复「查看今日复盘」。
`, "2026-06-24");
assert(looseReview.includes("今日主要指数全线收红"), "非标准结构时使用正文兜底生成摘要");
assert(!looseReview.includes("今日复盘已生成，核心结论见完整复盘。"), "有正文时不退化成空摘要");

console.log("\n--- summary preview ---\n");
console.log(summary);
