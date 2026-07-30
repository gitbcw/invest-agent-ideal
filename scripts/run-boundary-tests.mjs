#!/usr/bin/env node

import { spawn } from "node:child_process";

const boundaryTests = [
  "scripts/db-legacy-migration-smoke.mjs",
  "scripts/db-legacy-alerts-drop-smoke.mjs",
  "scripts/mcp-service-tools-smoke.mjs",
  "scripts/security-boundary-smoke.mjs",
  "scripts/route-uniqueness-smoke.mjs",
  "scripts/platform-investment-state-smoke.mjs",
  "scripts/offline-runtime-smoke.mjs",
];

const results = await Promise.all(boundaryTests.map(runBoundaryTest));
const failures = results.filter((result) => result.code !== 0);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n[boundary] ${failure.script} failed (exit ${failure.code})`);
    if (failure.stdout) console.error(failure.stdout.trimEnd());
    if (failure.stderr) console.error(failure.stderr.trimEnd());
  }
  process.exit(1);
}

console.log(`[boundary] passed ${boundaryTests.length}: ${boundaryTests.map(shortName).join(", ")}`);

function runBoundaryTest(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ script, code: 1, stdout, stderr: `${stderr}${error.stack || error.message}\n` }));
    child.on("close", (code) => resolve({ script, code: code ?? 1, stdout, stderr }));
  });
}

function shortName(script) {
  return script.replace(/^scripts\//, "").replace(/-smoke\.mjs$/, "");
}
