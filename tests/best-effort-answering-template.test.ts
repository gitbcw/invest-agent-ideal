import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function templateFile(relativePath: string) {
  return readFile(path.resolve(relativePath), "utf8");
}

test("Mastra instructions treat partial evidence as an answer boundary, not a stop signal", async () => {
  const instructions = await templateFile("src/runtime/agent-instructions.ts");

  assert.match(instructions, /数据缺口只限制受影响的子结论/);
  assert.match(instructions, /“全部”“完整”“全市场”默认是目标范围/);
  assert.match(instructions, /实际覆盖范围、替代口径和剩余缺口/);
});

test("active methodology skills preserve evidence scope", async () => {
  const files = [
    "templates/skills/fundamental-analysis/SKILL.md",
    "templates/skills/macro-analysis/SKILL.md",
    "templates/skills/risk-control/SKILL.md",
    "templates/skills/technical-analysis/SKILL.md",
  ];

  for (const relativePath of files) {
    const content = await templateFile(relativePath);
    assert.match(content, /判断规则/, relativePath);
  }
});
