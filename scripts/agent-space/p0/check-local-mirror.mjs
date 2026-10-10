#!/usr/bin/env node
/** Read-only health check for the isolated production-mirror environment. */

const checks = [
  { name: "runtime", url: "http://127.0.0.1:23670/health", expected: (s) => s === 200 },
  { name: "portal", url: "http://127.0.0.1:3120/chat", expected: (s) => s >= 200 && s < 400 },
  { name: "relay", url: "http://127.0.0.1:3220/health", expected: (s) => s >= 200 && s < 500 },
];

let failed = false;
for (const check of checks) {
  try {
    const response = await fetch(check.url, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    const body = check.name === "runtime" ? await response.text() : "";
    const ok = check.expected(response.status) && (check.name !== "runtime" ? true : body.includes('"status":"ok"'));
    console.log(`${ok ? "PASS" : "FAIL"} ${check.name} ${response.status}`);
    if (!ok) failed = true;
  } catch (error) {
    failed = true;
    console.log(`FAIL ${check.name} ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) {
  console.error("本地镜像未通过健康检查；请先运行 node scripts/agent-space/p0/start-local-mirror.mjs");
  process.exitCode = 1;
} else {
  console.log("本地镜像健康检查通过（本地运行；不代表生产数据或真实投递可用）");
}
