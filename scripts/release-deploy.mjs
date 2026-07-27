#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const releaseRoot = resolve(process.env.INVEST_AGENT_RELEASE_ROOT
  ?? "/Users/combo/MyFile/my-data/backups/invest-agent/releases");
const workspaceBackupRoot = resolve(process.env.VOLCANO_BACKUP_ROOT
  ?? "/Users/combo/MyFile/my-data/backups/invest-agent/workspaces");

function fail(message) {
  console.error(`[release-deploy] ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function releasePath(releaseId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(releaseId)) fail(`invalid release id: ${releaseId}`);
  const path = join(releaseRoot, releaseId);
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`release not found: ${releaseId}`);
  return path;
}

function localBackupLabel(date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  const offset = parts.timeZoneName.replace("GMT", "").replace(":", "") || "+0000";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}${parts.minute}${parts.second}${offset}`;
}

function nextBackupLabel() {
  const now = Date.now();
  for (let offset = 0; offset < 60; offset += 1) {
    const label = localBackupLabel(new Date(now + offset * 1000));
    if (!existsSync(join(workspaceBackupRoot, "snapshots", label))) return label;
  }
  fail("could not allocate a unique pre-rollback backup label");
}

function verify(releaseId) {
  run(process.execPath, [join(repoRoot, "scripts", "release-snapshot.mjs"), "verify", releaseId], { stdio: "inherit" });
}

function deploy(mode, releaseId, confirm) {
  const releaseDir = releasePath(releaseId);
  verify(releaseId);
  if (mode === "rollback") {
    if (confirm !== "rollback-code-v1") fail("rollback requires --confirm=rollback-code-v1");
    if (!existsSync(join(releaseDir, "status", "accepted.json"))) fail("rollback target must be known-good");
  }
  const manifest = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8"));
  let recoveryDir;
  let beforeBackupLabel;
  if (mode === "rollback") {
    beforeBackupLabel = nextBackupLabel();
    console.log(`[release-deploy] capture current workspaces before rollback as ${beforeBackupLabel}`);
    run("bash", [join(repoRoot, "scripts", "backup-volcano-workspaces.sh")], {
      stdio: "inherit",
      env: { ...process.env, VOLCANO_BACKUP_ROOT: workspaceBackupRoot, VOLCANO_BACKUP_LABEL: beforeBackupLabel },
    });
    const runId = `${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${releaseId}`;
    recoveryDir = join(releaseRoot, "recovery-runs", runId);
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    writeJson(join(recoveryDir, "request.json"), {
      runId,
      mode,
      targetReleaseId: releaseId,
      targetCommit: manifest.commit,
      currentWorkspaceBackupLabel: beforeBackupLabel,
      requestedAt: new Date().toISOString(),
    });
  }

  const temporary = mkdtempSync(join(tmpdir(), "invest-agent-release-deploy-"));
  try {
    run("tar", ["xzf", join(releaseDir, "source.tar.gz"), "-C", temporary]);
    const deployScript = join(temporary, "scripts", "deploy-volcano.sh");
    if (!existsSync(deployScript) || !statSync(deployScript).isFile()) fail("release archive is missing scripts/deploy-volcano.sh");
    console.log(`[release-deploy] ${mode} ${releaseId} from clean snapshot tree`);
    run("bash", [deployScript], {
      cwd: temporary,
      stdio: "inherit",
      env: {
        ...process.env,
        RELEASE_ID: releaseId,
        RELEASE_COMMIT: manifest.commit,
        RELEASE_OPERATION: mode,
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const evidence = {
    releaseId,
    commit: manifest.commit,
    operation: mode,
    completedAt: new Date().toISOString(),
    currentWorkspaceBackupLabel: beforeBackupLabel ?? null,
  };
  if (mode === "deploy") writeJson(join(releaseDir, "status", "deployed.json"), evidence);
  else writeJson(join(recoveryDir, "deployment.json"), evidence);
  console.log(`[release-deploy] ${mode} completed; run the documented production acceptance before marking known-good`);
}

const [command, releaseId, ...rest] = process.argv.slice(2);
const confirm = rest.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
if ((command === "deploy" || command === "rollback") && releaseId) deploy(command, releaseId, confirm);
else fail("usage: release-deploy.mjs deploy <release-id> | rollback <release-id> --confirm=rollback-code-v1");

