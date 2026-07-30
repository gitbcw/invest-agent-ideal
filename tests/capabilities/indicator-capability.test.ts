import assert from "node:assert/strict";
import test from "node:test";
import { indicatorCapability } from "../../src/services/indicators.js";

test("indicator capability preserves deterministic L1 warm-up behavior", () => {
  assert.deepEqual(indicatorCapability.computeMA([1, 2, 3], 2).values, [null, 1.5, 2.5]);
  assert.equal(indicatorCapability.computeRSI([1, 2, 3], 6).last, null);
  assert.ok(Object.isFrozen(indicatorCapability));
});
