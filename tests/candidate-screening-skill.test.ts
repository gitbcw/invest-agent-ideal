import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const skillPath = path.resolve("templates/skills/candidate-screening/SKILL.md");

test("candidate screening skill has a narrow, source-aware method boundary", async () => {
  const body = await readFile(skillPath, "utf8");

  assert.match(body, /^---\nname: candidate-screening\ndescription: \S/);
  for (const section of ["候选发现", "风险扫描", "等待条件", "覆盖、样本与缺失"]) {
    assert.match(body, new RegExp(section));
  }
  for (const role of ["automation-task-designer", "fundamental-analysis", "technical-analysis", "risk-control"]) {
    assert.ok(body.includes(role), `skill must define the boundary with ${role}`);
  }
  assert.match(body, /完整扫描|限定范围|代表性样本/);
  assert.match(body, /缺失项|降低置信度/);
  assert.match(body, /不做“今日推荐”|不把观察意见写成无条件行动建议/);
  assert.match(body, /事实、推断.*未知/);
});

test("candidate screening skill does not bind to legacy paths, fixed tools, or task side effects", async () => {
  const body = await readFile(skillPath, "utf8");

  assert.doesNotMatch(body, /\.codex|config\//);
  assert.doesNotMatch(body, /(?:automation\.|portfolio\.|watchlist\.|plans\.|market_watch\.)/);
  assert.doesNotMatch(body, /MCP|schema|API|工具调用/);
  assert.doesNotMatch(body, /调度|schedule|确认|confirmation|写入|落库|commit|save/);
});
