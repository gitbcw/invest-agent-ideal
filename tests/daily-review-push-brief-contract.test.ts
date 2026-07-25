import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("daily review template requires a decision-complete WeChat brief", async () => {
  const skill = await readFile(path.resolve("templates/workspace/.codex/skills/daily-portfolio-review/SKILL.md"), "utf8");
  const prompt = await readFile(path.resolve("templates/workspace/skills/daily-review/prompt.md"), "utf8");

  for (const content of [skill, prompt]) {
    assert.match(content, /decision-complete|决策完整/);
    assert.match(content, /400-700/);
    assert.match(content, /700-1000/);
    assert.match(content, /three decisions|三个决策/);
    assert.match(content, /验证.*失效|validation.*invalidation/);
    assert.match(content, /数据.*来源|source-quality/);
  }
});
