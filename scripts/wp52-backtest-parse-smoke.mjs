// WP5.2 烟测:验证周复盘报告里的"日复盘观点回测"表格能被 extractViewpointResolutions 解析回填。
//
// 这是 WP5.2 唯一需要的代码层验证:确保 skill 让 Codex 输出的报告格式,
// 能被现有 syncViewpointResolutions 流程识别。
//
// 不测代码逻辑(runWeeklyBacktest 不存在),因为按方法论 WP5.2 的"回测"由 Codex 全权处理。

import { db } from "../dist/db/index.js";
import { reviewViewpoints } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { reviewViewpointBackend } from "../dist/lib/review-viewpoint-backend.js";
import { syncViewpointResolutions } from "../dist/handlers/review.js";

const USER = "smoke-wp52";
const INSTANCE = "smoke-wp52";

// 清理 sqlite 测试数据
await db.delete(reviewViewpoints).where(eq(reviewViewpoints.userId, USER));

// 模拟本周已有 3 条观点
await reviewViewpointBackend.replaceByDate({
  userId: USER, instanceId: INSTANCE, sourceDate: "2026-06-15",
  viewpoints: [
    {
      viewpointId: "v1", view: "看多茅台", reason: "资金回流", action: "持有",
      validation: "突破前高", expectedReviewDate: "2026-06-22",
      invalidationSignals: ["跌破 1700", "MACD 死叉"], confidence: "high",
    },
    {
      viewpointId: "v2", view: "看空白酒板块", reason: "库存高位", action: "减仓",
      validation: "跌破支撑", expectedReviewDate: "2026-06-22",
      confidence: "medium",
    },
    {
      viewpointId: "v3", view: "关注新能源", reason: "政策利好", action: "观察",
      validation: "放量突破", expectedReviewDate: "2026-06-29",
      confidence: "low",
    },
  ],
});

// 模拟 Codex 在周复盘报告里输出的"日复盘观点回测"段
// 表格列顺序严格按 weekly-review skill 模板:编号 | 判定 | 日期 | 原观点 | 失效信号 | 当周行情 | 依据
const weeklyReportContent = `# 2026-06-15 至 2026-06-22 周复盘

## 一、本周核心结论

- 茅台跌破 1700,触发 v1 失效信号。

## 二、本周市场与持仓表现

(略)

## 三、日复盘观点回测

| 编号 | 判定 | 日期 | 原观点 | 失效信号 | 当周行情 | 依据 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| v1 | invalidated | 2026-06-15 | 看多茅台 | 跌破 1700;MACD 死叉 | 1685→1688,最低 1680 | 跌破 1700(最低 1680),MACD 死叉已形成 |
| v2 | pending | 2026-06-15 | 看空白酒板块 | (未声明) | 板块无对应单一标的 | 无对应标的,需用户手动判断 |
| v3 | pending | 2026-06-15 | 关注新能源 | (未声明) | 未到复核日期 | 等待 2026-06-29 复核 |

## 四、提醒与信号质量

(略)
`;

// 调用 syncViewpointResolutions,内部会跑 extractViewpointResolutions + reviewViewpointBackend.resolve
// 注意:不调 syncReviewViewpoints(会触发 replaceByDate 清空当天观点,污染测试)
await syncViewpointResolutions(USER, INSTANCE, weeklyReportContent);

// 验证:v1 应被回填为 invalidated,v2/v3 应该被回填为 pending
const after = await reviewViewpointBackend.list(USER, INSTANCE, {});
console.log("after resolutions:");
for (const r of after) {
  console.log(`  ${r.viewpointId} (${r.sourceDate}): status=${r.status}, resolution=${r.resolution?.slice(0, 60)}...`);
}

const v1 = after.find((r) => r.viewpointId === "v1");
if (!v1 || v1.status !== "invalidated") {
  throw new Error(`v1 should be invalidated, got ${v1?.status}`);
}
if (!v1.resolution?.includes("自动回测") && !v1.resolution?.includes("跌破 1700")) {
  throw new Error(`v1 resolution should contain evidence, got: ${v1?.resolution}`);
}

const v2 = after.find((r) => r.viewpointId === "v2");
if (!v2 || v2.status !== "pending") {
  throw new Error(`v2 should be pending, got ${v2?.status}`);
}

// v3 应该被回填为 pending(虽然 expectedReviewDate 没到,但 LLM 在表格里判了 pending)
const v3 = after.find((r) => r.viewpointId === "v3" && r.sourceDate === "2026-06-15");
if (!v3 || v3.status !== "pending") {
  throw new Error(`v3 should be pending, got ${v3?.status}`);
}

console.log("\n✓ WP5.2 解析回填烟测通过");

// 清理
await db.delete(reviewViewpoints).where(eq(reviewViewpoints.userId, USER));
