import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("strategy_simulation.dry_run is blocked for mirror-like natural-language strategy without executable method", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-simulation-dry-run-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    initDb();
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO mastra_project_profiles
        (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run("mg", "invest-agent", "invest-agent-mg", JSON.stringify({ markets: ["A股"], allocation: { target_structure: [] } }), "config/strategy.yaml", "mirror", now, "mirror", now, now);
    const result = await callServiceTool("strategy_simulation.dry_run", {
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    }, { userId: "mg", instanceId: "invest-agent-mg", projectId: "invest-agent" });
    assert.equal(result.ok, false);
    assert.equal(result.status, "blocked");
    assert.ok((result.capabilityGaps as string[]).some((gap) => gap.includes("声明式模拟方法")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy_simulation.dry_run runs a supplied executable method over a date range without persistence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-simulation-dry-run-complete-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    initDb();
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO mastra_project_profiles
        (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run("mg-complete", "invest-agent", "invest-agent-mg-complete", JSON.stringify({ markets: ["A股"], allocation: {} }), "config/strategy.yaml", "mirror", now, "mirror", now, now);
    const result = await callServiceTool("strategy_simulation.dry_run", {
      startDate: "2026-01-01",
      endDate: "2026-01-04",
      simulationMethod: { skillId: "strategy-simulation", skillVersion: "fixture-v1", lookbackDays: 1, buyThresholdPct: 0.05, sellThresholdPct: 0.02, positionWeight: 0.5, costRate: 0.001 },
      bars: [
        { date: "2026-01-01", symbol: "AAA", open: 10, close: 10, chipConc90: 18.2, mainNetInflow: 23700000, dataSource: "qsse-qlib", dataQuality: "exact" },
        { date: "2026-01-02", symbol: "AAA", open: 10.5, close: 11, chipConc90: 17.8, mainNetInflow: 1200000, dataSource: "qsse-qlib", dataQuality: "exact" },
        { date: "2026-01-03", symbol: "AAA", open: 10.8, close: 10.7 },
        { date: "2026-01-04", symbol: "AAA", open: 10.6, close: 10.6 },
      ],
    }, { userId: "mg-complete", instanceId: "invest-agent-mg-complete", projectId: "invest-agent" });
    assert.equal(result.ok, true);
    assert.equal(result.status, "completed");
    assert.equal(result.readOnly, true);
    assert.equal((result.dailyReports as unknown[]).length, 4);
    assert.equal((result.weeklyReport as { status: string }).status, "complete");
    const firstDaily = (result.dailyReports as Array<{ factorEvidence: Array<{ chipConc90?: number; mainNetInflow?: number; quality: string }> }>)[0];
    assert.equal(firstDaily.factorEvidence[0].chipConc90, 18.2);
    assert.equal(firstDaily.factorEvidence[0].mainNetInflow, 23700000);
    assert.equal(firstDaily.factorEvidence[0].quality, "exact");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM strategy_simulations").get().count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
