/**
 * Deterministic V1 strategy-simulation slice.
 *
 * This module is intentionally fixture-friendly and persistence-agnostic. A
 * published Skill supplies a serializable method definition; this executor
 * turns that definition into auditable daily decisions and a small ledger.
 */

export type SimulationSide = "buy" | "sell";
export type SimulationOrderStatus = "pending" | "filled" | "not_filled";
export type SimulationDataQuality = "exact" | "proxy" | "partial" | "missing" | "unknown";

export interface SimulationSkillDefinition {
  skillId: string;
  skillVersion: string;
  lookbackDays: number;
  buyThresholdPct: number;
  sellThresholdPct: number;
  positionWeight: number;
  costRate: number;
}

export interface SimulationBar {
  date: string;
  symbol: string;
  open: number;
  close: number;
  tradable?: boolean;
  turnover?: number;
  chipConc90?: number;
  mainNetInflow?: number;
  dataSource?: string;
  dataAsOf?: string;
  dataQuality?: SimulationDataQuality;
}

export interface SimulationFactorEvidence {
  symbol: string;
  date: string;
  turnover?: number;
  chipConc90?: number;
  mainNetInflow?: number;
  source?: string;
  asOf?: string;
  quality: SimulationDataQuality;
}

export interface SimulationOrder {
  orderId: string;
  simulationId: string;
  symbol: string;
  side: SimulationSide;
  targetDate: string;
  weight: number;
  status: SimulationOrderStatus;
  reason: string;
  fillPrice?: number;
  cost?: number;
}

export interface SimulationPosition {
  symbol: string;
  quantity: number;
  averageCost: number;
  openedAt: string;
}

export interface SimulationNavPoint {
  date: string;
  cash: number;
  positionsValue: number;
  nav: number;
  quality: "complete" | "incomplete";
}

export interface SimulationDailyReport {
  reportId: string;
  simulationId: string;
  date: string;
  status: "completed" | "blocked";
  actions: string[];
  orderIds: string[];
  settledOrderIds: string[];
  signalOrderIds: string[];
  positionSnapshot: SimulationPosition[];
  nav: SimulationNavPoint;
  factorEvidence: SimulationFactorEvidence[];
}

export interface SimulationDailyReportDocument extends SimulationDailyReport {
  orderRefs: SimulationOrder[];
}

export interface SimulationEvolutionProposalInput {
  changedField: "lookbackDays" | "buyThresholdPct" | "sellThresholdPct" | "positionWeight";
  proposedValue: number;
  hypothesis: string;
  verification: string;
}

export interface SimulationEvolutionProposal {
  proposalId: string;
  simulationId: string;
  sourceSkillVersion: string;
  status: "proposed";
  changedField: SimulationEvolutionProposalInput["changedField"];
  fromValue: number;
  proposedValue: number;
  hypothesis: string;
  verification: string;
  evidenceRefs: string[];
  methodChangeCandidateId?: string;
}

export interface SimulationWeeklyReport {
  reportId: string;
  simulationId: string;
  startDate: string;
  endDate: string;
  status: "complete" | "insufficient_evidence";
  dailyReportIds: string[];
  startNav?: number;
  endNav?: number;
  returnPct?: number;
  maxDrawdownPct?: number;
  filledOrders: number;
  notFilledOrders: number;
  missingDataDays: string[];
  evolutionProposal?: SimulationEvolutionProposal;
}

export interface SimulationRunState {
  simulationId: string;
  strategySnapshot: SimulationSkillDefinition;
  cash: number;
  positions: Map<string, SimulationPosition>;
  orders: Map<string, SimulationOrder>;
  navPoints: SimulationNavPoint[];
  reports: Map<string, SimulationDailyReport>;
  weeklyReports: Map<string, SimulationWeeklyReport>;
  barsByDate: Map<string, SimulationBar[]>;
}

function assertMethod(method: SimulationSkillDefinition): void {
  if (!method.skillId || !method.skillVersion) throw new Error("SIMULATION_SKILL_INVALID: missing skill identity");
  if (!Number.isInteger(method.lookbackDays) || method.lookbackDays < 1) throw new Error("SIMULATION_SKILL_INVALID: lookbackDays");
  if (method.buyThresholdPct < 0 || method.sellThresholdPct < 0) throw new Error("SIMULATION_SKILL_INVALID: thresholds");
  if (method.positionWeight <= 0 || method.positionWeight > 1) throw new Error("SIMULATION_SKILL_INVALID: positionWeight");
  if (method.costRate < 0 || method.costRate >= 1) throw new Error("SIMULATION_SKILL_INVALID: costRate");
}

function keyForOrder(simulationId: string, symbol: string, side: SimulationSide, targetDate: string): string {
  return `${simulationId}:${symbol}:${side}:${targetDate}`;
}

function percentChange(current: number, previous: number): number {
  return previous === 0 ? 0 : (current / previous) - 1;
}

function barFor(state: SimulationRunState, date: string, symbol: string): SimulationBar | undefined {
  return state.barsByDate.get(date)?.find((bar) => bar.symbol === symbol);
}

function factorEvidenceFor(bar: SimulationBar): SimulationFactorEvidence {
  const hasChip = bar.chipConc90 !== undefined;
  const hasFlow = bar.mainNetInflow !== undefined;
  const quality = bar.dataQuality ?? (hasChip && hasFlow ? "unknown" : "partial");
  return {
    symbol: bar.symbol,
    date: bar.date,
    turnover: bar.turnover,
    chipConc90: bar.chipConc90,
    mainNetInflow: bar.mainNetInflow,
    source: bar.dataSource,
    asOf: bar.dataAsOf,
    quality,
  };
}

function previousClose(state: SimulationRunState, date: string, symbol: string, lookbackDays: number): number | undefined {
  const dates = [...state.barsByDate.keys()].filter((candidate) => candidate < date).sort();
  const values = dates
    .map((candidate) => barFor(state, candidate, symbol)?.close)
    .filter((value): value is number => value !== undefined);
  return values.length >= lookbackDays ? values[values.length - lookbackDays] : undefined;
}

function settleOrders(state: SimulationRunState, date: string, actions: string[]): string[] {
  const orderIds: string[] = [];
  for (const order of state.orders.values()) {
    if (order.targetDate !== date || order.status !== "pending") continue;
    const bar = barFor(state, date, order.symbol);
    orderIds.push(order.orderId);
    if (!bar || bar.tradable === false || bar.open <= 0) {
      order.status = "not_filled";
      actions.push(`${order.symbol} ${order.side} 未成交：缺少可成交行情或交易状态不可用`);
      continue;
    }

    if (order.side === "buy") {
      const gross = state.cash * order.weight;
      const cost = gross * state.strategySnapshot.costRate;
      const quantity = (gross - cost) / bar.open;
      if (quantity <= 0 || gross + cost > state.cash) {
        order.status = "not_filled";
        actions.push(`${order.symbol} 买入未成交：现金不足`);
        continue;
      }
      state.cash -= gross + cost;
      state.positions.set(order.symbol, { symbol: order.symbol, quantity, averageCost: bar.open, openedAt: date });
      order.status = "filled";
      order.fillPrice = bar.open;
      order.cost = cost;
      actions.push(`${order.symbol} 买入成交 @ ${bar.open}`);
    } else {
      const position = state.positions.get(order.symbol);
      if (!position) {
        order.status = "not_filled";
        actions.push(`${order.symbol} 卖出未成交：无可卖持仓`);
        continue;
      }
      const gross = position.quantity * bar.open;
      const cost = gross * state.strategySnapshot.costRate;
      state.cash += gross - cost;
      state.positions.delete(order.symbol);
      order.status = "filled";
      order.fillPrice = bar.open;
      order.cost = cost;
      actions.push(`${order.symbol} 卖出成交 @ ${bar.open}`);
    }
  }
  return orderIds;
}

function markToMarket(state: SimulationRunState, date: string): SimulationNavPoint {
  let positionsValue = 0;
  let quality: SimulationNavPoint["quality"] = "complete";
  for (const position of state.positions.values()) {
    const bar = barFor(state, date, position.symbol);
    if (!bar) {
      quality = "incomplete";
      continue;
    }
    positionsValue += position.quantity * bar.close;
  }
  const nav = state.cash + positionsValue;
  const point = { date, cash: state.cash, positionsValue, nav, quality };
  state.navPoints.push(point);
  return point;
}

function createOrders(state: SimulationRunState, date: string, nextDate: string, actions: string[]): string[] {
  const orderIds: string[] = [];
  for (const bar of state.barsByDate.get(date) ?? []) {
    const previous = previousClose(state, date, bar.symbol, state.strategySnapshot.lookbackDays);
    if (previous === undefined) continue;
    const change = percentChange(bar.close, previous);
    const position = state.positions.get(bar.symbol);
    let side: SimulationSide | undefined;
    if (!position && change >= state.strategySnapshot.buyThresholdPct) side = "buy";
    if (position && change <= -state.strategySnapshot.sellThresholdPct) side = "sell";
    if (!side) continue;

    const orderId = keyForOrder(state.simulationId, bar.symbol, side, nextDate);
    if (state.orders.has(orderId)) continue;
    const order: SimulationOrder = {
      orderId,
      simulationId: state.simulationId,
      symbol: bar.symbol,
      side,
      targetDate: nextDate,
      weight: side === "buy" ? state.strategySnapshot.positionWeight : 1,
      status: "pending",
      reason: `${(change * 100).toFixed(2)}% 相对 ${state.strategySnapshot.lookbackDays} 日前收盘变化`,
    };
    state.orders.set(orderId, order);
    orderIds.push(orderId);
    actions.push(`${bar.symbol} ${side === "buy" ? "形成买入" : "形成卖出"}信号：${order.reason}`);
  }
  return orderIds;
}

export function createFixtureSimulation(
  simulationId: string,
  strategySnapshot: SimulationSkillDefinition,
  bars: SimulationBar[],
  initialCash = 1,
): SimulationRunState {
  assertMethod(strategySnapshot);
  if (initialCash <= 0) throw new Error("SIMULATION_INVALID: initialCash must be positive");
  const barsByDate = new Map<string, SimulationBar[]>();
  for (const bar of bars) {
    const list = barsByDate.get(bar.date) ?? [];
    list.push({ ...bar, tradable: bar.tradable ?? true });
    barsByDate.set(bar.date, list);
  }
  return {
    simulationId,
    strategySnapshot: { ...strategySnapshot },
    cash: initialCash,
    positions: new Map(),
    orders: new Map(),
    navPoints: [],
    reports: new Map(),
    weeklyReports: new Map(),
    barsByDate,
  };
}

export function runSimulationDay(state: SimulationRunState, date: string): SimulationDailyReport {
  const existing = state.reports.get(date);
  if (existing) return existing;
  const dates = [...state.barsByDate.keys()].sort();
  const index = dates.indexOf(date);
  if (index < 0) throw new Error(`SIMULATION_DATE_MISSING: ${date}`);
  const actions: string[] = [];
  const settledOrderIds = settleOrders(state, date, actions);
  const nav = markToMarket(state, date);
  const signalOrderIds = index < dates.length - 1 ? createOrders(state, date, dates[index + 1], actions) : [];
  const orderIds = [...settledOrderIds, ...signalOrderIds];
  const report: SimulationDailyReport = {
    reportId: `${state.simulationId}:daily:${date}`,
    simulationId: state.simulationId,
    date,
    status: nav.quality === "complete" ? "completed" : "blocked",
    actions,
    orderIds,
    settledOrderIds,
    signalOrderIds,
    positionSnapshot: [...state.positions.values()].map((position) => ({ ...position })),
    nav,
    factorEvidence: (state.barsByDate.get(date) ?? []).map(factorEvidenceFor),
  };
  state.reports.set(date, report);
  return report;
}

/** Structured report read model: all references resolve to the same ledger state. */
export function readDailyReport(state: SimulationRunState, date: string): SimulationDailyReportDocument {
  const report = state.reports.get(date);
  if (!report) throw new Error(`SIMULATION_REPORT_NOT_FOUND: ${date}`);
  return {
    ...report,
    orderRefs: report.orderIds
      .map((orderId) => state.orders.get(orderId))
      .filter((order): order is SimulationOrder => Boolean(order))
      .map((order) => ({ ...order })),
  };
}

export function formatDailyReport(document: SimulationDailyReportDocument): string {
  const orders = document.orderRefs.length === 0
    ? "无订单"
    : document.orderRefs.map((order) => `${order.symbol} ${order.side} ${order.status}`).join("；");
  const positions = document.positionSnapshot.length === 0
    ? "空仓"
    : document.positionSnapshot.map((position) => `${position.symbol} ${(position.quantity * 100).toFixed(2)}%`).join("；");
  return [
    `模拟日报 ${document.date}`,
    `状态：${document.status}`,
    `订单：${orders}`,
    `持仓：${positions}`,
    `净值：${document.nav.nav.toFixed(6)}（现金 ${document.nav.cash.toFixed(6)}，持仓 ${document.nav.positionsValue.toFixed(6)}）`,
    `证据质量：${document.nav.quality}`,
    `因子数据：${document.factorEvidence.length === 0 ? "无" : document.factorEvidence.map((item) => `${item.symbol} 筹码90=${item.chipConc90 ?? "缺失"} 主力净流入=${item.mainNetInflow ?? "缺失"}（${item.quality}）`).join("；")}`,
  ].join("\n");
}

function currentMethodValue(method: SimulationSkillDefinition, field: SimulationEvolutionProposalInput["changedField"]): number {
  return method[field];
}

export function generateWeeklyReport(
  state: SimulationRunState,
  startDate: string,
  endDate: string,
  proposalInput?: SimulationEvolutionProposalInput,
): SimulationWeeklyReport {
  const reportId = `${state.simulationId}:weekly:${startDate}:${endDate}`;
  const daily = [...state.reports.values()]
    .filter((report) => report.date >= startDate && report.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyReportIds = daily.map((report) => report.reportId);
  const missingDataDays = daily.filter((report) => report.nav.quality === "incomplete").map((report) => report.date);
  const filledOrders = daily.reduce((total, report) => total + report.settledOrderIds.filter((orderId) => state.orders.get(orderId)?.status === "filled").length, 0);
  const notFilledOrders = daily.reduce((total, report) => total + report.settledOrderIds.filter((orderId) => state.orders.get(orderId)?.status === "not_filled").length, 0);
  const status: SimulationWeeklyReport["status"] = daily.length >= 2 && missingDataDays.length === 0 ? "complete" : "insufficient_evidence";
  const report: SimulationWeeklyReport = {
    reportId,
    simulationId: state.simulationId,
    startDate,
    endDate,
    status,
    dailyReportIds,
    filledOrders,
    notFilledOrders,
    missingDataDays,
  };
  if (status === "complete") {
    const startNav = daily[0].nav.nav;
    const endNav = daily.at(-1)!.nav.nav;
    let peak = startNav;
    let maxDrawdown = 0;
    for (const item of daily) {
      peak = Math.max(peak, item.nav.nav);
      maxDrawdown = Math.max(maxDrawdown, peak === 0 ? 0 : (peak - item.nav.nav) / peak);
    }
    report.startNav = startNav;
    report.endNav = endNav;
    report.returnPct = startNav === 0 ? 0 : (endNav / startNav) - 1;
    report.maxDrawdownPct = maxDrawdown;
    if (proposalInput) {
      const fromValue = currentMethodValue(state.strategySnapshot, proposalInput.changedField);
      if (!Number.isFinite(proposalInput.proposedValue) || proposalInput.proposedValue === fromValue) {
        throw new Error("SIMULATION_EVOLUTION_INVALID: proposed value must change one field");
      }
      if (!proposalInput.hypothesis.trim() || !proposalInput.verification.trim()) {
        throw new Error("SIMULATION_EVOLUTION_INVALID: hypothesis and verification are required");
      }
      report.evolutionProposal = {
        proposalId: `${reportId}:proposal`,
        simulationId: state.simulationId,
        sourceSkillVersion: state.strategySnapshot.skillVersion,
        status: "proposed",
        changedField: proposalInput.changedField,
        fromValue,
        proposedValue: proposalInput.proposedValue,
        hypothesis: proposalInput.hypothesis,
        verification: proposalInput.verification,
        evidenceRefs: [...dailyReportIds],
      };
    }
  }
  state.weeklyReports.set(reportId, report);
  return report;
}

export function formatWeeklyReport(report: SimulationWeeklyReport): string {
  const lines = [
    `模拟周报 ${report.startDate} 至 ${report.endDate}`,
    `状态：${report.status}`,
    `日报：${report.dailyReportIds.length} 份，成交订单 ${report.filledOrders}，未成交订单 ${report.notFilledOrders}`,
  ];
  if (report.status === "complete") {
    lines.push(`净值：${report.startNav!.toFixed(6)} -> ${report.endNav!.toFixed(6)}，收益 ${(report.returnPct! * 100).toFixed(2)}%，最大回撤 ${(report.maxDrawdownPct! * 100).toFixed(2)}%`);
    lines.push(report.evolutionProposal ? `进化候选：只改变 ${report.evolutionProposal.changedField}，等待用户确认` : "进化候选：本周没有提出修改");
  } else {
    lines.push("结论：证据不足，继续观察，不提出策略修改");
  }
  return lines.join("\n");
}

export function summarizeSimulation(state: SimulationRunState): {
  currentNav: number;
  cumulativeReturnPct: number;
  maxDrawdownPct: number;
  filledOrders: number;
  notFilledOrders: number;
  openPositions: number;
} {
  const initialNav = state.navPoints[0]?.nav ?? 1;
  const currentNav = state.navPoints.at(-1)?.nav ?? initialNav;
  let peak = initialNav;
  let maxDrawdown = 0;
  for (const point of state.navPoints) {
    peak = Math.max(peak, point.nav);
    maxDrawdown = Math.max(maxDrawdown, peak === 0 ? 0 : (peak - point.nav) / peak);
  }
  const orders = [...state.orders.values()];
  return {
    currentNav,
    cumulativeReturnPct: (currentNav / initialNav) - 1,
    maxDrawdownPct: maxDrawdown,
    filledOrders: orders.filter((order) => order.status === "filled").length,
    notFilledOrders: orders.filter((order) => order.status === "not_filled").length,
    openPositions: state.positions.size,
  };
}
