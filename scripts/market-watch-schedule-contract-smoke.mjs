#!/usr/bin/env node
import assert from "node:assert/strict";
import { __test__ } from "../dist/scheduler/index.js";

const {
  readIntervalMinutes,
  normalizeWatchWindows,
  intervalSlot,
  windowSlot,
} = __test__;

assert.equal(readIntervalMinutes(30), 30);
assert.equal(readIntervalMinutes("30"), 30);
assert.equal(readIntervalMinutes(null), null);
assert.equal(readIntervalMinutes("default"), null);
assert.equal(readIntervalMinutes("trading_days_09:30_10:30_11:30_13:00_14:00"), null);
assert.equal(readIntervalMinutes("高频"), null);
assert.equal(readIntervalMinutes("低频"), null);

const windows = normalizeWatchWindows([
  { name: "开盘盘面", time: "09:30" },
  "10:30",
  { time: "11:30" },
  { time: "bad" },
]);
assert.deepEqual(windows, ["09:30", "10:30", "11:30"]);

assert.equal(windowSlot(new Date("2026-06-30T01:30:00.000Z"), windows), "09:30");
assert.equal(windowSlot(new Date("2026-06-30T01:39:00.000Z"), windows), null);
assert.equal(intervalSlot(new Date("2026-06-30T01:30:00.000Z"), 9), null);
assert.equal(intervalSlot(new Date("2026-06-30T01:29:00.000Z"), 9), "am-1");

console.log("✓ market-watch schedule contract smoke passed");
