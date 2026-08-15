import assert from "node:assert/strict";
import test from "node:test";
import { __test__ } from "../src/scheduler/index.js";

const { intervalSlot } = __test__;

// P4b (E4): the minute loop drives the rule patrol only. Market-watch and
// reviews fire exclusively as typed automation tasks (windows/monthly math
// covered by automation-tasks tests); schedulerActivation no longer gates
// anything. This contract pins the surviving patrol slot math.
test("rule patrol minute slots align to trading-session intervals", () => {
  // 09:29 Beijing is on the 9-minute grid of the morning session
  assert.equal(intervalSlot(new Date("2026-06-30T01:29:00.000Z"), 9), "am-1");
  // Off-grid minute -> no slot
  assert.equal(intervalSlot(new Date("2026-06-30T01:30:00.000Z"), 9), null);
  // Afternoon session grid (13:03 Beijing)
  assert.equal(intervalSlot(new Date("2026-06-30T05:03:00.000Z"), 3), "pm-1");
  // Outside both sessions -> no slot
  assert.equal(intervalSlot(new Date("2026-06-30T07:30:00.000Z"), 5), null);
});
