import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../src/scheduler/index.js";

const {
  readIntervalMinutes,
  normalizeWatchWindows,
  resolveMarketWatchWindows,
  intervalSlot,
  windowSlot,
  shouldSuppressRuleAlertPush,
  planSchedulerTick,
} = __test__;

test("market-watch scheduling uses explicit windows and independent rule checks", () => {
  assert.equal(readIntervalMinutes(30), 30);
  assert.equal(readIntervalMinutes("30"), 30);
  assert.equal(readIntervalMinutes(null), null);
  assert.equal(readIntervalMinutes("default"), null);
  assert.equal(readIntervalMinutes("trading_days_09:30_10:30_11:30_13:00_14:00"), null);

  const windows = normalizeWatchWindows([
    { name: "开盘盘面", time: "09:30" },
    "10:30",
    { time: "11:30" },
    { time: "bad" },
  ]);
  assert.deepEqual(windows, ["09:30", "10:30", "11:30"]);
  assert.deepEqual(resolveMarketWatchWindows({
    market_watch: { default_windows: ["09:30", "10:00", "11:00"] },
  }), ["09:30", "10:00", "11:00"]);

  assert.equal(windowSlot(new Date("2026-06-30T01:30:00.000Z"), windows), "09:30");
  assert.equal(windowSlot(new Date("2026-06-30T01:39:00.000Z"), windows), null);
  assert.equal(windowSlot(new Date("2026-06-30T04:02:00.000Z"), ["12:00"], 3), "12:00");
  assert.equal(windowSlot(new Date("2026-06-30T04:04:00.000Z"), ["12:00"], 3), null);
  assert.equal(intervalSlot(new Date("2026-06-30T01:30:00.000Z"), 9), null);
  assert.equal(intervalSlot(new Date("2026-06-30T01:29:00.000Z"), 9), "am-1");

  assert.equal(shouldSuppressRuleAlertPush({ marketWatchHitThisTick: true, alertCount: 2 }), true);
  assert.equal(shouldSuppressRuleAlertPush({ marketWatchHitThisTick: true, alertCount: 0 }), false);
  assert.equal(shouldSuppressRuleAlertPush({ marketWatchHitThisTick: false, alertCount: 2 }), false);
  assert.deepEqual(planSchedulerTick({ marketWatchHit: false, ruleAlertHit: true }), {
    runMarketWatch: false,
    runRuleAlertCheck: true,
  });
  assert.deepEqual(planSchedulerTick({ marketWatchHit: true, ruleAlertHit: true }), {
    runMarketWatch: true,
    runRuleAlertCheck: true,
  });
});
