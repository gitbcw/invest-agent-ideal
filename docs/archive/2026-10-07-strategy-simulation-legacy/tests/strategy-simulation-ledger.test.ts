import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("simulation ledger persists a scoped skill snapshot and can resume the fixture run", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-simulation-ledger-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
  try {
    const { initDb } = await import("../src/db/index.js");
    initDb();
    const { buildSimulationEvolutionApplyRequest, createAndSaveSimulationLedger, loadSimulationLedger, proposeSimulationEvolution, saveSimulationLedger } = await import("../src/services/strategy-simulation-ledger.js");
    const { runSimulationDay } = await import("../src/services/strategy-simulation-v1.js");
    const scope = {
      simulationId: "sim-ledger-1",
      userId: "ledger-user",
      projectId: "invest-agent",
      instanceId: "ledger-instance",
      skillId: "strategy-simulation",
      skillVersion: "fixture-v1",
      strategyVersionId: "strategy-v1",
    };
    const method = { skillId: "strategy-simulation", skillVersion: "fixture-v1", lookbackDays: 1, buyThresholdPct: 0.05, sellThresholdPct: 0.02, positionWeight: 0.5, costRate: 0.001 };
    const bars = [
      { date: "2026-10-01", symbol: "AAA", open: 10, close: 10 },
      { date: "2026-10-02", symbol: "AAA", open: 10.5, close: 11 },
      { date: "2026-10-03", symbol: "AAA", open: 10.8, close: 10.7 },
    ];
    const state = createAndSaveSimulationLedger(scope, method, bars);
    runSimulationDay(state, "2026-10-02");
    saveSimulationLedger(scope, state);
    const resumed = loadSimulationLedger(scope);
    assert.equal(resumed.strategySnapshot.skillVersion, "fixture-v1");
    assert.equal(resumed.reports.size, 1);
    assert.equal(resumed.orders.size, 1);
    assert.throws(
      () => loadSimulationLedger({ ...scope, userId: "other-user" }),
      /SIMULATION_NOT_FOUND/,
    );
    assert.throws(
      () => saveSimulationLedger({ ...scope, userId: "other-user" }, state),
      /SIMULATION_SCOPE_MISMATCH/,
    );

    const { generateWeeklyReport } = await import("../src/services/strategy-simulation-v1.js");
    runSimulationDay(resumed, "2026-10-03");
    const weekly = generateWeeklyReport(resumed, "2026-10-02", "2026-10-03", {
      changedField: "sellThresholdPct",
      proposedValue: 0.03,
      hypothesis: "减少噪声退出",
      verification: "继续运行下一轮",
    });
    const candidateId = await proposeSimulationEvolution({ userId: scope.userId, instanceId: scope.instanceId }, weekly);
    assert.equal(weekly.evolutionProposal?.methodChangeCandidateId, candidateId);
    const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
    const candidate = await methodChangeBackend.get(scope.userId, scope.instanceId, candidateId);
    assert.equal(candidate?.sourceType, "strategy_simulation");
    assert.equal(candidate?.status, "proposed");
    const applyRequest = buildSimulationEvolutionApplyRequest({
      report: weekly,
      expectedLastConfirmedAt: "revision-before-apply",
      strategyPatch: { profile: { simulation: { sellThresholdPct: 0.03 } } },
      context: { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId, conversationId: "simulation-conversation" },
    });
    assert.equal(applyRequest.operation, "method_changes.apply");
    assert.equal(applyRequest.payload.candidateId, candidateId);
    assert.deepEqual(applyRequest.payload.strategyPatch, { profile: { simulation: { sellThresholdPct: 0.03 } } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
