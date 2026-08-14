import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("retired investment-profile projection keys are stripped once at init, sibling domains preserved", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-investment-profile-retirement-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");

    // First init creates the schema (table does not exist yet at this point).
    initDb();

    // Seed a projection row shaped like a legacy write from the retired
    // POST /api/sandbox/profiles/investment endpoint: camelCase profile keys
    // mixed with a StrategyYaml-equivalent payload and the strategy-library
    // sibling key.
    sqlite.exec(`
      INSERT INTO mastra_project_profiles
        (user_id, project_id, instance_id, profile_json, source_path, source_checksum, source_revision, migration_batch_id, created_at, updated_at)
      VALUES ('retire-user', 'invest-agent', 'invest-agent-retire-user',
        '{"style":"稳健型","selectedStylePack":"balanced","riskPreference":"medium","investmentHorizon":"1-3y","positionRoles":{},"buyRules":[],"sellRules":[],"rebalanceRules":[],"riskRules":[],"sourceRevision":"2026-08-01T00:00:00.000Z","profile":{"style":"old","risk_preference":"low"},"allocation":{"cash":30},"notes":"keep","tradingStrategies":[{"key":"trend"}]}',
        'service-owned://strategy', 'service:seed', null, 'service-owned', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `);

    // A later init runs the idempotent strip migration; running it twice
    // more must be a no-op.
    initDb();
    initDb();

    const row = sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id='retire-user' AND project_id='invest-agent' AND instance_id='invest-agent-retire-user'")
      .get() as { value: string };
    const payload = JSON.parse(row.value);

    // Retired camelCase keys removed.
    for (const key of ["style", "selectedStylePack", "riskPreference", "investmentHorizon", "positionRoles", "buyRules", "sellRules", "rebalanceRules", "riskRules", "sourceRevision"]) {
      assert.equal(key in payload, false, `${key} should be stripped`);
    }

    // StrategyYaml-equivalent fields, colliding names, nested profile object
    // and the tradingStrategies sibling key are preserved.
    assert.deepEqual(payload.profile, { style: "old", risk_preference: "low" });
    assert.deepEqual(payload.allocation, { cash: 30 });
    assert.equal(payload.notes, "keep");
    assert.deepEqual(payload.tradingStrategies, [{ key: "trend" }]);

    // The retired table is no longer created on a fresh database.
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investment_profiles'").all();
    assert.deepEqual(tables, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
