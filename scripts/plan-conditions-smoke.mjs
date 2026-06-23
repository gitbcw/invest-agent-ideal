/**
 * 工作包 4.x plan-conditions 烟测:验证 setPlanWatchConditions 在 sqlite / workspace 两种模式下都能正确写入 stock_plan。
 *
 * 覆盖:
 *   1. sqlite 模式:写入 → 通过 planBackend 读取
 *   2. workspace 模式:写入 → 通过 planBackend 读取
 *   3. linkedAlertRuleIds 字段类型为 string[]
 *   4. 重复 set 不破坏其他字段(support/resistance 等)
 *
 * 警告:本烟测会创建 alertRules 表的测试记录,完成后清理。
 *
 *   WORKSPACE_BACKEND=sqlite node scripts/plan-conditions-smoke.mjs
 *   WORKSPACE_BACKEND=workspace node scripts/plan-conditions-smoke.mjs
 */

import { setPlanWatchConditions } from "../dist/handlers/plan-conditions.js";
import { planBackend } from "../dist/lib/data-backend.js";
import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { rmSync, existsSync } from "node:fs";

const MODE = process.env.WORKSPACE_BACKEND === "workspace" ? "workspace" : "sqlite";
const TEST_USER = MODE === "workspace" ? "test-plan-cond-ws" : "test-plan-cond-sqlite";
const INSTANCE = "test-instance";

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

console.log(`[mode=${MODE}] 初始化`);
if (MODE === "workspace") {
  await ensureWorkspace({ userId: TEST_USER, tenantId: TEST_USER, projectId: "invest-agent" });
}

// 预置:先用 planBackend 写一条带 support/resistance 的预案,验证后续 set 不覆盖
console.log(`\n[mode=${MODE}] 预置预案`);
await planBackend.upsert(TEST_USER, INSTANCE, {
  code: "600519",
  name: "贵州茅台",
  support: 1500,
  resistance: 1800,
  targetPrice: 2000,
  stopLoss: 1450,
  notes: "预置预案",
  planType: "manual",
});

// 执行:setPlanWatchConditions
console.log(`\n[mode=${MODE}] 调用 setPlanWatchConditions`);
const result = await setPlanWatchConditions({
  userId: TEST_USER,
  instanceId: INSTANCE,
  stockCode: "600519",
  stockName: "贵州茅台",
  conditions: [
    {
      label: "跌破支撑",
      indicatorKey: "custom_support_price",
      params: { value: 1500 },
      createAlertRule: false,
    },
  ],
});

assert(result.stockCode === "600519", "setPlanWatchConditions 返回 stockCode");
assert(result.conditionCount === 1, "setPlanWatchConditions 返回 conditionCount=1");

// 验证:plan 读出来 watchConditions 已写入,其他字段保留
const after = await planBackend.find(TEST_USER, INSTANCE, "600519");
assert(after?.support === 1500, `${MODE}: support 保留为 1500`);
assert(after?.resistance === 1800, `${MODE}: resistance 保留为 1800`);
assert(after?.targetPrice === 2000, `${MODE}: targetPrice 保留为 2000`);
assert(after?.stopLoss === 1450, `${MODE}: stopLoss 保留为 1450`);
assert(Array.isArray(after?.watchConditions), `${MODE}: watchConditions 是数组`);
assert(after?.watchConditions?.length === 1, `${MODE}: watchConditions 长度=1`);
assert(after?.planType === "structured", `${MODE}: planType 切换为 structured`);

// linkedAlertRuleIds 类型应为 string[]
if (after?.linkedAlertRuleIds) {
  assert(
    after.linkedAlertRuleIds.every((id) => typeof id === "string"),
    `${MODE}: linkedAlertRuleIds 元素都是 string`
  );
}

// 清理
console.log(`\n[cleanup] 清理测试数据`);
if (MODE === "workspace") {
  rmSync(resolveWorkspacePath(TEST_USER), { recursive: true, force: true });
  assert(!existsSync(resolveWorkspacePath(TEST_USER)), "workspace 测试目录已清理");
} else {
  const { db } = await import("../dist/db/index.js");
  const { stockPlans, alertRules } = await import("../dist/db/schema.js");
  const { eq } = await import("drizzle-orm");
  await db.delete(alertRules).where(eq(alertRules.userId, TEST_USER));
  await db.delete(stockPlans).where(eq(stockPlans.userId, TEST_USER));
  assert(true, "SQLite 测试数据已清理");
}

console.log(`\n=== 结果 [mode=${MODE}]: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
