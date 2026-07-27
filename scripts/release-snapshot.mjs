#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const releaseRoot = resolve(
  process.env.INVEST_AGENT_RELEASE_ROOT
    ?? "/Users/combo/MyFile/my-data/backups/invest-agent/releases",
);
const workspaceBackupRoot = resolve(
  process.env.VOLCANO_BACKUP_ROOT
    ?? "/Users/combo/MyFile/my-data/backups/invest-agent/workspaces",
);
const retention = Number(process.env.INVEST_AGENT_RELEASE_RETENTION ?? "3");

function fail(message) {
  console.error(`[release-snapshot] ERROR: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function assertPrivateRoot() {
  if (!releaseRoot.startsWith(`${resolve(dirname(releaseRoot))}${sep}`)) {
    fail(`invalid release root: ${releaseRoot}`);
  }
  if (["/", resolve(process.env.HOME ?? "/nonexistent")].includes(releaseRoot)) {
    fail(`release root is too broad: ${releaseRoot}`);
  }
  const sentinel = join(releaseRoot, ".invest-agent-release-root");
  if (existsSync(releaseRoot) && lstatSync(releaseRoot).isSymbolicLink()) fail("release root must not be a symlink");
  if (existsSync(releaseRoot) && !existsSync(sentinel) && readdirSync(releaseRoot).length > 0) {
    fail(`release root is not initialized and is not empty: ${releaseRoot}`);
  }
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  chmodSync(releaseRoot, 0o700);
  if (!existsSync(sentinel)) writeFileSync(sentinel, "invest-agent-release-root-v1\n", { mode: 0o600 });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function timestamp() {
  return new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function localBackupLabel(date = new Date()) {
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
  fail("could not allocate a unique workspace backup label");
}

function ensureMainAndClean() {
  const branch = run("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") fail(`snapshot creation requires branch main, found ${branch || "detached HEAD"}`);
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.trim()) fail("snapshot creation requires a clean worktree");
}

function cloneWorkspaceSnapshot(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destinationPath, { mode: statSync(sourcePath).mode & 0o777 });
      cloneWorkspaceSnapshot(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), destinationPath);
    } else if (entry.isFile()) {
      try {
        linkSync(sourcePath, destinationPath);
      } catch (error) {
        if (error.code !== "EXDEV") throw error;
        copyFileSync(sourcePath, destinationPath);
      }
    }
  }
}

function walk(root, visitor, current = root) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    visitor(path, entry);
    if (entry.isDirectory()) walk(root, visitor, path);
  }
}

function verifyWorkspaceSafety(workspaces) {
  const allowed = new Set(["111", "dyk", "mg"]);
  const users = readdirSync(workspaces).sort();
  if (users.join(",") !== [...allowed].sort().join(",")) {
    fail(`workspace snapshot must contain exactly 111, dyk, mg; found ${users.join(",")}`);
  }
  walk(workspaces, (path, entry) => {
    if (entry.isSymbolicLink()) return;
    const rel = relative(workspaces, path);
    const parts = rel.split(sep);
    const codexIndex = parts.indexOf(".codex");
    const codexChild = codexIndex >= 0 ? parts[codexIndex + 1] : undefined;
    if (entry.name === ".sandbox-token"
      || entry.name === ".rsync-partial"
      || entry.name.startsWith("._")
      || (codexIndex >= 0 && (codexChild === "auth.json"
        || codexChild === ".tmp"
        || codexChild === "tmp"
        || codexChild?.startsWith("logs_2.sqlite")))) {
      fail(`forbidden workspace artifact: ${rel}`);
    }
  });
}

function workspaceContentDigest(workspaces) {
  let content = "";
  for (const user of ["111", "dyk", "mg"]) {
    content += `workspace=${user}\n`;
    const root = join(workspaces, user);
    const files = [];
    walk(root, (path, entry) => {
      if (entry.isFile()) files.push(path);
    });
    files.sort((a, b) => Buffer.from(relative(root, a)).compare(Buffer.from(relative(root, b))));
    for (const path of files) content += `${sha256(path)}  ./${relative(root, path)}\n`;
  }
  return createHash("sha256").update(content).digest("hex");
}

function checksumsFor(releaseDir) {
  const names = ["manifest.json", "source.bundle", "source.tar.gz", "workspace-manifest.txt"];
  return names.map((name) => `${sha256(join(releaseDir, name))}  ${name}`).join("\n") + "\n";
}

function createSnapshot() {
  assertPrivateRoot();
  ensureMainAndClean();
  if (!Number.isInteger(retention) || retention < 3) fail("release retention must be an integer >= 3");

  console.log("[release-snapshot] run repository verification");
  run("npm", ["run", "verify"], { stdio: "inherit" });
  const commit = run("git", ["rev-parse", "HEAD"]).trim();
  const releaseId = `${timestamp().replace("Z", "Z-")}${commit.slice(0, 8)}`;
  const releaseDir = join(releaseRoot, releaseId);
  if (existsSync(releaseDir)) fail(`release already exists: ${releaseId}`);
  mkdirSync(join(releaseDir, "status"), { recursive: true, mode: 0o700 });

  const backupLabel = nextBackupLabel();
  console.log(`[release-snapshot] create verified workspace snapshot ${backupLabel}`);
  run("bash", [join(repoRoot, "scripts/backup-volcano-workspaces.sh")], {
    stdio: "inherit",
    env: { ...process.env, VOLCANO_BACKUP_ROOT: workspaceBackupRoot, VOLCANO_BACKUP_LABEL: backupLabel },
  });
  const workspaceSource = join(workspaceBackupRoot, "snapshots", backupLabel);
  const workspaceManifest = join(workspaceBackupRoot, "manifests", `${backupLabel}.txt`);
  if (!existsSync(workspaceSource) || !existsSync(workspaceManifest)) fail("workspace backup did not publish expected artifacts");
  verifyWorkspaceSafety(workspaceSource);

  console.log(`[release-snapshot] archive system commit ${commit}`);
  run("git", ["bundle", "create", join(releaseDir, "source.bundle"), "HEAD"]);
  run("git", ["archive", "--format=tar.gz", `--output=${join(releaseDir, "source.tar.gz")}`, commit]);
  cloneWorkspaceSnapshot(workspaceSource, join(releaseDir, "workspaces"));
  copyFileSync(workspaceManifest, join(releaseDir, "workspace-manifest.txt"));

  const manifest = {
    schemaVersion: 1,
    releaseId,
    state: "candidate",
    commit,
    branch: "main",
    createdAt: new Date().toISOString(),
    workspaces: ["111", "dyk", "mg"],
    workspaceBackupLabel: backupLabel,
    excluded: [".sandbox-token", ".codex/auth.json", ".codex/logs_2.sqlite*", ".codex/.tmp", ".codex/tmp", ".rsync-partial", "._*"],
  };
  writeJson(join(releaseDir, "manifest.json"), manifest);
  writeFileSync(join(releaseDir, "checksums.sha256"), checksumsFor(releaseDir), { mode: 0o600 });
  writeJson(join(releaseDir, "status", "created.json"), { createdAt: new Date().toISOString(), verification: "passed" });
  verifyRelease(releaseId);
  console.log(`[release-snapshot] created ${releaseId}`);
}

function resolveRelease(releaseId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(releaseId)) fail(`invalid release id: ${releaseId}`);
  const path = join(releaseRoot, releaseId);
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`release not found: ${releaseId}`);
  if (lstatSync(path).isSymbolicLink()) fail("release path must not be a symlink");
  return path;
}

function verifyRelease(releaseId) {
  const releaseDir = resolveRelease(releaseId);
  const manifest = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8"));
  if (manifest.releaseId !== releaseId || manifest.branch !== "main" || !/^[0-9a-f]{40}$/.test(manifest.commit)) {
    fail("invalid release manifest identity");
  }
  const expected = readFileSync(join(releaseDir, "checksums.sha256"), "utf8");
  if (expected !== checksumsFor(releaseDir)) fail("release artifact checksum mismatch");
  const workspaces = join(releaseDir, "workspaces");
  verifyWorkspaceSafety(workspaces);
  const workspaceManifest = readFileSync(join(releaseDir, "workspace-manifest.txt"), "utf8");
  const recordedWorkspaceDigest = workspaceManifest.match(/^content_manifest_sha256=([0-9a-f]{64})$/m)?.[1];
  if (!recordedWorkspaceDigest || recordedWorkspaceDigest !== workspaceContentDigest(workspaces)) {
    fail("workspace content manifest mismatch");
  }
  run("git", ["bundle", "verify", join(releaseDir, "source.bundle")]);
  const bundleHeads = run("git", ["bundle", "list-heads", join(releaseDir, "source.bundle")]);
  if (!bundleHeads.split("\n").some((line) => line.startsWith(`${manifest.commit} `))) {
    fail("release bundle does not contain manifest commit");
  }
  console.log(`[release-snapshot] verified ${releaseId}`);
}

function acceptRelease(releaseId, confirm) {
  if (confirm !== "mark-known-good-v1") fail("accept requires --confirm=mark-known-good-v1");
  verifyRelease(releaseId);
  const releaseDir = resolveRelease(releaseId);
  const deployed = join(releaseDir, "status", "deployed.json");
  if (!existsSync(deployed)) fail("release cannot be accepted before deployment evidence exists");
  const deployment = JSON.parse(readFileSync(deployed, "utf8"));
  const manifest = JSON.parse(readFileSync(join(releaseDir, "manifest.json"), "utf8"));
  if (deployment.releaseId !== releaseId || deployment.commit !== manifest.commit
    || deployment.operation !== "deploy" || typeof deployment.completedAt !== "string") {
    fail("deployment evidence does not match release manifest");
  }
  writeJson(join(releaseDir, "status", "accepted.json"), {
    releaseId,
    commit: manifest.commit,
    acceptedAt: new Date().toISOString(),
    state: "known-good",
    humanGate: confirm,
  });
  pruneKnownGood();
  console.log(`[release-snapshot] accepted ${releaseId}`);
}

function pruneKnownGood() {
  const accepted = readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(entry.name))
    .map((entry) => ({ name: entry.name, path: join(releaseRoot, entry.name) }))
    .filter(({ path }) => {
      return existsSync(join(path, "status", "accepted.json"));
    })
    .sort((a, b) => b.name.localeCompare(a.name));
  for (const old of accepted.slice(retention)) {
    if (existsSync(join(old.path, ".pin")) || existsSync(join(old.path, ".recovery-in-use"))) continue;
    rmSync(old.path, { recursive: true });
    console.log(`[release-snapshot] pruned old known-good ${old.name}`);
  }
}

const [command, releaseId, ...rest] = process.argv.slice(2);
const confirm = rest.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
assertPrivateRoot();
if (command === "create" && !releaseId) createSnapshot();
else if (command === "verify" && releaseId) verifyRelease(releaseId);
else if (command === "accept" && releaseId) acceptRelease(releaseId, confirm);
else fail("usage: release-snapshot.mjs create | verify <release-id> | accept <release-id> --confirm=mark-known-good-v1");
