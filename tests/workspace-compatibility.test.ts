import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WORKSPACE_MIGRATION_CONFIRMATION,
  inspectWorkspaceCompatibility,
  migrateWorkspaceCompatibility,
} from "../src/lib/workspace-compatibility.js";

const templatePath = path.resolve("templates/workspace");
const managedDailySkill = ".codex/skills/daily-portfolio-review/SKILL.md";

test("workspace compatibility migration backs up and updates only managed assets", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-compat-"));
  const workspacePath = path.join(tempRoot, "workspaces", "111");
  const backupRoot = path.join(tempRoot, "backups");
  const portfolioPath = path.join(workspacePath, "config/portfolio.yaml");
  const customSkillPath = path.join(workspacePath, ".codex/skills/user-custom/SKILL.md");
  const managedSkillPath = path.join(workspacePath, managedDailySkill);
  const oldManagedContent = "legacy daily skill\n";

  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    const originalPortfolio = await readFile(portfolioPath, "utf8");
    await mkdir(path.dirname(customSkillPath), { recursive: true });
    await writeFile(customSkillPath, "user-owned custom skill\n", "utf8");
    await writeFile(managedSkillPath, oldManagedContent, "utf8");

    const report = await inspectWorkspaceCompatibility({ workspacePath, templatePath });
    assert.equal(report.status, "migration_required");
    assert.deepEqual(
      report.managedAssetChanges.filter((change) => change.relativePath === managedDailySkill).map((change) => change.action),
      ["replace"],
    );

    await assert.rejects(
      migrateWorkspaceCompatibility({
        workspacePath,
        templatePath,
        backupRoot,
        confirmation: "wrong-confirmation",
        runId: "test-run",
      }),
      /confirmation must equal/,
    );
    assert.equal(await readFile(managedSkillPath, "utf8"), oldManagedContent);

    const result = await migrateWorkspaceCompatibility({
      workspacePath,
      templatePath,
      backupRoot,
      confirmation: WORKSPACE_MIGRATION_CONFIRMATION,
      runId: "test-run",
    });
    assert.equal(result.changed, true);
    assert.equal(result.changes.length, 1);
    assert.equal(
      await readFile(managedSkillPath, "utf8"),
      await readFile(path.join(templatePath, managedDailySkill), "utf8"),
    );
    assert.equal(
      await readFile(path.join(backupRoot, "test-run", "111", managedDailySkill), "utf8"),
      oldManagedContent,
    );
    assert.equal(await readFile(portfolioPath, "utf8"), originalPortfolio);
    assert.equal(await readFile(customSkillPath, "utf8"), "user-owned custom skill\n");
    assert.equal(existsSync(path.join(workspacePath, ".invest-agent/workspace-compatibility.json")), true);
    assert.equal(existsSync(path.join(backupRoot, "test-run", "111", "manifest.json")), true);

    const repeated = await migrateWorkspaceCompatibility({
      workspacePath,
      templatePath,
      backupRoot,
      confirmation: WORKSPACE_MIGRATION_CONFIRMATION,
      runId: "second-run",
    });
    assert.equal(repeated.changed, false);
    assert.equal(repeated.backupPath, null);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace compatibility preflight blocks invalid required user configuration", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-blocked-"));
  const workspacePath = path.join(tempRoot, "workspaces", "dyk");
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "config/schedules.yaml"), "broken: [\n", "utf8");

    const report = await inspectWorkspaceCompatibility({ workspacePath, templatePath });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers.join("\n"), /invalid YAML.*config\/schedules.yaml/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Volcano code deploy preserves root runtime state but includes nested workspace template skills", async () => {
  const deployScript = await readFile(path.resolve("scripts/deploy-volcano.sh"), "utf8");
  assert.match(deployScript, /--exclude='\/\.codex'/);
  assert.doesNotMatch(deployScript, /--exclude='\.codex'/);
});

test("ordinary access does not overwrite an existing workspace managed asset", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-access-"));
  const workspaceRoot = path.join(tempRoot, "workspaces");
  const workspacePath = path.join(workspaceRoot, "111");
  const managedSkillPath = path.join(workspacePath, managedDailySkill);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    await writeFile(managedSkillPath, "user-visible legacy managed version\n", "utf8");

    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "const { ensureWorkspace } = (await import('./src/lib/workspace.js')).default; await ensureWorkspace({ userId: '111', projectId: 'invest-agent' });",
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKSPACE_ROOT: workspaceRoot,
          WORKSPACE_TEMPLATE_PATH: templatePath,
        },
        encoding: "utf8",
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(await readFile(managedSkillPath, "utf8"), "user-visible legacy managed version\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace compatibility acceptance refuses to run outside an isolated eval environment", () => {
  const run = spawnSync(
    process.execPath,
    ["scripts/workspace-compatibility-acceptance.mjs", "111", "invest-agent-111"],
    {
      cwd: process.cwd(),
      env: { ...process.env, WORKSPACE_COMPATIBILITY_EVAL: "false" },
      encoding: "utf8",
    },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /WORKSPACE_COMPATIBILITY_EVAL must equal true/);
});
