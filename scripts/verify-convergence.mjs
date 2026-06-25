#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;

const steps = [
  {
    name: "build",
    command: "npm",
    args: ["run", "build"],
  },
  {
    name: "responsibility scan",
    command: "node",
    args: ["scripts/convergence-responsibility-scan.mjs"],
  },
  {
    name: "golden test set lint",
    command: "node",
    args: ["tests/golden/run.mjs"],
  },
  {
    name: "strategy instance expansion smoke",
    command: "node",
    args: ["scripts/strategy-instance-expansion-smoke.mjs"],
  },
  {
    name: "review viewpoint smoke",
    command: "node",
    args: ["scripts/review-viewpoint-smoke.mjs"],
  },
  {
    name: "WeChat readonly smoke",
    command: "node",
    args: ["scripts/weixin-readonly-smoke.mjs"],
  },
  {
    name: "Workbench health check",
    command: "node",
    args: ["scripts/workbench-health-check.mjs"],
  },
];

const startedAt = Date.now();

console.log("# Convergence Verification");
console.log(`repoRoot: ${repoRoot}`);
console.log("");

for (const [index, step] of steps.entries()) {
  const label = `${index + 1}/${steps.length} ${step.name}`;
  console.log(`## ${label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\n[FAIL] ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log("");
}

console.log(JSON.stringify({
  ok: true,
  steps: steps.map((step) => step.name),
  elapsedMs: Date.now() - startedAt,
}));
