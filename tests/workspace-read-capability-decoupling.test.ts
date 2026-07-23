import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const researchInstructionFiles = [
  "templates/workspace/AGENTS.md",
  "templates/workspace/.codex/skills/service-capability-policy/SKILL.md",
  "templates/workspace/.codex/skills/market-watch/SKILL.md",
  "templates/workspace/.codex/skills/daily-portfolio-review/SKILL.md",
  "templates/workspace/skills/market-watch/prompt.md",
  "templates/workspace/skills/monthly-review/prompt.md",
  "templates/workspace/skills/observation-pool/prompt.md",
  "templates/workspace/skills/qa/prompt.md",
  "templates/workspace/skills/weekly-review/prompt.md",
];

const hardCodedReadTool = /\b(?:market_watch\.snapshot|market\.(?:snapshot|quote|kline|indices|capital_flow|sector_theme|stock_info|resolve|calendar|health)|portfolio\.read|watchlist\.read|plans\.read)\b/;

test("workspace research instructions do not bind to specific MCP read-tool names", async () => {
  for (const relativePath of researchInstructionFiles) {
    const content = await readFile(path.resolve(relativePath), "utf8");
    assert.doesNotMatch(content, hardCodedReadTool, relativePath);
  }
});
