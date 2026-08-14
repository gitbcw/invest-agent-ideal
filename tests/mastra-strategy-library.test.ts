import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("mastra strategy library matches workspace upsert/remove semantics and preserves sibling projection keys", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-strategy-library-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { readMastraTradingStrategies, writeMastraTradingStrategy, removeMastraTradingStrategy } = await import("../src/lib/mastra-strategy-library.js");

    initDb();
    const scope = { userId: "strategy-user", instanceId: "invest-agent-strategy-user", projectId: "invest-agent" };

    // Fresh user: no projection row reads as an empty library.
    assert.deepEqual(readMastraTradingStrategies(scope), []);

    // Create: lazily creates the projection row with service-owned provenance.
    const created = writeMastraTradingStrategy(scope, { key: "breakout-pullback", name: "突破回踩", body: "突破后回踩不破均线加仓" });
    assert.equal(created.length, 1);
    assert.equal(created[0].key, "breakout-pullback");
    assert.equal(created[0].enabled, true);
    assert.ok(created[0].created_at);
    assert.ok(created[0].updated_at);
    const row = sqlite.prepare("SELECT profile_json AS value, source_path AS sourcePath FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=?")
      .get(scope.userId, scope.projectId, scope.instanceId) as { value: string; sourcePath: string };
    assert.equal(row.sourcePath, "service-owned://strategy-library");
    assert.deepEqual(JSON.parse(row.value).tradingStrategies[0].key, "breakout-pullback");

    // Upsert same key: created_at preserved, fields replaced.
    const updated = writeMastraTradingStrategy(scope, { key: "breakout-pullback", name: "突破回踩（修订）", body: "修订后的规则", enabled: false });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].name, "突破回踩（修订）");
    assert.equal(updated[0].enabled, false);
    assert.equal(updated[0].created_at, created[0].created_at);

    // Sibling projection domains in the same row survive library writes.
    sqlite.prepare("UPDATE mastra_project_profiles SET profile_json=? WHERE user_id=? AND project_id=? AND instance_id=?")
      .run(JSON.stringify({ profile: { style: "价值投资" }, tradingStrategies: updated }), scope.userId, scope.projectId, scope.instanceId);
    writeMastraTradingStrategy(scope, { key: "trend-relay", name: "趋势中继", body: "趋势中继形态确认后加仓" });
    const siblingRow = sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=?")
      .get(scope.userId, scope.projectId, scope.instanceId) as { value: string };
    const after = JSON.parse(siblingRow.value);
    assert.equal(after.profile.style, "价值投资");
    assert.equal(after.tradingStrategies.length, 2);
    assert.equal(readMastraTradingStrategies(scope).length, 2);

    // Remove: true once, then false for a missing key.
    assert.equal(removeMastraTradingStrategy(scope, "trend-relay"), true);
    assert.equal(readMastraTradingStrategies(scope).length, 1);
    assert.equal(removeMastraTradingStrategy(scope, "trend-relay"), false);

    // Invalid payload shape fails closed instead of returning garbage.
    sqlite.prepare("UPDATE mastra_project_profiles SET profile_json=? WHERE user_id=? AND project_id=? AND instance_id=?")
      .run(JSON.stringify({ tradingStrategies: "not-a-list" }), scope.userId, scope.projectId, scope.instanceId);
    assert.throws(() => readMastraTradingStrategies(scope), /MASTRA_PROJECTION_INVALID/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
