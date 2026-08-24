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
const legacyDailySkill = ".codex/skills/daily-portfolio-review/SKILL.md";

test("legacy Codex Skills are neither seeded nor offered for template adoption", async () => {
  const catalogSkills = WORKSPACE_OPTIONAL_TEMPLATE_ASSETS
    .filter((relativePath) => relativePath.startsWith(".codex/skills/"))
    .slice()
    .sort();
  assert.deepEqual(catalogSkills, []);
  const legacySkillsRoot = path.join(templatePath, ".codex/skills");
  assert.deepEqual(existsSync(legacySkillsRoot) ? await listFiles(legacySkillsRoot) : [], []);
  assert.deepEqual(WORKSPACE_OPTIONAL_TEMPLATE_ASSETS, []);
});

test("workspace compatibility preserves legacy user Skills without advertising template updates", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-compat-"));
  const workspacePath = path.join(tempRoot, "workspaces", "111");
  const backupRoot = path.join(tempRoot, "backups");
  const portfolioPath = path.join(workspacePath, "config/portfolio.yaml");
  const customSkillPath = path.join(workspacePath, ".codex/skills/user-custom/SKILL.md");

  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    const originalPortfolio = await readFile(portfolioPath, "utf8");
    await mkdir(path.dirname(customSkillPath), { recursive: true });
    await writeFile(customSkillPath, "user-owned custom skill\n", "utf8");

    const report = await inspectWorkspaceCompatibility({ workspacePath, templatePath });
    assert.equal(report.status, "ready");
    assert.equal(report.managedAssetChanges.length, 0);
    assert.equal(report.availableTemplateUpdates.some((change) => change.relativePath.startsWith(".codex/skills/")), false);

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
    assert.equal(await readFile(customSkillPath, "utf8"), "user-owned custom skill\n");

    const result = await migrateWorkspaceCompatibility({
      workspacePath,
      templatePath,
      backupRoot,
      confirmation: WORKSPACE_MIGRATION_CONFIRMATION,
      runId: "test-run",
    });
    assert.equal(result.changed, false);
    assert.equal(result.changes.length, 0);
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

test("workspace template adoption rejects retired Codex Skill assets", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-adopt-"));
  const workspacePath = path.join(tempRoot, "workspaces", "111");
  const backupRoot = path.join(tempRoot, "backups");
  const skillPath = path.join(workspacePath, legacyDailySkill);
  try {
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, "user-customized daily skill\n", "utf8");

    await assert.rejects(
      adoptWorkspaceTemplateAssets({
        workspacePath,
        templatePath,
        backupRoot,
        confirmation: "wrong-confirmation",
        relativePaths: [legacyDailySkill],
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

    assert.equal(await readFile(skillPath, "utf8"), "user-customized daily skill\n");
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

test("Volcano code deploy preserves root runtime state while syncing code templates", async () => {
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
  assert.match(deployScript, /--exclude='apps\/portal\/\.next'/);
  assert.match(deployScript, /portal_previous/);
  assert.match(deployScript, /restore_portal_on_failure/);
  assert.match(deployScript, /pm2 stop mastra-portal/);
  assert.match(deployScript, /pm2 delete mastra-portal/);
  assert.match(deployScript, /npm install --include=dev --no-audit --no-fund/);
  assert.match(deployScript, /NODE_ENV=production npm run build/);
  assert.match(deployScript, /\.next\/BUILD_ID/);
  assert.match(deployScript, /\.next\/required-server-files\.json/);
  assert.match(deployScript, /\.next\/routes-manifest\.json/);
  assert.match(deployScript, /\.next\/server\/pages\/_error\.js/);
  assert.match(deployScript, /pm2 (?:restart|start) ecosystem\.config\.cjs/);
  assert.match(deployScript, /\/api\/health/);
  assert.match(deployScript, /_next\/static/);
  assert.match(deployScript, /curl -fsSL? /);
  assert.match(deployScript, /INVEST_AGENT_API_TOKEN PLATFORM_ANONYMIZATION_SECRET/);
  assert.match(deployScript, /for attempt in 1 2 3 4 5 6 7 8 9 10/);
});

test("ordinary access does not overwrite an existing legacy user Skill", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-workspace-access-"));
  const workspaceRoot = path.join(tempRoot, "workspaces");
  const workspacePath = path.join(workspaceRoot, "111");
  const legacySkillPath = path.join(workspacePath, legacyDailySkill);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await cp(templatePath, workspacePath, { recursive: true });
    await mkdir(path.dirname(legacySkillPath), { recursive: true });
    await writeFile(legacySkillPath, "user-visible legacy version\n", "utf8");

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
    assert.equal(await readFile(legacySkillPath, "utf8"), "user-visible legacy version\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  }));
  return nested.flat();
}
