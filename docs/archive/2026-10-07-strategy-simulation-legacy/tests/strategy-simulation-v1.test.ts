import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixtureSimulation,
  formatWeeklyReport,
  generateWeeklyReport,
  runSimulationDay,
  summarizeSimulation,
  type SimulationBar,
} from "../src/services/strategy-simulation-v1.js";

const method = {
  skillId: "strategy-simulation",
  skillVersion: "fixture-v1",
  lookbackDays: 1,
  buyThresholdPct: 0.05,
  sellThresholdPct: 0.02,
  positionWeight: 0.5,
  costRate: 0.001,
};

const bars: SimulationBar[] = [
  { date: "2026-10-01", symbol: "AAA", open: 10, close: 10 },
  { date: "2026-10-02", symbol: "AAA", open: 10.5, close: 11 },
  { date: "2026-10-03", symbol: "AAA", open: 10.8, close: 10.7 },
  { date: "2026-10-04", symbol: "AAA", open: 10.6, close: 10.6 },
];

test("fixture simulation creates signals, settles orders, and records nav", () => {
  const state = createFixtureSimulation("sim-1", method, bars);

  const day1 = runSimulationDay(state, "2026-10-01");
  assert.equal(day1.status, "completed");
  assert.equal(day1.actions.length, 0);

  const day2 = runSimulationDay(state, "2026-10-02");
  assert.ok(day2.actions.some((action) => action.includes("形成买入信号")));
  assert.equal(state.positions.size, 0);

  const day3 = runSimulationDay(state, "2026-10-03");
  assert.ok(day3.actions.some((action) => action.includes("买入成交")));
  assert.ok(day3.actions.some((action) => action.includes("形成卖出信号")));
  assert.equal(state.positions.size, 1);

  const day4 = runSimulationDay(state, "2026-10-04");
  assert.ok(day4.actions.some((action) => action.includes("卖出成交")));
  assert.equal(state.positions.size, 0);
  assert.equal(state.navPoints.length, 4);

  const summary = summarizeSimulation(state);
  assert.equal(summary.filledOrders, 2);
  assert.equal(summary.openPositions, 0);
  assert.ok(summary.currentNav > 0);
});

test("daily report references orders, positions, and the nav point from the same ledger", async () => {
  const state = createFixtureSimulation("sim-report", method, bars);
  runSimulationDay(state, "2026-10-01");
  runSimulationDay(state, "2026-10-02");
  runSimulationDay(state, "2026-10-03");
  const { formatDailyReport, readDailyReport } = await import("../src/services/strategy-simulation-v1.js");
  const report = readDailyReport(state, "2026-10-03");
  assert.equal(report.reportId, "sim-report:daily:2026-10-03");
  assert.equal(report.simulationId, "sim-report");
  assert.ok(report.settledOrderIds.length > 0);
  assert.ok(report.signalOrderIds.length > 0);
  assert.equal(report.orderRefs.length, report.orderIds.length);
  assert.equal(report.nav.date, "2026-10-03");
  assert.equal(report.positionSnapshot.length, 1);
  assert.match(formatDailyReport(report), /净值：/);
});

test("daily report preserves chip and main-flow evidence with provenance", () => {
  const state = createFixtureSimulation("sim-factors", method, [
    { date: "2026-10-01", symbol: "AAA", open: 10, close: 10, turnover: 0.12, chipConc90: 18.2, mainNetInflow: 23700000, dataSource: "qsse-qlib", dataAsOf: "2026-10-01", dataQuality: "exact" },
  ]);
  const report = runSimulationDay(state, "2026-10-01");
  assert.deepEqual(report.factorEvidence, [{
    symbol: "AAA",
    date: "2026-10-01",
    turnover: 0.12,
    chipConc90: 18.2,
    mainNetInflow: 23700000,
    source: "qsse-qlib",
    asOf: "2026-10-01",
    quality: "exact",
  }]);
});

test("simulation day is idempotent and keeps the skill snapshot immutable", () => {
  const state = createFixtureSimulation("sim-2", method, bars);
  const first = runSimulationDay(state, "2026-10-02");
  const second = runSimulationDay(state, "2026-10-02");
  assert.strictEqual(second, first);
  assert.equal(state.reports.size, 1);
  assert.equal(state.orders.size, 1);
  assert.equal(state.strategySnapshot.skillVersion, "fixture-v1");
});

test("not tradable target date records a non-fill instead of inventing a price", () => {
  const state = createFixtureSimulation("sim-3", method, [
    ...bars.slice(0, 2),
    { ...bars[2], tradable: false },
    ...bars.slice(3),
  ]);
  runSimulationDay(state, "2026-10-02");
  const report = runSimulationDay(state, "2026-10-03");
  assert.ok(report.actions.some((action) => action.includes("未成交")));
  assert.equal([...state.orders.values()][0].status, "not_filled");
  assert.equal(state.positions.size, 0);
});

test("weekly report aggregates daily evidence and keeps evolution as a proposal", () => {
  const state = createFixtureSimulation("sim-weekly", method, bars);
  for (const date of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) runSimulationDay(state, date);
  const report = generateWeeklyReport(state, "2026-10-01", "2026-10-04", {
    changedField: "sellThresholdPct",
    proposedValue: 0.03,
    hypothesis: "减少对短期噪声下跌的过早退出",
    verification: "下一轮至少运行两个完整交易日并对照同一成本口径",
  });
  assert.equal(report.status, "complete");
  assert.equal(report.dailyReportIds.length, 4);
  assert.equal(report.filledOrders, 2);
  assert.equal(report.evolutionProposal?.status, "proposed");
  assert.equal(report.evolutionProposal?.fromValue, 0.02);
  assert.equal(state.strategySnapshot.sellThresholdPct, 0.02);
  assert.match(formatWeeklyReport(report), /等待用户确认/);
});

test("weekly report refuses to produce an evolution proposal with insufficient evidence", () => {
  const state = createFixtureSimulation("sim-weekly-short", method, bars);
  runSimulationDay(state, "2026-10-01");
  const report = generateWeeklyReport(state, "2026-10-01", "2026-10-01", {
    changedField: "buyThresholdPct",
    proposedValue: 0.06,
    hypothesis: "不变",
    verification: "继续观察",
  });
  assert.equal(report.status, "insufficient_evidence");
  assert.equal(report.evolutionProposal, undefined);
});
