/**
 * 工作包 3 烟测:验证 WorkspaceStore 读写完整闭环。
 *
 * 流程:
 *   1. ensureWorkspace 初始化一个测试用户工作空间
 *   2. WorkspaceStore upsert/list/remove 各类数据
 *   3. 写入 memory/*.jsonl 并读回
 *   4. 验证写入后的 yaml 内容
 *   5. 清理测试工作空间
 */

import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { getWorkspaceStore } from "../dist/lib/workspace-store.js";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const TEST_USER = "test-user-wp-3";
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

console.log(`[1] 初始化测试工作空间 ${TEST_USER}`);
await ensureWorkspace({ userId: TEST_USER, tenantId: TEST_USER, projectId: "invest-agent" });
const store = getWorkspaceStore(TEST_USER);
console.log(`  工作空间路径: ${store.path()}`);

console.log("\n[2] 初始状态:portfolio.yaml 应有模板空结构");
const initialPortfolio = await store.readPortfolio();
assert(initialPortfolio !== null, "readPortfolio 返回非 null");
assert(Array.isArray(initialPortfolio.holdings) && initialPortfolio.holdings.length === 0, "holdings 为空数组");
assert(Array.isArray(initialPortfolio.watchlist) && initialPortfolio.watchlist.length === 0, "watchlist 为空数组");

console.log("\n[3] 持仓 CRUD");
await store.upsertHolding({
  name: "阳光电源",
  code: "300274",
  cost: 25.5,
  shares: 200,
  buy_date: "2026-06-01",
  status: "open",
  role: "core",
});
await store.upsertHolding({
  name: "宁德时代",
  code: "300750",
  cost: 180,
  shares: 50,
  buy_date: "2026-06-05",
  status: "open",
});
let holdings = await store.listHoldings();
assert(holdings.length === 2, `upsertHolding 后 holdings 长度=2(实际 ${holdings.length})`);
assert(holdings.find(h => h.code === "300274")?.name === "阳光电源", "300274 名称正确");

console.log("\n[4] 持仓 upsert 同一 code 应更新而非追加");
await store.upsertHolding({
  name: "阳光电源",
  code: "300274",
  cost: 26,
  shares: 300,
  buy_date: "2026-06-01",
  status: "open",
});
holdings = await store.listHoldings();
assert(holdings.length === 2, `重复 upsert 后 holdings 长度仍=2(实际 ${holdings.length})`);
assert(holdings.find(h => h.code === "300274")?.shares === 300, "300274 shares 更新为 300");

console.log("\n[5] 持仓移除(标记 closed)");
await store.removeHolding("300750", { markClosed: true });
const active = await store.listActiveHoldings();
assert(active.length === 1, `移除后 active holdings 长度=1(实际 ${active.length})`);
const closed = (await store.listHoldings()).find(h => h.code === "300750");
assert(closed?.status === "closed", "300750 标记为 closed");
assert(!!closed?.sell_date, "300750 自动填入 sell_date");

console.log("\n[6] 自选 CRUD");
await store.upsertWatchItem({ name: "比亚迪", code: "002594", trigger: "回调到 220", source: "manual" });
await store.upsertWatchItem({ name: "隆基绿能", code: "601012", trigger: "突破 30", source: "manual" });
const watchlist = await store.listWatchlist();
assert(watchlist.length === 2, `watchlist 长度=2(实际 ${watchlist.length})`);
await store.removeWatchItem("002594");
const watchlist2 = await store.listWatchlist();
assert(watchlist2.length === 1, `移除后 watchlist 长度=1(实际 ${watchlist2.length})`);

console.log("\n[7] 交易预案 CRUD");
await store.upsertStockPlan({
  name: "宁德时代",
  code: "300750",
  support: 170,
  resistance: 200,
  target_price: 220,
  stop_loss: 165,
  plan_type: "manual",
  notes: "回踩支撑位分批介入",
});
const plans = await store.listStockPlans();
assert(plans.length === 1, `plans 长度=1(实际 ${plans.length})`);
assert(plans[0].target_price === 220, "plan target_price=220");
assert(!!plans[0].updated_at, "plan 自动填 updated_at");

console.log("\n[8] 策略 yaml 读写");
const strategy = await store.readStrategy();
assert(strategy?.profile !== undefined, "模板 strategy.yaml 有 profile 段");
const updated = {
  ...strategy,
  profile: { ...strategy.profile, style: "稳健价值", risk_preference: "低风险" },
};
await store.writeStrategy(updated);
const strategy2 = await store.readStrategy();
assert(strategy2?.profile?.style === "稳健价值", "strategy profile.style 写入并可读");

console.log("\n[9] 方法 md 读取(模板骨架)");
const methodology = await store.readMethodology();
assert(methodology.fundamental.includes("基本面方法"), "fundamental.md 模板存在");
assert(methodology.technical.includes("技术面方法"), "technical.md 模板存在");
assert(methodology.macro.includes("宏观方法"), "macro.md 模板存在");
assert(methodology.risk.includes("风控方法"), "risk.md 模板存在");

console.log("\n[10] memory/*.jsonl 追加 + 读取");
await store.appendDecision({ id: "v1", view: "测试观点", confidence: 0.8 });
await store.appendDecision({ id: "v2", view: "另一个观点", confidence: 0.6 });
const decisions = await store.listDecisions();
assert(decisions.length === 2, `decisions 长度=2(实际 ${decisions.length})`);
assert(decisions[0].id === "v1", "首条 decision 是 v1");

console.log("\n[11] yaml 文件结构验证");
const portfolioRaw = readFileSync(path.join(store.path(), "config/portfolio.yaml"), "utf-8");
assert(portfolioRaw.includes("300274"), "portfolio.yaml 含 300274");
assert(portfolioRaw.includes("002594") === false, "portfolio.yaml 已不含 002594(已删除)");

console.log("\n[12] 未初始化的 userId 应抛 WORKSPACE_NOT_INITIALIZED");
const uninitStore = getWorkspaceStore("nonexistent-user-xyz");
let threw = false;
try {
  await uninitStore.readPortfolio();
} catch (e) {
  threw = e.message.includes("WORKSPACE_NOT_INITIALIZED");
}
assert(threw, "未初始化的工作空间抛 WORKSPACE_NOT_INITIALIZED");

console.log("\n[13] 清理");
rmSync(resolveWorkspacePath(TEST_USER), { recursive: true, force: true });
assert(!existsSync(resolveWorkspacePath(TEST_USER)), "测试工作空间已清理");

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
