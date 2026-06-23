import { test } from "node:test";
import * as assert from "node:assert/strict";

test("node:test 框架加载正常", () => {
  assert.equal(1 + 1, 2);
});

test("tsx 能直接 import TypeScript 模块", async () => {
  const mod = await import("../src/lib/logger.js");
  assert.ok(typeof mod.logger === "object");
  assert.ok(typeof mod.logger.info === "function");
});
