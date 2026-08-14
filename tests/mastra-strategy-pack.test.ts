import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";

test("strategy packs write into the trading-strategy library idempotently", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-strategy-pack-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");

  try {
    const { initDb } = await import("../src/db/index.js");
    initDb();
    const scope = { userId: "pack-user", projectId: "invest-agent", instanceId: "invest-agent-pack-user" };
    const { applyStrategyPack, listStrategyPacks, applyPreset } = await import("../src/services/presets.js");
    const { readMastraTradingStrategies } = await import("../src/lib/mastra-strategy-library.js");

    const packs = listStrategyPacks();
    assert.equal(packs.length, 2);
    assert.ok(packs.every((pack) => pack.kind === "strategy" && pack.strategyTemplates && pack.strategyTemplates.length > 0));

    const first = await applyStrategyPack(scope, "strategy-trend-following");
    assert.deepEqual(first.applied, ["trend-following-core", "trend-following-risk"]);
    const library = readMastraTradingStrategies(scope);
    assert.equal(library.length, 2);
    assert.equal(library[0].key, "trend-following-core");
    assert.ok(library[0].body.includes("20 日均线"));

    // Idempotent: re-apply skips existing keys; user-edited bodies preserved.
    const second = await applyStrategyPack(scope, "strategy-trend-following");
    assert.deepEqual(second.applied, []);

    // Strategy packs are not usage-mode presets.
    await assert.rejects(() => applyPreset(scope, "strategy-trend-following"), (error: Error) => {
      assert.match(error.message, /PRESET_NOT_USAGE_MODE/);
      return true;
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
