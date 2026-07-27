#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const releaseRoot = resolve(process.env.INVEST_AGENT_RELEASE_ROOT
  ?? "/Users/combo/MyFile/my-data/backups/invest-agent/releases");
const workspaceBackupRoot = resolve(process.env.VOLCANO_BACKUP_ROOT
  ?? "/Users/combo/MyFile/my-data/backups/invest-agent/workspaces");
const remoteHost = process.env.VOLCANO_ROLLBACK_REMOTE_HOST ?? "claude@118.145.115.197";
const remoteWorkspaceRoot = process.env.VOLCANO_ROLLBACK_REMOTE_ROOT ?? "/home/claude/invest-agent-data/workspaces";
const remoteBackupRoot = process.env.VOLCANO_ROLLBACK_REMOTE_BACKUP_ROOT ?? "/home/claude/invest-agent-data/workspace-rollback-backups";
const users = ["111", "dyk", "mg"];
const userSet = new Set(users);

function fail(message) {
  console.error(`[workspace-rollback] ERROR: ${message}`);
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateRelativePath(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || /[*?\[\]{}]/.test(path)) fail(`unsafe relative path: ${path}`);
}

function releasePath(releaseId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(releaseId)) fail(`invalid release id: ${releaseId}`);
  const path = join(releaseRoot, releaseId);
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`release not found: ${releaseId}`);
  return path;
}

function recoveryPath(runId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}-[0-9a-f]{8}$/.test(runId)) fail(`invalid recovery run id: ${runId}`);
  const path = join(releaseRoot, "recovery-runs", runId);
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`recovery run not found: ${runId}`);
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
  fail("could not allocate a unique workspace comparison backup label");
}

function collect(root) {
  const result = new Map();
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) result.set(rel, { type: "file", hash: sha256(path), path });
      else if (entry.isSymbolicLink()) {
        const target = readlinkSync(path);
        result.set(rel, { type: "symlink", hash: createHash("sha256").update(target).digest("hex"), target, path });
      }
    }
  }
  visit(root);
  return result;
}

function isText(path) {
  const bytes = readFileSync(path).subarray(0, 8192);
  return !bytes.includes(0);
}

function isMergeEligible(path) {
  return path === "AGENTS.md"
    || path.startsWith(".codex/skills/")
    || path.startsWith("config/")
    || path.startsWith("memory/")
    || path.startsWith("reports/");
}

function inventory(targetRoot, currentRoot) {
  const items = [];
  for (const user of users) {
    const target = collect(join(targetRoot, user));
    const current = collect(join(currentRoot, user));
    const paths = [...new Set([...target.keys(), ...current.keys()])].sort();
    for (const path of paths) {
      const targetEntry = target.get(path);
      const currentEntry = current.get(path);
      if (targetEntry?.type === currentEntry?.type && targetEntry?.hash === currentEntry?.hash) continue;
      const sample = currentEntry?.type === "file" ? currentEntry : targetEntry;
      const text = sample?.type === "file" && isText(sample.path);
      const allowedActions = ["keep-current", "manual-review"];
      if (targetEntry?.type === "file" && currentEntry?.type !== "symlink") allowedActions.push("restore-target");
      if (targetEntry?.type === "file" && currentEntry?.type === "file" && text && isMergeEligible(path)) {
        allowedActions.push("merge-candidate");
      }
      items.push({
        user,
        path,
        change: !targetEntry ? "added-current" : !currentEntry ? "missing-current" : "modified",
        kind: targetEntry?.type === "symlink" || currentEntry?.type === "symlink" ? "symlink" : text ? "text" : "binary",
        currentHash: currentEntry?.hash ?? null,
        targetHash: targetEntry?.hash ?? null,
        allowedActions,
        defaultAction: "keep-current",
      });
    }
  }
  return items;
}

function plan(releaseId) {
  const releaseDir = releasePath(releaseId);
  run(process.execPath, [join(repoRoot, "scripts", "release-snapshot.mjs"), "verify", releaseId], { stdio: "inherit" });
  if (!existsSync(join(releaseDir, "status", "accepted.json"))) fail("workspace comparison target must be known-good");
  const backupLabel = nextBackupLabel();
  run("bash", [join(repoRoot, "scripts", "backup-volcano-workspaces.sh")], {
    stdio: "inherit",
    env: { ...process.env, VOLCANO_BACKUP_ROOT: workspaceBackupRoot, VOLCANO_BACKUP_LABEL: backupLabel },
  });
  const short = createHash("sha256").update(`${releaseId}:${backupLabel}`).digest("hex").slice(0, 8);
  const runId = `${new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${releaseId.slice(-8)}-${short}`;
  const runDir = join(releaseRoot, "recovery-runs", runId);
  mkdirSync(join(runDir, "candidates"), { recursive: true, mode: 0o700 });
  const items = inventory(join(releaseDir, "workspaces"), join(workspaceBackupRoot, "snapshots", backupLabel));
  writeJson(join(runDir, "request.json"), { runId, targetReleaseId: releaseId, currentWorkspaceBackupLabel: backupLabel, createdAt: new Date().toISOString() });
  writeJson(join(runDir, "inventory.json"), { schemaVersion: 1, runId, targetReleaseId: releaseId, items });
  console.log(`[workspace-rollback] planned ${runId}: ${items.length} differences`);
}

function loadProposal(runDir, runId) {
  const request = JSON.parse(readFileSync(join(runDir, "request.json"), "utf8"));
  const inventoryDocument = JSON.parse(readFileSync(join(runDir, "inventory.json"), "utf8"));
  const proposal = JSON.parse(readFileSync(join(runDir, "proposal.json"), "utf8"));
  if (proposal.runId !== runId || proposal.targetReleaseId !== request.targetReleaseId || !Array.isArray(proposal.items)) {
    fail("proposal identity or items are invalid");
  }
  if (proposal.items.length !== inventoryDocument.items.length) fail("proposal must cover every inventory item exactly once");
  const inventoryByKey = new Map(inventoryDocument.items.map((item) => [`${item.user}/${item.path}`, item]));
  const seen = new Set();
  for (const item of proposal.items) {
    if (!userSet.has(item.user)) fail(`unknown proposal user: ${item.user}`);
    validateRelativePath(item.path);
    const key = `${item.user}/${item.path}`;
    if (seen.has(key)) fail(`duplicate proposal item: ${key}`);
    seen.add(key);
    const source = inventoryByKey.get(key);
    if (!source) fail(`proposal item is not in inventory: ${key}`);
    if (!source.allowedActions.includes(item.action)) fail(`proposal action is not allowed for ${key}: ${item.action}`);
    if (item.currentHash !== source.currentHash || item.targetHash !== source.targetHash) fail(`proposal hashes do not match inventory: ${key}`);
    for (const field of ["rationale", "risk", "verification"]) {
      if (typeof item[field] !== "string" || !item[field].trim()) fail(`proposal ${key} requires ${field}`);
    }
    if (item.action === "merge-candidate") {
      const candidate = join(runDir, "candidates", item.user, item.path);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) fail(`merge candidate is missing: ${key}`);
      if (item.candidateHash !== sha256(candidate)) fail(`merge candidate hash mismatch: ${key}`);
    } else if (item.candidateHash != null) fail(`candidateHash is only allowed for merge-candidate: ${key}`);
  }
  return { request, proposal, inventoryByKey };
}

function validate(runId) {
  const runDir = recoveryPath(runId);
  const { proposal } = loadProposal(runDir, runId);
  writeJson(join(runDir, "validation.json"), { validatedAt: new Date().toISOString(), proposalHash: sha256(join(runDir, "proposal.json")), itemCount: proposal.items.length });
  console.log(`[workspace-rollback] validated ${runId}`);
}

function loadApproval(runDir, runId, approvalPath, confirm, proposal) {
  if (!approvalPath) fail("apply requires --approval=<path>");
  const resolvedApproval = resolve(approvalPath);
  if (!resolvedApproval.startsWith(`${releaseRoot}${sep}`)) fail("approval must be stored under the private release root");
  const approval = JSON.parse(readFileSync(resolvedApproval, "utf8"));
  if (approval.runId !== runId || approval.confirmation !== confirm || !Array.isArray(approval.items)) fail("approval identity or confirmation is invalid");
  const proposalByKey = new Map(proposal.items.map((item) => [`${item.user}/${item.path}`, item]));
  const approvedKeys = new Set();
  for (const approved of approval.items) {
    if (!userSet.has(approved.user)) fail(`unknown approval user: ${approved.user}`);
    validateRelativePath(approved.path);
    const key = `${approved.user}/${approved.path}`;
    if (approvedKeys.has(key)) fail(`duplicate approval item: ${key}`);
    approvedKeys.add(key);
    const proposed = proposalByKey.get(key);
    if (!proposed || !["restore-target", "merge-candidate"].includes(proposed.action)) fail(`approval is not an applicable proposal: ${key}`);
    if (approved.action !== proposed.action || approved.currentHash !== proposed.currentHash) fail(`approval does not match proposal: ${key}`);
    const expectedSourceHash = proposed.action === "restore-target" ? proposed.targetHash : proposed.candidateHash;
    if (approved.sourceHash !== expectedSourceHash) fail(`approval source hash does not match proposal: ${key}`);
  }
  return { approval, proposalByKey };
}

function assertSafeLocalTarget(root, user, path) {
  const userRoot = join(root, user);
  if (!existsSync(userRoot) || !statSync(userRoot).isDirectory()) fail(`local target user directory missing: ${user}`);
  let current = userRoot;
  for (const part of dirname(path).split("/").filter((value) => value && value !== ".")) {
    current = join(current, part);
    if (!existsSync(current) || !statSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) {
      fail(`local target parent is missing or unsafe: ${user}/${path}`);
    }
  }
  if (!realpathSync(dirname(join(userRoot, path))).startsWith(`${realpathSync(userRoot)}${sep}`)
    && dirname(join(userRoot, path)) !== userRoot) fail(`local target escapes user root: ${user}/${path}`);
}

function applyLocal(runId, approvalPath, confirm) {
  if (confirm !== "apply-approved-workspace-files-v1") fail("apply requires --confirm=apply-approved-workspace-files-v1");
  const targetRootValue = process.env.WORKSPACE_ROLLBACK_LOCAL_TARGET_ROOT;
  if (!targetRootValue) fail("WORKSPACE_ROLLBACK_LOCAL_TARGET_ROOT is required for isolated acceptance");
  const targetRoot = resolve(targetRootValue);
  if (targetRoot === "/" || targetRoot === releaseRoot || targetRoot === workspaceBackupRoot) fail("unsafe local target root");
  const runDir = recoveryPath(runId);
  const { request, proposal } = loadProposal(runDir, runId);
  const { approval, proposalByKey } = loadApproval(runDir, runId, approvalPath, confirm, proposal);
  const applied = [];
  for (const approved of approval.items) {
    const key = `${approved.user}/${approved.path}`;
    const proposed = proposalByKey.get(key);
    const destination = join(targetRoot, approved.user, approved.path);
    assertSafeLocalTarget(targetRoot, approved.user, approved.path);
    const actualHash = existsSync(destination) && statSync(destination).isFile() ? sha256(destination) : null;
    if (actualHash !== proposed.currentHash) fail(`current input drifted after proposal: ${key}`);
    const source = proposed.action === "restore-target"
      ? join(releasePath(request.targetReleaseId), "workspaces", approved.user, approved.path)
      : join(runDir, "candidates", approved.user, approved.path);
    const expectedSourceHash = proposed.action === "restore-target" ? proposed.targetHash : proposed.candidateHash;
    if (!existsSync(source) || sha256(source) !== expectedSourceHash || approved.sourceHash !== expectedSourceHash) fail(`approved source hash mismatch: ${key}`);
    if (existsSync(destination)) {
      const backup = join(runDir, "pre-apply-backup", approved.user, approved.path);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(destination, backup);
    }
    const temporary = `${destination}.rollback-${process.pid}.tmp`;
    copyFileSync(source, temporary);
    chmodSync(temporary, existsSync(destination) ? statSync(destination).mode & 0o777 : 0o600);
    renameSync(temporary, destination);
    applied.push({ user: approved.user, path: approved.path, action: approved.action, beforeHash: actualHash, afterHash: sha256(destination) });
    writeJson(join(runDir, "apply-log.json"), { updatedAt: new Date().toISOString(), mode: "isolated-local", complete: false, applied });
  }
  writeJson(join(runDir, "apply-log.json"), { appliedAt: new Date().toISOString(), mode: "isolated-local", complete: true, applied });
  console.log(`[workspace-rollback] applied ${applied.length} approved files in isolated local target`);
}

function remoteHash(user, path) {
  const destination = `${remoteWorkspaceRoot}/${user}/${path}`;
  const command = `set -eu; p=${shellQuote(destination)}; if [ -L "$p" ]; then echo SYMLINK; elif [ -f "$p" ]; then sha256sum "$p" | awk '{print $1}'; elif [ -e "$p" ]; then echo NONFILE; else echo MISSING; fi`;
  return run("ssh", [remoteHost, command]).trim();
}

function applyProduction(runId, approvalPath, confirm) {
  if (confirm !== "apply-approved-workspace-files-v1") fail("production apply requires --confirm=apply-approved-workspace-files-v1");
  for (const root of [remoteWorkspaceRoot, remoteBackupRoot]) {
    if (!root.startsWith("/") || root === "/") fail(`unsafe remote root: ${root}`);
  }
  const runDir = recoveryPath(runId);
  const { request, proposal } = loadProposal(runDir, runId);
  const { approval, proposalByKey } = loadApproval(runDir, runId, approvalPath, confirm, proposal);

  for (const approved of approval.items) {
    const actual = remoteHash(approved.user, approved.path);
    const expected = approved.currentHash ?? "MISSING";
    if (actual !== expected) fail(`production input drifted before apply: ${approved.user}/${approved.path}`);
  }

  const applied = [];
  for (const approved of approval.items) {
    const key = `${approved.user}/${approved.path}`;
    const proposed = proposalByKey.get(key);
    const source = proposed.action === "restore-target"
      ? join(releasePath(request.targetReleaseId), "workspaces", approved.user, approved.path)
      : join(runDir, "candidates", approved.user, approved.path);
    const expectedSourceHash = proposed.action === "restore-target" ? proposed.targetHash : proposed.candidateHash;
    if (!existsSync(source) || sha256(source) !== expectedSourceHash) fail(`approved source changed before production apply: ${key}`);
    const destination = `${remoteWorkspaceRoot}/${approved.user}/${approved.path}`;
    const backup = `${remoteBackupRoot}/${runId}/${approved.user}/${approved.path}`;
    const temporary = `${destination}.rollback-${runId}.tmp`;
    const expectedCurrent = approved.currentHash ?? "MISSING";
    const command = [
      "set -euo pipefail",
      `destination=${shellQuote(destination)}`,
      `backup=${shellQuote(backup)}`,
      `temporary=${shellQuote(temporary)}`,
      `expected_current=${shellQuote(expectedCurrent)}`,
      `expected_source=${shellQuote(expectedSourceHash)}`,
      "parent=$(dirname \"$destination\")",
      "test -d \"$parent\"",
      "test \"$(realpath -m \"$parent\")\" = \"$parent\"",
      "test ! -L \"$destination\"",
      "if [ -f \"$destination\" ]; then actual=$(sha256sum \"$destination\" | awk '{print $1}'); else actual=MISSING; fi",
      "[ \"$actual\" = \"$expected_current\" ]",
      "mkdir -p \"$(dirname \"$backup\")\"",
      "if [ -f \"$destination\" ]; then cp -p \"$destination\" \"$backup\"; fi",
      "umask 077",
      "cat > \"$temporary\"",
      "actual_source=$(sha256sum \"$temporary\" | awk '{print $1}')",
      "if [ \"$actual_source\" != \"$expected_source\" ]; then rm -f \"$temporary\"; exit 24; fi",
      "if [ -f \"$destination\" ]; then chmod --reference=\"$destination\" \"$temporary\"; else chmod 600 \"$temporary\"; fi",
      "mv \"$temporary\" \"$destination\"",
      "sha256sum \"$destination\" | awk '{print $1}'",
    ].join("; ");
    const afterHash = execFileSync("ssh", [remoteHost, command], { input: readFileSync(source), encoding: "utf8" }).trim();
    if (afterHash !== expectedSourceHash) fail(`production post-apply hash mismatch: ${key}`);
    applied.push({ user: approved.user, path: approved.path, action: approved.action, beforeHash: approved.currentHash, afterHash });
    writeJson(join(runDir, "apply-log.json"), { updatedAt: new Date().toISOString(), mode: "production", complete: false, remoteBackupRoot: `${remoteBackupRoot}/${runId}`, applied });
  }

  const affectedUsers = [...new Set(applied.map((item) => item.user))];
  for (const user of affectedUsers) {
    run("ssh", [remoteHost, `cd /home/claude/invest-agent && npm run workspace:preflight -- --workspace-root=${shellQuote(remoteWorkspaceRoot)} --template-root=/home/claude/invest-agent/templates/workspace --user=${shellQuote(user)}`], { stdio: "inherit" });
  }
  writeJson(join(runDir, "apply-log.json"), { appliedAt: new Date().toISOString(), mode: "production", complete: true, remoteBackupRoot: `${remoteBackupRoot}/${runId}`, applied });
  writeJson(join(runDir, "verification.json"), { verifiedAt: new Date().toISOString(), workspacePreflightUsers: affectedUsers, status: "passed", remainingAcceptance: "targeted read-only ACP acceptance" });
  console.log(`[workspace-rollback] applied ${applied.length} approved files to production; targeted read-only ACP acceptance remains`);
}

const [command, id, ...rest] = process.argv.slice(2);
const option = (name) => rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (command === "plan" && id) plan(id);
else if (command === "validate" && id) validate(id);
else if (command === "apply" && id && option("target") === "production") applyProduction(id, option("approval"), option("confirm"));
else if (command === "apply" && id && option("target") === "isolated-local") applyLocal(id, option("approval"), option("confirm"));
else fail("usage: workspace-rollback.mjs plan <release-id> | validate <run-id> | apply <run-id> --approval=<path> --confirm=apply-approved-workspace-files-v1");
