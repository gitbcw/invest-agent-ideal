#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), "invest-agent-release-snapshot-"));
const repo = join(fixture, "repo");
const origin = join(fixture, "origin.git");
const workspaces = join(fixture, "source-workspaces");
const workspaceBackups = join(fixture, "workspace-backups");
const releases = join(fixture, "releases");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: options.cwd ?? repo, encoding: "utf8", env: options.env ?? process.env });
}

function result(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

function expectRejected(args, pattern, options = {}) {
  const rejected = result(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), ...args], options);
  assert.notEqual(rejected.status, 0, `expected rejection for ${args.join(" ")}`);
  if (pattern) assert.match(`${rejected.stdout}\n${rejected.stderr}`, pattern);
  return rejected;
}

mkdirSync(join(repo, "scripts"), { recursive: true });
mkdirSync(join(repo, "templates", "workspace", ".codex", "skills", "fixture"), { recursive: true });
for (const user of ["111", "dyk", "mg"]) {
  mkdirSync(join(workspaces, user, ".codex", "skills", "custom"), { recursive: true });
  writeFileSync(join(workspaces, user, "AGENTS.md"), `# ${user}\n`);
  writeFileSync(join(workspaces, user, ".codex", "skills", "custom", "SKILL.md"), "fixture\n");
  writeFileSync(join(workspaces, user, ".sandbox-token"), "must-not-copy\n");
}
writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { verify: "node -e \"console.log('fixture verify passed')\"" } }));
writeFileSync(join(repo, "templates", "workspace", ".codex", "skills", "fixture", "SKILL.md"), "system skill\n");
for (const name of ["release-snapshot.mjs", "release-deploy.mjs", "workspace-rollback.mjs", "backup-volcano-workspaces.sh"]) {
  const source = join(projectRoot, "scripts", name);
  const sourceText = readFileSync(source, "utf8");
  writeFileSync(join(repo, "scripts", name), name === "release-snapshot.mjs"
    ? sourceText.replace(
      'const canonicalRepositoryRoot = "/Users/combo/MyFile/projects/invest-agent-ideal-mastra";',
      `const canonicalRepositoryRoot = ${JSON.stringify(repo)};`,
    )
    : sourceText);
}
writeFileSync(join(repo, "scripts", "deploy-volcano.sh"), `#!/usr/bin/env bash
set -euo pipefail
test ! -d workspaces
printf '%s %s %s\\n' "\${RELEASE_ID}" "\${RELEASE_COMMIT}" "\${RELEASE_OPERATION}" > "\${FAKE_DEPLOY_LOG}"
`);
run("git", ["init", "-b", "feat/mastra-migration"]);
run("git", ["config", "user.email", "smoke@example.invalid"]);
run("git", ["config", "user.name", "Release Smoke"]);
run("git", ["add", "."]);
run("git", ["commit", "-m", "fixture"]);
run("git", ["init", "--bare", origin], { cwd: fixture });
// Point the bare origin HEAD at the baseline branch so clones check it out
// (init.defaultBranch on the host may still be another branch).
run("git", ["symbolic-ref", "HEAD", "refs/heads/feat/mastra-migration"], { cwd: origin });
run("git", ["remote", "add", "origin", origin]);
run("git", ["push", "-u", "origin", "feat/mastra-migration"]);

const env = {
  ...process.env,
  NODE_ENV: "test",
  INVEST_AGENT_RELEASE_ROOT: releases,
  VOLCANO_BACKUP_ROOT: workspaceBackups,
  VOLCANO_BACKUP_LOCAL_SOURCE: workspaces,
  RSYNC_BIN: "/usr/bin/rsync",
  FAKE_DEPLOY_LOG: join(fixture, "deploy.log"),
};
const snapshotScript = join(repo, "scripts", "release-snapshot.mjs");
const releaseNamePattern = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
function releaseNames() {
  return readdirSync(releases).filter((name) => releaseNamePattern.test(name)).sort();
}

run(process.execPath, [snapshotScript, "create"], { env });
const initialReleaseIds = releaseNames();
assert.equal(initialReleaseIds.length, 1);
const releaseId = initialReleaseIds[0];
run(process.execPath, [snapshotScript, "verify", releaseId], { env });
const initialManifest = JSON.parse(readFileSync(join(releases, releaseId, "manifest.json"), "utf8"));
assert.equal(initialManifest.schemaVersion, 2);
assert.equal(initialManifest.sourceControl.mode, "committed-local-baseline");
assert.equal(initialManifest.sourceControl.head, initialManifest.commit);
assert.equal(initialManifest.sourceControl.originMain, initialManifest.commit);
assert.equal(initialManifest.sourceControl.fetchSucceeded, true);
assert.equal(initialManifest.sourceControl.originRelation, "equal");
assert.match(readFileSync(join(releases, releaseId, "workspace-manifest.txt"), "utf8"), /excluded=.*\.sandbox-token/);
const forbidden = run("find", [join(releases, releaseId, "workspaces"), "-name", ".sandbox-token"]).trim();
assert.equal(forbidden, "");
assert.equal(readFileSync(join(releases, releaseId, "manifest.json"), "utf8").includes('"state": "candidate"'), true);

const legacyId = "20260727T000000Z-00000000";
const legacyPath = join(releases, legacyId);
cpSync(join(releases, releaseId), legacyPath, { recursive: true });
const legacyManifest = JSON.parse(readFileSync(join(legacyPath, "manifest.json"), "utf8"));
legacyManifest.releaseId = legacyId;
legacyManifest.schemaVersion = 1;
delete legacyManifest.sourceControl;
writeFileSync(join(legacyPath, "manifest.json"), `${JSON.stringify(legacyManifest, null, 2)}\n`);
rewriteChecksums(legacyPath);
run(process.execPath, [snapshotScript, "verify", legacyId], { env });

const legacyV2NormalId = "20260727T000001Z-00000001";
const legacyV2NormalPath = join(releases, legacyV2NormalId);
cpSync(join(releases, releaseId), legacyV2NormalPath, { recursive: true });
const legacyV2NormalManifest = JSON.parse(readFileSync(join(legacyV2NormalPath, "manifest.json"), "utf8"));
legacyV2NormalManifest.releaseId = legacyV2NormalId;
legacyV2NormalManifest.sourceControl = {
  mode: "normal",
  head: legacyV2NormalManifest.commit,
  originMain: legacyV2NormalManifest.commit,
  fetchSucceeded: true,
};
writeFileSync(join(legacyV2NormalPath, "manifest.json"), `${JSON.stringify(legacyV2NormalManifest, null, 2)}\n`);
rewriteChecksums(legacyV2NormalPath);
run(process.execPath, [snapshotScript, "verify", legacyV2NormalId], { env });

const dirtyProbe = join(repo, "dirty-probe.txt");
writeFileSync(dirtyProbe, "dirty\n");
expectRejected(["create"], /clean worktree/, { env });
rmSync(dirtyProbe);
run("git", ["switch", "-c", "release-smoke-feature"]);
expectRejected(["create"], /requires branch feat\/mastra-migration/, { env });
run("git", ["switch", "feat/mastra-migration"]);

run("git", ["commit", "--allow-empty", "-m", "unpublished"]);
run(process.execPath, [snapshotScript, "create"], { env });
const aheadReleaseId = releaseNames().find((name) => ![releaseId, legacyId, legacyV2NormalId].includes(name));
assert.ok(aheadReleaseId);
const aheadManifest = JSON.parse(readFileSync(join(releases, aheadReleaseId, "manifest.json"), "utf8"));
assert.equal(aheadManifest.sourceControl.mode, "committed-local-baseline");
assert.equal(aheadManifest.sourceControl.originRelation, "ahead");
assert.equal(aheadManifest.sourceControl.fetchSucceeded, true);

const legacyV2EmergencyId = "20260727T000002Z-00000002";
const legacyV2EmergencyPath = join(releases, legacyV2EmergencyId);
cpSync(join(releases, aheadReleaseId), legacyV2EmergencyPath, { recursive: true });
const legacyV2EmergencyManifest = JSON.parse(readFileSync(join(legacyV2EmergencyPath, "manifest.json"), "utf8"));
legacyV2EmergencyManifest.releaseId = legacyV2EmergencyId;
legacyV2EmergencyManifest.sourceControl = {
  mode: "emergency-unpushed-main",
  head: legacyV2EmergencyManifest.commit,
  originMain: initialManifest.commit,
  fetchSucceeded: true,
};
writeFileSync(join(legacyV2EmergencyPath, "manifest.json"), `${JSON.stringify(legacyV2EmergencyManifest, null, 2)}\n`);
rewriteChecksums(legacyV2EmergencyPath);
run(process.execPath, [snapshotScript, "verify", legacyV2EmergencyId], { env });

run("git", ["remote", "set-url", "origin", join(fixture, "missing-origin.git")]);
run("git", ["update-ref", "-d", "refs/remotes/origin/feat/mastra-migration"]);
run("git", ["commit", "--allow-empty", "-m", "remote unavailable"]);
run(process.execPath, [snapshotScript, "create"], { env });
const unavailableReleaseId = releaseNames().find((name) => ![
  releaseId, legacyId, legacyV2NormalId, aheadReleaseId, legacyV2EmergencyId,
].includes(name));
assert.ok(unavailableReleaseId);
const unavailableManifest = JSON.parse(readFileSync(join(releases, unavailableReleaseId, "manifest.json"), "utf8"));
assert.equal(unavailableManifest.sourceControl.mode, "committed-local-baseline");
assert.equal(unavailableManifest.sourceControl.fetchSucceeded, false);
assert.equal(unavailableManifest.sourceControl.originMain, null);
assert.equal(unavailableManifest.sourceControl.originRelation, "unavailable");

const standaloneVerifier = join(fixture, "standalone-verifier");
mkdirSync(join(standaloneVerifier, "scripts"), { recursive: true });
writeFileSync(join(standaloneVerifier, "scripts", "release-snapshot.mjs"), readFileSync(snapshotScript));
run(process.execPath, [
  join(standaloneVerifier, "scripts", "release-snapshot.mjs"),
  "verify",
  unavailableReleaseId,
], { cwd: standaloneVerifier, env });

run("git", ["remote", "set-url", "origin", origin]);
run("git", ["push", "origin", "feat/mastra-migration"]);
const remoteClone = join(fixture, "remote-clone");
run("git", ["clone", origin, remoteClone], { cwd: fixture });
run("git", ["config", "user.email", "remote-smoke@example.invalid"], { cwd: remoteClone });
run("git", ["config", "user.name", "Remote Smoke"], { cwd: remoteClone });
run("git", ["commit", "--allow-empty", "-m", "remote ahead"] , { cwd: remoteClone });
run("git", ["push", "origin", "feat/mastra-migration"], { cwd: remoteClone });
run(process.execPath, [snapshotScript, "create"], { env });
const behindReleaseId = releaseNames().find((name) => ![
  releaseId, legacyId, legacyV2NormalId, aheadReleaseId, legacyV2EmergencyId, unavailableReleaseId,
].includes(name));
assert.ok(behindReleaseId);
const behindManifest = JSON.parse(readFileSync(join(releases, behindReleaseId, "manifest.json"), "utf8"));
assert.equal(behindManifest.sourceControl.originRelation, "behind");
assert.equal(behindManifest.sourceControl.fetchSucceeded, true);
run("git", ["commit", "--allow-empty", "-m", "local diverged"]);
run(process.execPath, [snapshotScript, "create"], { env });
const divergedReleaseId = releaseNames().find((name) => ![
  releaseId, legacyId, legacyV2NormalId, aheadReleaseId, legacyV2EmergencyId, unavailableReleaseId, behindReleaseId,
].includes(name));
assert.ok(divergedReleaseId);
const divergedManifest = JSON.parse(readFileSync(join(releases, divergedReleaseId, "manifest.json"), "utf8"));
assert.equal(divergedManifest.sourceControl.originRelation, "diverged");
run("git", ["checkout", "--orphan", "force-main"], { cwd: remoteClone });
run("git", ["rm", "-rf", "."], { cwd: remoteClone });
writeFileSync(join(remoteClone, "force-push.txt"), "force-push\n");
run("git", ["add", "force-push.txt"], { cwd: remoteClone });
run("git", ["commit", "-m", "force-pushed baseline"], { cwd: remoteClone });
const forcePushedCommit = run("git", ["rev-parse", "HEAD"], { cwd: remoteClone }).trim();
run("git", ["push", "--force", "origin", "HEAD:feat/mastra-migration"], { cwd: remoteClone });
run("git", ["fetch", "--no-tags", "origin", "+refs/heads/feat/mastra-migration:refs/remotes/origin/feat/mastra-migration"]);
assert.equal(run("git", ["rev-parse", "refs/remotes/origin/feat/mastra-migration"]).trim(), forcePushedCommit);

const nonCanonicalRepo = join(fixture, "noncanonical-repo");
const nonCanonicalScript = join(nonCanonicalRepo, "scripts", "release-snapshot.mjs");
mkdirSync(join(nonCanonicalRepo, "scripts"), { recursive: true });
writeFileSync(nonCanonicalScript, readFileSync(snapshotScript));
const nonCanonicalRejected = spawnSync(process.execPath, [nonCanonicalScript, "create"], {
  cwd: nonCanonicalRepo,
  env,
  encoding: "utf8",
});
assert.notEqual(nonCanonicalRejected.status, 0);
assert.match(`${nonCanonicalRejected.stdout}\n${nonCanonicalRejected.stderr}`, /canonical repository root/);

run(process.execPath, [join(repo, "scripts", "release-deploy.mjs"), "deploy", releaseId], { env });
assert.equal(existsSync(join(releases, releaseId, "status", "deployed.json")), true);
assert.match(readFileSync(env.FAKE_DEPLOY_LOG, "utf8"), new RegExp(`${releaseId} [0-9a-f]{40} deploy`));
const workspaceProbe = join(releases, releaseId, "workspaces", "111", "AGENTS.md");
const workspaceProbeOriginal = readFileSync(workspaceProbe);
writeFileSync(workspaceProbe, "tampered workspace\n");
const workspaceRejected = spawnSync(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), "verify", releaseId], { cwd: repo, env, encoding: "utf8" });
assert.notEqual(workspaceRejected.status, 0);
assert.match(workspaceRejected.stderr, /workspace content manifest mismatch/);
writeFileSync(workspaceProbe, workspaceProbeOriginal);

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rewriteChecksums(path) {
  const names = ["manifest.json", "source.bundle", "source.tar.gz", "workspace-manifest.txt"];
  writeFileSync(join(path, "checksums.sha256"), `${names.map((name) => `${digest(join(path, name))}  ${name}`).join("\n")}\n`);
}

for (const syntheticId of [
  "20260727T010001Z-00000001",
  "20260727T010002Z-00000002",
  "20260727T010003Z-00000003",
  "20260727T010004Z-00000004",
]) {
  const syntheticPath = join(releases, syntheticId);
  cpSync(join(releases, releaseId), syntheticPath, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(syntheticPath, "manifest.json"), "utf8"));
  manifest.releaseId = syntheticId;
  writeFileSync(join(syntheticPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  rewriteChecksums(syntheticPath);
  writeFileSync(join(syntheticPath, "status", "deployed.json"), `${JSON.stringify({
    releaseId: syntheticId,
    commit: manifest.commit,
    operation: "deploy",
    completedAt: new Date().toISOString(),
  })}\n`);
  run(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), "accept", syntheticId, "--confirm=mark-known-good-v1"], { env });
}
const knownGood = readdirSync(releases)
  .filter((name) => existsSync(join(releases, name, "status", "accepted.json")));
assert.deepEqual(knownGood.sort(), [
  "20260727T010002Z-00000002",
  "20260727T010003Z-00000003",
  "20260727T010004Z-00000004",
]);
run(process.execPath, [
  join(repo, "scripts", "release-deploy.mjs"),
  "rollback",
  "20260727T010004Z-00000004",
  "--confirm=rollback-code-v1",
], { env });
assert.match(readFileSync(env.FAKE_DEPLOY_LOG, "utf8"), /20260727T010004Z-00000004 [0-9a-f]{40} rollback/);
const recoveryRuns = readdirSync(join(releases, "recovery-runs"));
assert.equal(recoveryRuns.length, 1);
assert.equal(existsSync(join(releases, "recovery-runs", recoveryRuns[0], "deployment.json")), true);

writeFileSync(join(workspaces, "111", "AGENTS.md"), "# 111\ncurrent user adjustment\n");
run(process.execPath, [
  join(repo, "scripts", "workspace-rollback.mjs"),
  "plan",
  "20260727T010004Z-00000004",
], { env });
const workspaceRun = readdirSync(join(releases, "recovery-runs"))
  .find((name) => existsSync(join(releases, "recovery-runs", name, "inventory.json")));
assert.ok(workspaceRun);
const workspaceRunDir = join(releases, "recovery-runs", workspaceRun);
const inventory = JSON.parse(readFileSync(join(workspaceRunDir, "inventory.json"), "utf8"));
assert.equal(inventory.items.length, 1);
assert.equal(inventory.items[0].path, "AGENTS.md");
const candidatePath = join(workspaceRunDir, "candidates", "111", "AGENTS.md");
mkdirSync(join(workspaceRunDir, "candidates", "111"), { recursive: true });
writeFileSync(candidatePath, "# 111\nmerged and reviewed\n");
const proposalItem = {
  ...inventory.items[0],
  action: "merge-candidate",
  candidateHash: digest(candidatePath),
  rationale: "Preserve the valid user heading while removing the fixture regression.",
  risk: "The free-form user note changes.",
  verification: "Read the isolated file and rerun workspace preflight.",
};
writeFileSync(join(workspaceRunDir, "proposal.json"), `${JSON.stringify({
  runId: workspaceRun,
  targetReleaseId: inventory.targetReleaseId,
  items: [proposalItem],
}, null, 2)}\n`);
run(process.execPath, [join(repo, "scripts", "workspace-rollback.mjs"), "validate", workspaceRun], { env });
const approvalPath = join(workspaceRunDir, "approval.json");
writeFileSync(approvalPath, `${JSON.stringify({
  runId: workspaceRun,
  confirmation: "apply-approved-workspace-files-v1",
  items: [{
    user: "111",
    path: "AGENTS.md",
    action: "merge-candidate",
    currentHash: proposalItem.currentHash,
    sourceHash: proposalItem.candidateHash,
  }],
}, null, 2)}\n`);
run(process.execPath, [
  join(repo, "scripts", "workspace-rollback.mjs"),
  "apply",
  workspaceRun,
  `--approval=${approvalPath}`,
  "--confirm=apply-approved-workspace-files-v1",
  "--target=isolated-local",
], { env: { ...env, WORKSPACE_ROLLBACK_LOCAL_TARGET_ROOT: workspaces } });
assert.equal(readFileSync(join(workspaces, "111", "AGENTS.md"), "utf8"), "# 111\nmerged and reviewed\n");
assert.equal(existsSync(join(workspaceRunDir, "pre-apply-backup", "111", "AGENTS.md")), true);

writeFileSync(join(releases, releaseId, "source.tar.gz"), "tampered");
const rejected = spawnSync(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), "verify", releaseId], { cwd: repo, env, encoding: "utf8" });
assert.notEqual(rejected.status, 0);
assert.match(rejected.stderr, /checksum mismatch/);

console.log("release snapshot smoke passed");
