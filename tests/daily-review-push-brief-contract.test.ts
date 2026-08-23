import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("current daily review prompt requires a decision-complete WeChat brief", async () => {
  const prompt = await readFile(path.resolve("src/runtime/scheduled-tasks.ts"), "utf8");

  assert.match(prompt, /三个决策/);
  assert.match(prompt, /验证信号与失效信号/);
  assert.match(prompt, /来源、截至时间和质量边界/);
  assert.match(prompt, /reviews\.save/);
});
