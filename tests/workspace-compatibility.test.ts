import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WORKSPACE_MIGRATION_CONFIRMATION,
  WORKSPACE_OPTIONAL_TEMPLATE_ASSETS,
  WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION,
  adoptWorkspaceTemplateAssets,
  inspectWorkspaceCompatibility,
  migrateWorkspaceCompatibility,
} from "../src/lib/workspace-compatibility.js";

const templatePath = path.resolve("templates/workspace");
const agentsAsset = "AGENTS.md";
const managedDailySkill = ".codex/skills/daily-portfolio-review/SKILL.md";

test("optional template catalog covers every seeded Codex Skill asset", async () => {
  const skillsRoot = path.join(templatePath, ".codex/skills");
  const skillFiles = (await listFiles(skillsRoot))
    .map((filePath) => path.relative(templatePath, filePath))
    .sort();
  const catalogSkills = WORKSPACE_OPTIONAL_TEMPLATE_ASSETS
    .filter((relativePath) => relativePath.startsWith(".codex/skills/"))
    .slice()
    .sort();
  assert.deepEqual(catalogSkills, skillFiles);
  assert.equal(WORKSPACE_OPTIONAL_TEMPLATE_ASSETS.includes(agentsAsset), true);
});

test("workspace compatibility preserves user-evolved template skills by default", async () => {
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
    assert.equal(report.status, "ready");
    assert.equal(report.managedAssetChanges.length, 0);
    assert.deepEqual(
      report.availableTemplateUpdates.filter((change) => change.relativePath === managedDailySkill).map((change) => change.action),
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
    assert.equal(result.changed, false);
    assert.equal(result.changes.length, 0);
    assert.equal(await readFile(managedSkillPath, "utf8"), oldManagedContent);
    assert.equal(await readFile(portfolioPath, "utf8"), originalPortfolio);
    assert.equal(await readFile(customSkillPath, "utf8"), "user-owned custom skill\n");
    assert.equal(existsSync(path.join(backupRoot, "test-run", "111", "manifest.json")), false);

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

test("workspace template adoption replaces only explicitly approved assets with backup", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-adopt-"));
  const workspacePath = path.join(tempRoot, "workspaces", "111");
  const backupRoot = path.join(tempRoot, "backups");
  const portfolioPath = path.join(workspacePath, "config/portfolio.yaml");
  const skillPath = path.join(workspacePath, managedDailySkill);
  const customizedSkill = "user-customized daily skill\n";
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    const originalPortfolio = await readFile(portfolioPath, "utf8");
    await writeFile(skillPath, customizedSkill, "utf8");

    await assert.rejects(
      adoptWorkspaceTemplateAssets({
        workspacePath,
        templatePath,
        backupRoot,
        confirmation: "wrong-confirmation",
        relativePaths: [managedDailySkill],
      }),
      /confirmation must equal/,
    );
    await assert.rejects(
      adoptWorkspaceTemplateAssets({
        workspacePath,
        templatePath,
        backupRoot,
        confirmation: WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION,
        relativePaths: [".codex/skills/user-custom/SKILL.md"],
      }),
      /unsupported assets/,
    );

    const result = await adoptWorkspaceTemplateAssets({
      workspacePath,
      templatePath,
      backupRoot,
      confirmation: WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION,
      relativePaths: [managedDailySkill],
      runId: "adopt-run",
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.changes.map((change) => change.relativePath), [managedDailySkill]);
    assert.equal(await readFile(skillPath, "utf8"), await readFile(path.join(templatePath, managedDailySkill), "utf8"));
    assert.equal(await readFile(path.join(backupRoot, "adopt-run", "111", managedDailySkill), "utf8"), customizedSkill);
    assert.equal(await readFile(portfolioPath, "utf8"), originalPortfolio);
    assert.equal(existsSync(path.join(workspacePath, ".invest-agent/workspace-template-adoption.json")), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace template adoption can explicitly replace AGENTS.md with backup", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-agents-adopt-"));
  const workspacePath = path.join(tempRoot, "workspaces", "mg");
  const backupRoot = path.join(tempRoot, "backups");
  const agentsPath = path.join(workspacePath, agentsAsset);
  const previousAgents = "# Previous standard workspace instructions\n";
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    await writeFile(agentsPath, previousAgents, "utf8");

    const result = await adoptWorkspaceTemplateAssets({
      workspacePath,
      templatePath,
      backupRoot,
      confirmation: WORKSPACE_TEMPLATE_ADOPTION_CONFIRMATION,
      relativePaths: [agentsAsset],
      runId: "agents-adopt-run",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.changes.map((change) => change.relativePath), [agentsAsset]);
    assert.equal(await readFile(agentsPath, "utf8"), await readFile(path.join(templatePath, agentsAsset), "utf8"));
    assert.equal(await readFile(path.join(backupRoot, "agents-adopt-run", "mg", agentsAsset), "utf8"), previousAgents);
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
  const syntaxCheck = spawnSync("bash", ["-n", "scripts/deploy-volcano.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr);
  assert.match(deployScript, /--delete-delay/);
  assert.doesNotMatch(deployScript, /--delete-excluded/);
  assert.match(deployScript, /--exclude='\/\.codex'/);
  assert.doesNotMatch(deployScript, /--exclude='\.codex'/);
  assert.match(deployScript, /INVEST_AGENT_API_TOKEN PLATFORM_ANONYMIZATION_SECRET/);
  assert.match(deployScript, /for attempt in 1 2 3 4 5 6 7 8 9 10/);
});

test("ordinary access does not overwrite an existing template-derived asset", async () => {
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

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}
