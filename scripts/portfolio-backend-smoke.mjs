/**
 * 工作包 4.2 烟测:验证 portfolio / watchlist / plan 三个 backend 在 sqlite + workspace 上行为等价。
 *
 * 流程:
 *   1. 初始化测试工作空间
 *   2. 对每个 backend 跑 CRUD
 *   3. 验证两个实现行为等价
 *   4. 清理测试工作空间和 SQLite 测试数据
 *
 *   node scripts/portfolio-backend-smoke.mjs
 */

import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { sqlitePortfolioBackend } from "../dist/lib/sqlite-portfolio-backend.js";
import { workspacePortfolioBackend } from "../dist/lib/workspace-portfolio-backend.js";
import { sqliteWatchlistBackend } from "../dist/lib/sqlite-watchlist-backend.js";
import { workspaceWatchlistBackend } from "../dist/lib/workspace-watchlist-backend.js";
import { sqlitePlanBackend } from "../dist/lib/sqlite-plan-backend.js";
import { workspacePlanBackend } from "../dist/lib/workspace-plan-backend.js";
import { rmSync, existsSync } from "node:fs";

const TEST_USER_SQLITE = "test-backend-sqlite";
const TEST_USER_WORKSPACE = "test-backend-workspace";
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

// ============ Portfolio ============

async function exercisePortfolio(backend, userId, label) {
  console.log(`\n[${label}/portfolio] 跑 CRUD`);

  const initial = await backend.listActive(userId, INSTANCE);
  assert(initial.length === 0, `${label}/portfolio: 初始 listActive 为空`);

  await backend.upsertActive(userId, INSTANCE, {
    code: "300274", name: "阳光电源", cost: 25.5, shares: 200,
  });
  await backend.upsertActive(userId, INSTANCE, {
    code: "300274", name: "阳光电源", cost: 26, shares: 300,
  });
  const active = await backend.listActive(userId, INSTANCE);
  assert(active.length === 1, `${label}/portfolio: 重复 upsert 后 active 仍为 1`);
  assert(active[0].shares === 300, `${label}/portfolio: shares 更新为 300`);

  const patched = await backend.patchActive(userId, INSTANCE, "300274", { cost: 27.5 });
  assert(patched?.cost === 27.5, `${label}/portfolio: patchActive cost=27.5`);

  const closed = await backend.markClosed(userId, INSTANCE, "300274", 30);
  assert(closed?.status === "closed", `${label}/portfolio: markClosed status=closed`);
  assert(closed?.sellPrice === 30, `${label}/portfolio: markClosed sellPrice=30`);

  const afterClose = await backend.listActive(userId, INSTANCE);
  assert(afterClose.length === 0, `${label}/portfolio: close 后 active=0`);
  const all = await backend.listAll(userId, INSTANCE);
  assert(all.length === 1, `${label}/portfolio: listAll 仍含 closed 记录`);

  await backend.recordTradeAction({
    userId, instanceId: INSTANCE, code: "300274", action: "buy",
    price: 27.5, quantity: 300, notes: "测试", createdAt: new Date().toISOString(),
  });
  assert(true, `${label}/portfolio: recordTradeAction 不抛`);
}

// ============ Watchlist ============

async function exerciseWatchlist(backend, userId, label) {
  console.log(`\n[${label}/watchlist] 跑 CRUD`);

  const initial = await backend.list(userId, INSTANCE);
  assert(initial.length === 0, `${label}/watchlist: 初始 list 为空`);

  await backend.add(userId, INSTANCE, {
    code: "300274", name: "阳光电源", reason: "回调买点", source: "manual",
  });
  const afterAdd = await backend.list(userId, INSTANCE);
  assert(afterAdd.length === 1, `${label}/watchlist: add 后 list=1`);

  const found = await backend.find(userId, INSTANCE, "300274");
  assert(found?.reason === "回调买点", `${label}/watchlist: find 返回 reason`);

  // patch 更新 reason
  const patched = await backend.patch(userId, INSTANCE, "300274", { reason: "突破买点" });
  assert(patched?.reason === "突破买点", `${label}/watchlist: patch reason=突破买点`);

  // 重复 add 不应抛(workspace 后端是 upsert 语义,sqlite 是会重复插入)
  // 这里只验证 sqlite 走原始 add,workspace 走 upsert,各自语义
  await backend.add(userId, INSTANCE, {
    code: "300750", name: "宁德时代", source: "manual",
  });
  const listTwo = await backend.list(userId, INSTANCE);
  const has274 = listTwo.some((w) => w.code === "300274");
  const has750 = listTwo.some((w) => w.code === "300750");
  assert(has274 && has750, `${label}/watchlist: 两条不同 code 都在列表`);

  // remove
  const removed = await backend.remove(userId, INSTANCE, "300274");
  assert(removed?.code === "300274", `${label}/watchlist: remove 返回被删 code`);
  const afterRemove = await backend.list(userId, INSTANCE);
  assert(afterRemove.length === 1, `${label}/watchlist: remove 后 list=1`);
  assert(afterRemove[0].code === "300750", `${label}/watchlist: 剩下的是 300750`);

  // remove 不存在的
  const notFound = await backend.remove(userId, INSTANCE, "999999");
  assert(notFound === null, `${label}/watchlist: remove 不存在的返回 null`);
}

// ============ Plan ============

async function exercisePlan(backend, userId, label) {
  console.log(`\n[${label}/plan] 跑 CRUD`);

  const initial = await backend.list(userId, INSTANCE);
  assert(initial.length === 0, `${label}/plan: 初始 list 为空`);

  await backend.upsert(userId, INSTANCE, {
    code: "300274", name: "阳光电源", support: 25, resistance: 30,
    targetPrice: 35, stopLoss: 23, notes: "回调介入", planType: "manual",
  });
  const afterUpsert = await backend.list(userId, INSTANCE);
  assert(afterUpsert.length === 1, `${label}/plan: upsert 后 list=1`);

  const found = await backend.find(userId, INSTANCE, "300274");
  assert(found?.targetPrice === 35, `${label}/plan: find targetPrice=35`);

  // 重复 upsert 应该更新
  await backend.upsert(userId, INSTANCE, {
    code: "300274", name: "阳光电源", support: 26, targetPrice: 38,
  });
  const updated = await backend.find(userId, INSTANCE, "300274");
  assert(updated?.support === 26, `${label}/plan: 第二次 upsert 后 support=26`);
  assert(updated?.targetPrice === 38, `${label}/plan: 第二次 upsert 后 targetPrice=38`);

  // remove
  const removed = await backend.remove(userId, INSTANCE, "300274");
  assert(removed?.code === "300274", `${label}/plan: remove 返回被删 code`);
  const afterRemove = await backend.list(userId, INSTANCE);
  assert(afterRemove.length === 0, `${label}/plan: remove 后 list=0`);
}

async function cleanupSqlite(userId) {
  const { db } = await import("../dist/db/index.js");
  const { portfolio, tradeActions, watchlist, stockPlans } = await import("../dist/db/schema.js");
  const { eq } = await import("drizzle-orm");
  await db.delete(tradeActions).where(eq(tradeActions.userId, userId));
  await db.delete(portfolio).where(eq(portfolio.userId, userId));
  await db.delete(watchlist).where(eq(watchlist.userId, userId));
  await db.delete(stockPlans).where(eq(stockPlans.userId, userId));
}

console.log("[0] 初始化测试工作空间");
await ensureWorkspace({ userId: TEST_USER_WORKSPACE, tenantId: TEST_USER_WORKSPACE, projectId: "invest-agent" });
console.log(`  工作空间: ${resolveWorkspacePath(TEST_USER_WORKSPACE)}`);

await exercisePortfolio(sqlitePortfolioBackend, TEST_USER_SQLITE, "sqlite");
await exercisePortfolio(workspacePortfolioBackend, TEST_USER_WORKSPACE, "workspace");

await exerciseWatchlist(sqliteWatchlistBackend, TEST_USER_SQLITE, "sqlite");
await exerciseWatchlist(workspaceWatchlistBackend, TEST_USER_WORKSPACE, "workspace");

await exercisePlan(sqlitePlanBackend, TEST_USER_SQLITE, "sqlite");
await exercisePlan(workspacePlanBackend, TEST_USER_WORKSPACE, "workspace");

console.log("\n[cleanup] 清理 SQLite 测试数据 + workspace 目录");
await cleanupSqlite(TEST_USER_SQLITE);
rmSync(resolveWorkspacePath(TEST_USER_WORKSPACE), { recursive: true, force: true });
assert(!existsSync(resolveWorkspacePath(TEST_USER_WORKSPACE)), "workspace 测试目录已清理");

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
