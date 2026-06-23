#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;

const targets = [
  "AGENTS.md",
  "docs/README.md",
  "docs/23-multi-user-sandbox-design.md",
  "docs/02-investment-methodology.md",
  "docs/04-core-workflows.md",
  "docs/11-server-deployment.md",
  "docs/ideal-refactor-plan.md",
  "docs/table-ownership.md",
  "src",
  ".codex/skills",
];

const checks = [
  {
    name: "confirmed profile must not be methodology source",
    pattern: String.raw`confirmed profile|确认过的\s*profile|confirmed\s+investment_profile|confirmed\s+methodology_profile`,
  },
  {
    name: "Profile must not carry methodology responsibility",
    pattern: String.raw`profile[^。\n]*(承载|承担|保存|写入)[^。\n]*(方法论|用户策略|长期策略|投资方法)|方法论[^。\n]*(写入|保存|沉淀)[^。\n]*profile`,
  },
  {
    name: "Hermes must not be required main backend",
    pattern: String.raw`Hermes[^。；\n]*(是|作为|成为|承担|固定为)[^。；\n]*(唯一|主智能后端|主要智能后端|中心后端|主路径)|主智能后端[^。；\n]*(是|使用|采用)[^。；\n]*Hermes`,
  },
];

let failed = false;

for (const check of checks) {
  const result = spawnSync("rg", ["-n", "--pcre2", check.pattern, ...targets], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    failed = true;
    console.error(`\n[FAIL] ${check.name}`);
    console.error(result.stdout.trim());
  } else if (result.status > 1) {
    failed = true;
    console.error(`\n[ERROR] ${check.name}`);
    console.error(result.stderr.trim());
  }
}

if (failed) {
  console.error("\nConvergence responsibility scan failed.");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  scanned: targets,
  checks: checks.map((check) => check.name),
}));
