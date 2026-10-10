import { sqlite } from "../db/index.js";
import type { UserScope } from "./agent-space/core.js";
import {
  createFixtureSimulation,
  type SimulationBar,
  type SimulationRunState,
  type SimulationSkillDefinition,
} from "./strategy-simulation-v1.js";
import { methodChangeBackend } from "../lib/method-change-backend.js";
import { callServiceTool, type ServiceToolContext } from "../mcp/service-tools-core.js";

interface PersistedState {
  simulationId: string;
  strategySnapshot: SimulationSkillDefinition;
  cash: number;
  positions: Array<SimulationRunState["positions"] extends Map<string, infer V> ? V : never>;
  orders: Array<SimulationRunState["orders"] extends Map<string, infer V> ? V : never>;
  navPoints: SimulationRunState["navPoints"];
  reports: Array<SimulationRunState["reports"] extends Map<string, infer V> ? V : never>;
  weeklyReports: Array<SimulationRunState["weeklyReports"] extends Map<string, infer V> ? V : never>;
  bars: SimulationBar[];
}

function nowIso(): string { return new Date().toISOString(); }

function serialize(state: SimulationRunState): PersistedState {
  return {
    simulationId: state.simulationId,
    strategySnapshot: state.strategySnapshot,
    cash: state.cash,
    positions: [...state.positions.values()],
    orders: [...state.orders.values()],
    navPoints: state.navPoints,
    reports: [...state.reports.values()],
    weeklyReports: [...state.weeklyReports.values()],
    bars: [...state.barsByDate.values()].flat(),
  };
}

function deserialize(raw: PersistedState): SimulationRunState {
  const state = createFixtureSimulation(raw.simulationId, raw.strategySnapshot, raw.bars, raw.navPoints[0]?.nav ?? 1);
  state.cash = raw.cash;
  state.positions = new Map(raw.positions.map((position) => [position.symbol, position]));
  state.orders = new Map(raw.orders.map((order) => [order.orderId, order]));
  state.navPoints = raw.navPoints;
  state.reports = new Map(raw.reports.map((report) => [report.date, report]));
  state.weeklyReports = new Map((raw.weeklyReports ?? []).map((report) => [report.reportId, report]));
  return state;
}

export interface StrategySimulationLedgerScope extends UserScope {
  simulationId: string;
  parentSimulationId?: string;
  skillId: string;
  skillVersion: string;
  strategyVersionId: string;
}

export function saveSimulationLedger(scope: StrategySimulationLedgerScope, state: SimulationRunState, status = "running"): void {
  if (state.simulationId !== scope.simulationId) throw new Error("SIMULATION_SCOPE_MISMATCH: simulation id");
  if (state.strategySnapshot.skillId !== scope.skillId || state.strategySnapshot.skillVersion !== scope.skillVersion) {
    throw new Error("SIMULATION_SNAPSHOT_MISMATCH: skill snapshot");
  }
  const existing = sqlite.prepare("SELECT user_id, project_id, instance_id FROM strategy_simulations WHERE simulation_id=?").get(scope.simulationId) as {
    user_id?: string;
    project_id?: string;
    instance_id?: string;
  } | undefined;
  if (existing && (existing.user_id !== scope.userId || existing.project_id !== scope.projectId || existing.instance_id !== scope.instanceId)) {
    throw new Error("SIMULATION_SCOPE_MISMATCH: owner");
  }
  const now = nowIso();
  const serialized = JSON.stringify(serialize(state));
  sqlite.prepare(`
    INSERT INTO strategy_simulations
      (simulation_id,user_id,project_id,instance_id,skill_id,skill_version,strategy_version_id,parent_simulation_id,status,snapshot_json,state_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(simulation_id) DO UPDATE SET
      status=excluded.status,
      snapshot_json=excluded.snapshot_json,
      state_json=excluded.state_json,
      updated_at=excluded.updated_at
  `).run(
    scope.simulationId,
    scope.userId,
    scope.projectId,
    scope.instanceId,
    scope.skillId,
    scope.skillVersion,
    scope.strategyVersionId,
    scope.parentSimulationId ?? null,
    status,
    JSON.stringify(state.strategySnapshot),
    serialized,
    now,
    now,
  );
}

export function loadSimulationLedger(scope: Pick<StrategySimulationLedgerScope, "userId" | "projectId" | "instanceId" | "simulationId">): SimulationRunState {
  const row = sqlite.prepare(`
    SELECT state_json FROM strategy_simulations
    WHERE simulation_id=? AND user_id=? AND project_id=? AND instance_id=?
  `).get(scope.simulationId, scope.userId, scope.projectId, scope.instanceId) as { state_json?: string } | undefined;
  if (!row?.state_json) throw new Error("SIMULATION_NOT_FOUND");
  return deserialize(JSON.parse(row.state_json) as PersistedState);
}

export function createAndSaveSimulationLedger(
  scope: StrategySimulationLedgerScope,
  method: SimulationSkillDefinition,
  bars: SimulationBar[],
  initialCash = 1,
): SimulationRunState {
  const state = createFixtureSimulation(scope.simulationId, method, bars, initialCash);
  saveSimulationLedger(scope, state);
  return state;
}

export function createNextSimulationAfterAdoption(input: {
  previousSimulationId: string;
  simulationId: string;
  userId: string;
  projectId: string;
  instanceId: string;
  skillId: string;
  skillVersion: string;
  strategyVersionId: string;
  method: SimulationSkillDefinition;
  bars: SimulationBar[];
}): SimulationRunState {
  return createAndSaveSimulationLedger({
    simulationId: input.simulationId,
    parentSimulationId: input.previousSimulationId,
    userId: input.userId,
    projectId: input.projectId,
    instanceId: input.instanceId,
    skillId: input.skillId,
    skillVersion: input.skillVersion,
    strategyVersionId: input.strategyVersionId,
  }, input.method, input.bars, 1);
}

/**
 * Projects a weekly simulation proposal into the existing method-change
 * candidate ledger. This only creates a proposed candidate; adoption still
 * requires the normal confirmation/apply flow.
 */
export async function proposeSimulationEvolution(
  scope: Pick<StrategySimulationLedgerScope, "userId" | "instanceId">,
  report: import("./strategy-simulation-v1.js").SimulationWeeklyReport,
): Promise<string> {
  const proposal = report.evolutionProposal;
  if (!proposal) throw new Error("SIMULATION_EVOLUTION_MISSING");
  if (proposal.methodChangeCandidateId) return proposal.methodChangeCandidateId;
  const candidate = await methodChangeBackend.propose({
    userId: scope.userId,
    instanceId: scope.instanceId,
    sourceReviewId: report.reportId,
    sourceType: "strategy_simulation",
    proposedChange: `将 ${proposal.changedField} 从 ${proposal.fromValue} 调整为 ${proposal.proposedValue}`,
    reason: `${proposal.hypothesis}。证据：${proposal.evidenceRefs.join(", ")}。验证：${proposal.verification}`,
    affectedResource: "strategy",
  });
  proposal.methodChangeCandidateId = candidate.id;
  return candidate.id;
}

export interface SimulationEvolutionApplyRequest {
  operation: "method_changes.apply";
  payload: {
    candidateId: string;
    expectedLastConfirmedAt: string | null;
    strategyPatch: Record<string, unknown>;
  };
  summary: string;
  context: Pick<ServiceToolContext, "userId" | "instanceId" | "projectId" | "conversationId">;
}

/** Build the exact confirmation request consumed by method_changes.apply. */
export function buildSimulationEvolutionApplyRequest(input: {
  report: import("./strategy-simulation-v1.js").SimulationWeeklyReport;
  expectedLastConfirmedAt: string | null;
  strategyPatch: Record<string, unknown>;
  context: SimulationEvolutionApplyRequest["context"];
}): SimulationEvolutionApplyRequest {
  const proposal = input.report.evolutionProposal;
  if (!proposal?.methodChangeCandidateId) throw new Error("SIMULATION_EVOLUTION_CANDIDATE_NOT_REGISTERED");
  if (!input.strategyPatch || Object.keys(input.strategyPatch).length === 0) throw new Error("SIMULATION_EVOLUTION_PATCH_EMPTY");
  return {
    operation: "method_changes.apply",
    payload: {
      candidateId: proposal.methodChangeCandidateId,
      expectedLastConfirmedAt: input.expectedLastConfirmedAt,
      strategyPatch: input.strategyPatch,
    },
    summary: `确认采用模拟周报候选：${proposal.changedField}`,
    context: input.context,
  };
}

export async function requestSimulationEvolutionAdoption(input: {
  report: import("./strategy-simulation-v1.js").SimulationWeeklyReport;
  expectedLastConfirmedAt: string | null;
  strategyPatch: Record<string, unknown>;
  context: ServiceToolContext;
}): Promise<{ confirmationId: string; preview?: Record<string, unknown> }> {
  const request = buildSimulationEvolutionApplyRequest(input);
  return await callServiceTool("confirmations.request", {
    operation: request.operation,
    payload: request.payload,
    summary: request.summary,
  }, request.context) as { confirmationId: string; preview?: Record<string, unknown> };
}

export async function applyConfirmedSimulationEvolution(input: {
  report: import("./strategy-simulation-v1.js").SimulationWeeklyReport;
  expectedLastConfirmedAt: string | null;
  strategyPatch: Record<string, unknown>;
  confirmationId: string;
  decisionNote?: string;
  context: ServiceToolContext;
}): Promise<Record<string, unknown>> {
  const request = buildSimulationEvolutionApplyRequest(input);
  return await callServiceTool("method_changes.apply", {
    confirmedByUser: true,
    confirmationId: input.confirmationId,
    ...request.payload,
    decisionNote: input.decisionNote || "用户确认采用模拟进化候选",
    summary: request.summary,
  }, request.context) as Record<string, unknown>;
}
