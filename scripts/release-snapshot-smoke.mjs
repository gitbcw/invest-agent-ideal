#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);
const fixture = mkdtempSync(join(tmpdir(), "invest-agent-release-snapshot-"));
const repo = join(fixture, "repo");
const workspaces = join(fixture, "source-workspaces");
const workspaceBackups = join(fixture, "workspace-backups");
const releases = join(fixture, "releases");

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: options.cwd ?? repo, encoding: "utf8", env: options.env ?? process.env });
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
  writeFileSync(join(repo, "scripts", name), readFileSync(source));
}
writeFileSync(join(repo, "scripts", "deploy-volcano.sh"), `#!/usr/bin/env bash
set -euo pipefail
test ! -d workspaces
printf '%s %s %s\\n' "\${RELEASE_ID}" "\${RELEASE_COMMIT}" "\${RELEASE_OPERATION}" > "\${FAKE_DEPLOY_LOG}"
`);
run("git", ["init", "-b", "main"]);
run("git", ["config", "user.email", "smoke@example.invalid"]);
run("git", ["config", "user.name", "Release Smoke"]);
run("git", ["add", "."]);
run("git", ["commit", "-m", "fixture"]);

const env = {
  ...process.env,
  INVEST_AGENT_RELEASE_ROOT: releases,
  VOLCANO_BACKUP_ROOT: workspaceBackups,
  VOLCANO_BACKUP_LOCAL_SOURCE: workspaces,
  RSYNC_BIN: "/usr/bin/rsync",
  FAKE_DEPLOY_LOG: join(fixture, "deploy.log"),
};
run(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), "create"], { env });
const releaseIds = run("find", [releases, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]).trim().split("\n");
assert.equal(releaseIds.length, 1);
const releaseId = releaseIds[0].split("/").at(-1);
run(process.execPath, [join(repo, "scripts", "release-snapshot.mjs"), "verify", releaseId], { env });
assert.match(readFileSync(join(releases, releaseId, "workspace-manifest.txt"), "utf8"), /excluded=.*\.sandbox-token/);
const forbidden = run("find", [join(releases, releaseId, "workspaces"), "-name", ".sandbox-token"]).trim();
assert.equal(forbidden, "");
assert.equal(readFileSync(join(releases, releaseId, "manifest.json"), "utf8").includes('"state": "candidate"'), true);
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
