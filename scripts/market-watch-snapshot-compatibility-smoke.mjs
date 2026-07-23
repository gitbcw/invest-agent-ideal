#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildMarketWatchDelta } from "../dist/services/market-watch-snapshot.js";

const current = {
  ok: true,
  userId: "snapshot-compatibility-smoke",
  instanceId: "snapshot-compatibility-smoke-instance",
  updatedAt: "2026-07-23T01:30:00.000Z",
  holdings: [],
  watchlist: [],
  plans: [{ stockCode: "600000", stockName: "fixture", support: 10 }],
  indices: [],
  warnings: [],
};

// Production snapshots written before plans were added must remain comparable.
const legacySnapshot = {
  ...current,
  updatedAt: "2026-07-23T01:00:00.000Z",
  plans: undefined,
  indices: undefined,
  warnings: undefined,
};

const delta = buildMarketWatchDelta(current, legacySnapshot, "09:30");
assert.equal(delta.previousWindowKey, "09:30");
assert.equal(delta.materiallyChanged, true);
assert.deepEqual(delta.stockChanges.map((item) => [item.code, item.state]), [["600000", "added"]]);
assert.deepEqual(delta.indexChanges, []);
assert.equal(delta.warningsChanged, false);

console.log("market-watch snapshot compatibility smoke passed");
