import { existsSync, rmSync } from "node:fs";

const smokeDbPath = "./data/experimental-smoke.db";
for (const path of [smokeDbPath, `${smokeDbPath}-shm`, `${smokeDbPath}-wal`]) {
  if (existsSync(path)) rmSync(path);
}

process.env.DB_PATH = smokeDbPath;
process.env.NODE_ENV = "test";

const { initDb, db } = await import("../dist/db/index.js");
const { watchlist, portfolio, dailyPlans, alertEvents, tradeActions, stockPlans, alerts, indicatorResults } = await import(
  "../dist/db/schema.js"
);
const { handleWatchlist } = await import("../dist/handlers/watchlist.js");
const { handlePortfolio, handlePortfolioTool } = await import("../dist/handlers/portfolio.js");
const { handleReview } = await import("../dist/handlers/review.js");
const { handleStockPlan } = await import("../dist/handlers/plan.js");
const { handleAlert } = await import("../dist/handlers/alert.js");
const { runAlertCheck } = await import("../dist/scheduler/alert-check.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

initDb();

await db.insert(watchlist).values({
  stockCode: "000001",
  stockName: "平安银行",
  addedAt: new Date().toISOString(),
  reason: "smoke test",
  source: "screening_report",
});

await db.insert(portfolio).values({
  stockCode: "000001",
  stockName: "平安银行",
  buyDate: "2026-05-24",
  status: "open",
});

await db.insert(dailyPlans).values({
  planDate: "2026-05-24",
  generatedAt: new Date().toISOString(),
  summary: "smoke plan",
  content: "smoke content",
  data: JSON.stringify({
    date: "2026-05-24",
    generatedAt: new Date().toISOString(),
    items: [
      {
        code: "000001",
        name: "平安银行",
        pool: "holding",
        support: 9.8,
        resistance: 10.8,
        observe: ["smoke observe"],
        risks: ["smoke risk"],
        confidence: "medium",
      },
    ],
  }),
});

await db.insert(alertEvents).values({
  stockCode: "000001",
  stockName: "平安银行",
  eventDate: "2026-05-24",
  eventType: "price",
  signalKey: "000001:price:up",
  message: "smoke alert",
  relationToPlan: "符合预案：接近压力位",
  severity: "medium",
  price: 10.5,
  status: "待验证",
  feedback: null,
  createdAt: new Date().toISOString(),
});

await db.insert(tradeActions).values({
  stockCode: "000001",
  action: "buy",
  price: 10,
  quantity: 100,
  notes: "smoke action",
  createdAt: new Date().toISOString(),
});

const duplicateWatchlist = await handleWatchlist("加入自选 000001 来自选股报告，理由是烟测候选");
assert(duplicateWatchlist.includes("已在自选列表中"), "watchlist duplicate path failed");

const removedPosition = await handlePortfolio("卖出 000001");
assert(removedPosition.includes("已移出持有股票池"), "portfolio sell failed");

const updateGuide = await handlePortfolioTool({ operation: "add", stocks: [] });
assert(updateGuide.includes("持有股票池") && updateGuide.includes("具体股票"), "portfolio add empty guide failed");

const readdHolding = await handlePortfolio("我持有 000001");
assert(readdHolding.includes("已更新持有股票池"), "portfolio re-add failed");

const holdOnly = await handlePortfolio("我持有 600000");
assert(holdOnly.includes("已更新持有股票池"), "portfolio holding pool failed");

const missingReview = await handleReview("查看 2099-01-01 复盘");
assert(missingReview.includes("未找到 2099-01-01"), "historical review query failed");

const setAlert = await handleAlert("设置提醒 000001 量比 2");
assert(setAlert.includes("已设置提醒"), "alert set failed");

const updateAlert = await handleAlert("设置提醒 000001 量比 3");
assert(updateAlert.includes("已更新提醒"), "alert update failed");

const alertList = await handleAlert("查看提醒列表");
assert(alertList.includes("量比 3"), "alert list compact output failed");

const offOneAlert = await handleAlert("关闭提醒 000001 量比");
assert(offOneAlert.includes("量比提醒"), "alert single indicator off failed");

const feedbackAlert = await handleAlert("000001 提醒有用");
assert(feedbackAlert.includes("已记录提醒反馈"), "alert feedback failed");

const setPlan = await handleStockPlan("设置预案 000001 支撑 9.8 压力 10.8 目标 11.5 止损 9.2 备注 smoke plan");
assert(setPlan.includes("已更新交易预案"), "stock plan set failed");

const showPlan = await handleStockPlan("预案 000001");
assert(showPlan.includes("交易预案") && showPlan.includes("目标"), "stock plan show failed");

const updateStopLoss = await handleStockPlan("更新预案 000001 止损 9.4");
assert(updateStopLoss.includes("止损位: 9.4") && updateStopLoss.includes("目标位: 11.5"), "stock plan partial update failed");

const forcedAlerts = await runAlertCheck({ force: true });
assert(Array.isArray(forcedAlerts), "forced alert check failed");

const watchRows = await db.select().from(watchlist);
const planRows = await db.select().from(dailyPlans);
const stockPlanRows = await db.select().from(stockPlans);
const alertConfigRows = await db.select().from(alerts);
const alertRows = await db.select().from(alertEvents);
const indicatorResultRows = await db.select().from(indicatorResults);
const actionRows = await db.select().from(tradeActions);
const positionRows = await db.select().from(portfolio);

assert(watchRows.length === 1 && watchRows[0].source === "screening_report", "watchlist source failed");
assert(planRows.length === 1, "daily plan insert failed");
assert(stockPlanRows.length === 1, "stock plan insert failed");
assert(alertConfigRows.length === 1 && alertConfigRows[0].enabled === false, "alert upsert/off failed");
assert(alertRows.length >= 1 && alertRows.some((row) => row.feedback === "有用"), "alert event feedback failed");
if (forcedAlerts.length > 0) {
  assert(indicatorResultRows.length >= forcedAlerts.length, "indicator result snapshot failed");
}
assert(actionRows.length >= 3 && actionRows.some((row) => row.action === "hold") && actionRows.some((row) => row.action === "sell") && actionRows.some((row) => row.action === "buy"), "trade action insert failed");
assert(positionRows.some((row) => row.stockCode === "000001"), "portfolio holding row failed");
assert(positionRows.some((row) => row.stockCode === "600000"), "holding pool row failed");

const deletePlan = await handleStockPlan("删除预案 000001");
assert(deletePlan.includes("已删除交易预案"), "stock plan delete failed");

console.log("Experimental MVP smoke test passed");
