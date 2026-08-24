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
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRepositoryRoot = "/Users/combo/MyFile/projects/invest-agent-ideal-mastra";
const baselineBranch = process.env.INVEST_AGENT_RELEASE_BRANCH ?? "feat/mastra-migration";
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

function ensureBaselineAndClean() {
  const branch = run("git", ["branch", "--show-current"]).trim();
  if (branch !== baselineBranch) fail(`snapshot creation requires branch ${baselineBranch}, found ${branch || "detached HEAD"}`);
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"]);
  if (status.trim()) fail("snapshot creation requires a clean worktree");
}

function realpathOrFail(path, label) {
  try {
    return resolve(realpathSync(path));
  } catch {
    fail(`${label} does not exist or cannot be resolved: ${resolve(path)}`);
  }
}

function assertCanonicalRepository() {
  const actualRoot = realpathOrFail(repoRoot, "repository root");
  const expectedRoot = realpathOrFail(canonicalRepositoryRoot, "canonical repository root");
  if (actualRoot !== expectedRoot) {
    fail(`snapshot creation requires canonical repository root ${expectedRoot}, found ${actualRoot}`);
  }
}

// Historical v2 manifests call this field `originMain`; keep the name so old
// releases stay verifiable. For new snapshots it records the origin baseline
// branch commit (see `baselineBranch` in the same object).
function originMainCommit() {
  try {
    return run("git", ["rev-parse", "--verify", `refs/remotes/origin/${baselineBranch}^{commit}`]).trim();
  } catch {
    return null;
  }
}

function isCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isStrictAncestor(ancestor, descendant, cwd = repoRoot) {
  if (!isCommit(ancestor) || !isCommit(descendant) || ancestor === descendant) return false;
  try {
    run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

function originRelation(head, originMain) {
  if (!originMain) return "unavailable";
  if (head === originMain) return "equal";
  if (isStrictAncestor(originMain, head)) return "ahead";
  if (isStrictAncestor(head, originMain)) return "behind";
  return "diverged";
}

function inspectSourceBundle(bundlePath, manifest) {
  const temporary = mkdtempSync(join(tmpdir(), "invest-agent-release-bundle-"));
  try {
    run("git", ["init", "--quiet", "--bare", temporary]);
    run("git", ["bundle", "verify", bundlePath], { cwd: temporary });
    const bundleHeads = run("git", ["bundle", "list-heads", bundlePath], { cwd: temporary });
    const headMatches = bundleHeads.split("\n").some((line) => line.startsWith(`${manifest.commit} `));
    let emergencyAncestryValid = true;
    if (manifest.schemaVersion === 2 && manifest.sourceControl.mode === "emergency-unpushed-main") {
      run("git", ["fetch", "--quiet", "--no-tags", bundlePath, "HEAD:refs/heads/release"], { cwd: temporary });
      emergencyAncestryValid = isStrictAncestor(
        manifest.sourceControl.originMain,
        manifest.sourceControl.head,
        temporary,
      );
    }
    return { headMatches, emergencyAncestryValid };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function sourceControlGate() {
  let fetchSucceeded = false;
  try {
    run("git", ["fetch", "--no-tags", "origin", `+refs/heads/${baselineBranch}:refs/remotes/origin/${baselineBranch}`], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    fetchSucceeded = true;
  } catch {
    // Remote state is audit evidence only; a committed local baseline remains releasable.
  }

  const head = run("git", ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!isCommit(head)) fail("source-control gate requires HEAD to resolve to a commit");
  const originMain = originMainCommit();
  return {
    mode: "committed-local-baseline",
    head,
    originMain,
    fetchSucceeded,
    originRelation: originRelation(head, originMain),
    baselineBranch,
  };
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
  assertCanonicalRepository();
  assertPrivateRoot();
  ensureBaselineAndClean();
  const sourceControl = sourceControlGate();
  if (!Number.isInteger(retention) || retention < 3) fail("release retention must be an integer >= 3");

  console.log("[release-snapshot] run repository verification");
  run("npm", ["run", "verify"], { stdio: "inherit" });
  ensureBaselineAndClean();
  const verifiedHead = run("git", ["rev-parse", "HEAD"]).trim();
  if (verifiedHead !== sourceControl.head) {
    fail("repository HEAD changed during verification");
  }
  const commit = sourceControl.head;
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

  // Workspace capture can take long enough for a local source change. Recheck
  // immediately before archiving so the source and manifest remain aligned.
  ensureBaselineAndClean();
  if (run("git", ["rev-parse", "HEAD"]).trim() !== commit) {
    fail("repository HEAD changed before archive");
  }

  console.log(`[release-snapshot] archive system commit ${commit}`);
  run("git", ["bundle", "create", join(releaseDir, "source.bundle"), "HEAD"]);
  run("git", ["archive", "--format=tar.gz", `--output=${join(releaseDir, "source.tar.gz")}`, commit]);
  cloneWorkspaceSnapshot(workspaceSource, join(releaseDir, "workspaces"));
  copyFileSync(workspaceManifest, join(releaseDir, "workspace-manifest.txt"));

  const manifest = {
    schemaVersion: 2,
    releaseId,
    state: "candidate",
    commit,
    branch: baselineBranch,
    createdAt: new Date().toISOString(),
    sourceControl,
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
  // Releases created before the feat/mastra-migration cutover record
  // branch "main"; both identities remain verifiable.
  if (manifest.releaseId !== releaseId || !["main", baselineBranch].includes(manifest.branch) || !isCommit(manifest.commit)) {
    fail("invalid release manifest identity");
  }
  if (manifest.schemaVersion === 2) {
    const sourceControl = manifest.sourceControl;
    if (!sourceControl || typeof sourceControl !== "object"
      || !["normal", "emergency-unpushed-main", "committed-local-main", "committed-local-baseline"].includes(sourceControl.mode)
      || sourceControl.head !== manifest.commit
      || !isCommit(sourceControl.head)
      || typeof sourceControl.fetchSucceeded !== "boolean") {
      fail("invalid release source-control gate evidence");
    }
    if (sourceControl.baselineBranch !== undefined && sourceControl.baselineBranch !== manifest.branch) {
      fail("release source-control baseline branch does not match manifest branch");
    }
    if (sourceControl.originMain !== null && !isCommit(sourceControl.originMain)) {
      fail("invalid release source-control origin evidence");
    }
    if (sourceControl.mode === "normal"
      && (sourceControl.fetchSucceeded !== true || sourceControl.originMain !== sourceControl.head)) {
      fail("invalid normal source-control gate evidence");
    }
    if (sourceControl.mode === "emergency-unpushed-main"
      && sourceControl.originMain === sourceControl.head) {
      fail("invalid emergency source-control gate evidence");
    }
    if (sourceControl.mode === "committed-local-main"
      || sourceControl.mode === "committed-local-baseline") {
      const relations = ["equal", "ahead", "behind", "diverged", "unavailable"];
      if (!relations.includes(sourceControl.originRelation)
        || (sourceControl.originMain === null) !== (sourceControl.originRelation === "unavailable")
        || (sourceControl.originRelation === "equal" && sourceControl.originMain !== sourceControl.head)
        || (sourceControl.originRelation !== "equal" && sourceControl.originMain === sourceControl.head)) {
        fail("invalid committed-local-main source-control evidence");
      }
    }
  } else if (manifest.schemaVersion !== 1) {
    fail("unsupported release manifest schema");
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
  const bundleInspection = inspectSourceBundle(join(releaseDir, "source.bundle"), manifest);
  if (!bundleInspection.headMatches) {
    fail("release bundle does not contain manifest commit");
  }
  if (manifest.schemaVersion === 2
    && manifest.sourceControl.mode === "emergency-unpushed-main"
    && !bundleInspection.emergencyAncestryValid) {
    fail("invalid emergency source-control ancestry");
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

const [command, ...args] = process.argv.slice(2);
const confirm = args.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
const positional = args.filter((arg) => !arg.startsWith("--"));
const releaseId = positional[0];
if (command === "create" && positional.length === 0) createSnapshot();
else if (command === "verify" && releaseId) {
  assertPrivateRoot();
  verifyRelease(releaseId);
} else if (command === "accept" && releaseId) {
  assertPrivateRoot();
  acceptRelease(releaseId, confirm);
} else fail("usage: release-snapshot.mjs create | verify <release-id> | accept <release-id> --confirm=mark-known-good-v1");
