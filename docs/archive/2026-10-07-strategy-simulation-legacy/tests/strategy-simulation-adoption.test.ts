import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("simulation evolution uses the existing two-turn confirmation and apply contract", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-simulation-adoption-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(root, ".sandbox-secret");
  try {
    const { db, initDb, sqlite } = await import("../src/db/index.js");
    const { conversationMessages, conversationSessions } = await import("../src/db/schema.js");
    const { resolveWorkspacePath, ensureWorkspace } = await import("../src/lib/workspace.js");
    const { createFixtureSimulation, generateWeeklyReport, runSimulationDay } = await import("../src/services/strategy-simulation-v1.js");
    const {
      applyConfirmedSimulationEvolution,
      createNextSimulationAfterAdoption,
      proposeSimulationEvolution,
      requestSimulationEvolutionAdoption,
    } = await import("../src/services/strategy-simulation-ledger.js");

    initDb();
    const userId = "simulation-adoption-user";
    const instanceId = "simulation-adoption-instance";
    const conversationId = "simulation-adoption-conversation";
    const revision = "2026-10-01T00:00:00.000Z";
    const context = {
      userId,
      instanceId,
      projectId: "invest-agent",
      conversationId,
      workspacePath: resolveWorkspacePath(userId),
      channel: "web" as const,
    };
    await ensureWorkspace({ userId, tenantId: userId, projectId: "invest-agent" });
    await db.insert(conversationSessions).values({
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      title: "simulation adoption",
      createdAt: revision,
      updatedAt: revision,
    });
    sqlite.prepare(`
      INSERT INTO mastra_project_profiles
        (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(userId, "invest-agent", instanceId, JSON.stringify({ profile: { style: "balanced" }, notes: "before" }), "service-owned://strategy", "test", revision, "test", revision, revision);

    const method = { skillId: "strategy-simulation", skillVersion: "fixture-v1", lookbackDays: 1, buyThresholdPct: 0.05, sellThresholdPct: 0.02, positionWeight: 0.5, costRate: 0.001 };
    const bars = [
      { date: "2026-10-01", symbol: "AAA", open: 10, close: 10 },
      { date: "2026-10-02", symbol: "AAA", open: 10.5, close: 11 },
      { date: "2026-10-03", symbol: "AAA", open: 10.8, close: 10.7 },
    ];
    const simulation = createFixtureSimulation("sim-adoption", method, bars);
    for (const date of ["2026-10-01", "2026-10-02", "2026-10-03"]) runSimulationDay(simulation, date);
    const report = generateWeeklyReport(simulation, "2026-10-01", "2026-10-03", {
      changedField: "sellThresholdPct",
      proposedValue: 0.03,
      hypothesis: "减少噪声退出",
      verification: "继续运行下一轮",
    });
    const candidateId = await proposeSimulationEvolution({ userId, instanceId }, report);
    const patch = { notes: "采用模拟进化候选" };
    const requested = await requestSimulationEvolutionAdoption({ report, expectedLastConfirmedAt: revision, strategyPatch: patch, context });
    assert.ok(requested.confirmationId);
    assert.equal((await (await import("../src/lib/method-change-backend.js")).methodChangeBackend.get(userId, instanceId, candidateId))?.status, "proposed");

    await db.insert(conversationMessages).values({
      messageId: "simulation-adoption-confirm",
      conversationId,
      userId,
      projectId: "invest-agent",
      instanceId,
      assistantId: instanceId,
      channel: "web",
      role: "user",
      content: "确认采用",
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    const applied = await applyConfirmedSimulationEvolution({ report, expectedLastConfirmedAt: revision, strategyPatch: patch, confirmationId: requested.confirmationId, context });
    assert.equal(applied.ok, true);
    assert.equal((applied.candidate as { status: string }).status, "confirmed");
    assert.equal((applied.strategy as { notes: string }).notes, "采用模拟进化候选");
    const next = createNextSimulationAfterAdoption({
      previousSimulationId: "sim-adoption",
      simulationId: "sim-adoption-v2",
      userId,
      projectId: "invest-agent",
      instanceId,
      skillId: method.skillId,
      skillVersion: "fixture-v2",
      strategyVersionId: (applied.strategy as { last_strategy_version_id: string }).last_strategy_version_id,
      method: { ...method, skillVersion: "fixture-v2" },
      bars,
    });
    assert.equal(next.cash, 1);
    assert.equal(next.navPoints.length, 0);
    const stored = sqlite.prepare("SELECT parent_simulation_id, strategy_version_id FROM strategy_simulations WHERE simulation_id=?").get("sim-adoption-v2") as { parent_simulation_id: string; strategy_version_id: string };
    assert.equal(stored.parent_simulation_id, "sim-adoption");
    assert.equal(stored.strategy_version_id, (applied.strategy as { last_strategy_version_id: string }).last_strategy_version_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
