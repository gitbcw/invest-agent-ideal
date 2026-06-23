#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const label = "local.invest-agent-hermes";
const uid = process.getuid?.() ?? Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
const domainLabel = `gui/${uid}/${label}`;
const healthUrl = process.env.HERMES_SMOKE_HEALTH_URL || "http://localhost:22649/health";
const expectedPort = Number(process.env.HERMES_SMOKE_PORT || 22649);
const requiredPaths = [
  "scripts/launchd/local.invest-agent-hermes.plist",
  "scripts/start-hermes-service.sh",
  "logs/hermes-service.out.log",
  "logs/hermes-service.err.log",
];

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2));
  process.exit(1);
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fail(`${command} ${args.join(" ")} failed`, error.stderr?.toString() || error.message);
  }
}

for (const path of requiredPaths) {
  if (!existsSync(path)) fail("required path missing", path);
}

const launch = run("launchctl", ["print", domainLabel]);
const requiredLaunchSnippets = [
  "state = running",
  "properties = keepalive | runatload",
  "logs/hermes-service.out.log",
  "logs/hermes-service.err.log",
  "PORT => 22649",
  "HERMES_EXPERIMENT_ENABLED => true",
  "HERMES_WEIXIN_AUTO_START => true",
];

const missingLaunchSnippets = requiredLaunchSnippets.filter((snippet) => !launch.includes(snippet));
if (missingLaunchSnippets.length > 0) {
  fail("launchd config mismatch", missingLaunchSnippets);
}

const health = await fetch(healthUrl).then(async (res) => {
  const text = await res.text();
  if (!res.ok) fail("health check failed", { status: res.status, text });
  return JSON.parse(text);
}).catch((error) => fail("health request failed", error.message));

if (health.status !== "ok") fail("health status not ok", health);
if (!health.hermesAcp?.enabled) fail("Hermes ACP is not enabled", health.hermesAcp);
if (health.hermesAcp?.profile !== "invest-agent") fail("unexpected Hermes profile", health.hermesAcp);
if (Number(new URL(healthUrl).port) !== expectedPort) fail("unexpected health port", healthUrl);

const logStats = Object.fromEntries(
  requiredPaths
    .filter((path) => path.startsWith("logs/"))
    .map((path) => [path, statSync(path).size])
);

console.log(JSON.stringify({
  ok: true,
  label,
  health: {
    status: health.status,
    codexReady: Boolean(health.codexAcp?.ready),
    hermesEnabled: Boolean(health.hermesAcp?.enabled),
    hermesReady: Boolean(health.hermesAcp?.ready),
    profile: health.hermesAcp?.profile,
    pushQueue: health.pushQueue,
  },
  logStats,
}, null, 2));
