import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrentTaskLimiter, portalConcurrentTaskLimit } from "../src/portal/concurrent-task-limiter.js";

test("Portal concurrent task limiter admits three active tasks and releases capacity", () => {
  const limiter = new ConcurrentTaskLimiter(3);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.activeCount, 3);
  limiter.release();
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.activeCount, 3);
});

test("Portal concurrent task limit defaults to three and rejects invalid values", () => {
  assert.equal(portalConcurrentTaskLimit(undefined), 3);
  assert.equal(portalConcurrentTaskLimit("0"), 3);
  assert.equal(portalConcurrentTaskLimit("invalid"), 3);
  assert.equal(portalConcurrentTaskLimit("2"), 2);
  assert.equal(portalConcurrentTaskLimit("99"), 10);
});
