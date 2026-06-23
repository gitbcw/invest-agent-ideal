#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function assertExists(relativePath) {
  assert.ok(exists(relativePath), `missing required file: ${relativePath}`);
}

const strategySkillId = "invest-agent-strategy-middle-trend";
const strategyRoot = ".codex/skills/invest-agent-strategy-middle-trend";
const requiredFiles = [
  `${strategyRoot}/SKILL.md`,
  `${strategyRoot}/references/skeleton.md`,
  `${strategyRoot}/references/instances/default.md`,
  `${strategyRoot}/references/review.md`,
  `${strategyRoot}/references/screening.md`,
  `${strategyRoot}/references/alerts.md`,
  `${strategyRoot}/references/evolution.md`,
];

for (const file of requiredFiles) assertExists(file);

const skill = read(`${strategyRoot}/SKILL.md`);
assert.match(skill, new RegExp(`name:\\s*${strategySkillId}`), "SKILL.md must declare the strategy skill name");
assert.match(skill, /protected strategy skeleton/i, "SKILL.md must describe the protected skeleton");
assert.match(skill, /instance-specific expansion/i, "SKILL.md must describe instance expansion");

const skeleton = read(`${strategyRoot}/references/skeleton.md`);
assert.match(skeleton, /Single-user instances must not edit this file/, "skeleton.md must declare single-user write protection");

const skillBundles = read("src/platform/skill-bundles.ts");
assert.match(skillBundles, new RegExp(`id:\\s*"${strategySkillId}"`), "skill bundle must include strategy skill id");
assert.match(skillBundles, new RegExp(`path:\\s*"${strategyRoot}/SKILL.md"`), "skill bundle must reference strategy skill path");

const registry = read("src/platform/project-registry.ts");
const instancePathPattern = /instanceExpansionPath:\s*"([^"]+)"/g;
const instancePaths = [...registry.matchAll(instancePathPattern)]
  .map((match) => match[1])
  .filter((value) => value.includes(`${strategyRoot}/references/instances/`));
assert.ok(instancePaths.length > 0, "project registry must reference at least one strategy instance expansion path");
for (const instancePath of instancePaths) assertExists(instancePath);

console.log(JSON.stringify({
  ok: true,
  strategySkillId,
  requiredFiles: requiredFiles.length,
  registryInstancePaths: [...new Set(instancePaths)],
}));
