import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const researchInstructionFiles = [
  "templates/skills/automation-task-designer/SKILL.md",
  "templates/skills/candidate-screening/SKILL.md",
  "templates/skills/fundamental-analysis/SKILL.md",
  "templates/skills/macro-analysis/SKILL.md",
  "templates/skills/risk-control/SKILL.md",
  "templates/skills/technical-analysis/SKILL.md",
];

const hardCodedReadTool = /\b(?:market_watch\.snapshot|market\.(?:snapshot|quote|kline|indices|capital_flow|sector_theme|stock_info|resolve|calendar|health)|portfolio\.read|watchlist\.read|plans\.read)\b/;

test("Mastra methodology skills do not bind to legacy MCP read-tool names", async () => {
  for (const relativePath of researchInstructionFiles) {
    const content = await readFile(path.resolve(relativePath), "utf8");
    assert.doesNotMatch(content, hardCodedReadTool, relativePath);
  }
});
