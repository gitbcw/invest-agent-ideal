import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.WORKSPACE_BACKEND = "mastra";
process.env.NODE_ENV = "test";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-skill-seeding-"));
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.WORKSPACE_ROOT;
  delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
});

async function makeTemplateRoot() {
  const templateRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-skill-templates-"));
  await mkdir(path.join(templateRoot, "demo-method"), { recursive: true });
  await writeFile(path.join(templateRoot, "demo-method", "SKILL.md"), "---\nname: demo-method\ndescription: demo\n---\n\n# Demo\n", "utf8");
  await mkdir(path.join(templateRoot, "not-a-skill"), { recursive: true });
  await writeFile(path.join(templateRoot, "loose-file.md"), "x", "utf8");
  return templateRoot;
}

test("bootstrap seeds system methodology skills into the fresh project root", async () => {
  const templateRoot = await makeTemplateRoot();
  process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = templateRoot;
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-skill-projects-"));
  try {
    const { initDb } = await import("../src/db/index.js");
    initDb();
    const { MastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
    const registry = new MastraWorkspaceRegistry(projectsRoot);
    const project = await registry.bootstrap({ userId: "seed-user", projectId: "invest-agent", instanceId: "invest-agent-seed-user" });
    const seeded = await readFile(path.join(project.projectRoot, "skills", "demo-method", "SKILL.md"), "utf8");
    assert.ok(seeded.startsWith("---\nname: demo-method"));
    // Loose files and empty dirs in the template root are ignored.
    const skillsEntries = await readdir(path.join(project.projectRoot, "skills"));
    assert.deepEqual(skillsEntries, ["demo-method"]);
  } finally {
    delete process.env.SYSTEM_SKILLS_TEMPLATE_ROOT;
    await rm(projectsRoot, { recursive: true, force: true });
    await rm(templateRoot, { recursive: true, force: true });
  }
});

test("seeding never overwrites user-evolved skills and re-runs are idempotent", async () => {
  const templateRoot = await makeTemplateRoot();
  process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = templateRoot;
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-skill-projects-"));
  try {
    const { MastraWorkspaceRegistry, seedSystemSkills } = await import("../src/mastra/workspace-registry.js");
    const registry = new MastraWorkspaceRegistry(projectsRoot);
    const scope = { userId: "evolve-user", projectId: "invest-agent", instanceId: "invest-agent-evolve-user" };
    const project = await registry.bootstrap(scope);

    // The user evolves the seeded skill after initialization.
    const userSkillPath = path.join(project.projectRoot, "skills", "demo-method", "SKILL.md");
    await writeFile(userSkillPath, "---\nname: demo-method\ndescription: user evolved\n---\n\n# 用户改写后的方法\n", "utf8");

    await registry.bootstrap(scope);
    const afterReBootstrap = await readFile(userSkillPath, "utf8");
    assert.ok(afterReBootstrap.includes("用户改写后的方法"), "user evolution must survive re-bootstrap");

    const seeded = await seedSystemSkills(path.join(project.projectRoot, "skills"));
    assert.deepEqual(seeded, [], "idempotent re-seed copies nothing");
    assert.ok((await readFile(userSkillPath, "utf8")).includes("用户改写后的方法"));
  } finally {
    delete process.env.SYSTEM_SKILLS_TEMPLATE_ROOT;
    await rm(projectsRoot, { recursive: true, force: true });
    await rm(templateRoot, { recursive: true, force: true });
  }
});

test("re-bootstrap does not adopt newly introduced templates into an existing project", async () => {
  const templateRoot = await makeTemplateRoot();
  process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = templateRoot;
  const projectsRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-skill-projects-"));
  try {
    const { MastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
    const registry = new MastraWorkspaceRegistry(projectsRoot);
    const scope = { userId: "existing-user", projectId: "invest-agent", instanceId: "invest-agent-existing-user" };
    const project = await registry.bootstrap(scope);

    await mkdir(path.join(templateRoot, "new-system-skill"), { recursive: true });
    await writeFile(
      path.join(templateRoot, "new-system-skill", "SKILL.md"),
      "---\nname: new-system-skill\ndescription: new\n---\n\n# New\n",
      "utf8",
    );

    await registry.bootstrap(scope);
    await assert.rejects(readFile(path.join(project.projectRoot, "skills", "new-system-skill", "SKILL.md"), "utf8"));
  } finally {
    delete process.env.SYSTEM_SKILLS_TEMPLATE_ROOT;
    await rm(projectsRoot, { recursive: true, force: true });
    await rm(templateRoot, { recursive: true, force: true });
  }
});

test("seedSystemSkills tolerates a missing template root", async () => {
  process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.join(os.tmpdir(), "definitely-missing-skill-templates");
  try {
    const { seedSystemSkills } = await import("../src/mastra/workspace-registry.js");
    const target = await mkdtemp(path.join(os.tmpdir(), "invest-agent-skill-target-"));
    assert.deepEqual(await seedSystemSkills(target), []);
    await rm(target, { recursive: true, force: true });
  } finally {
    delete process.env.SYSTEM_SKILLS_TEMPLATE_ROOT;
  }
});

test("repo system skill templates are valid SKILL.md assets", async () => {
  const { systemSkillsTemplateRoot } = await import("../src/mastra/workspace-registry.js");
  const templateRoot = systemSkillsTemplateRoot();
  const entries = (await readdir(templateRoot)).sort();
  assert.deepEqual(entries, ["automation-task-designer", "fundamental-analysis", "macro-analysis", "risk-control", "technical-analysis"]);
  for (const entry of entries) {
    const body = await readFile(path.join(templateRoot, entry, "SKILL.md"), "utf8");
    assert.match(body, /^---\nname: [a-z-]+\ndescription: \S/, `${entry} must carry skill frontmatter`);
    assert.ok(body.includes("系统播种"), `${entry} must frame itself as a seeded, user-evolvable asset`);
  }
});

test("automation task designer is a confirmation-gated, schema-bound skill", async () => {
  const { systemSkillsTemplateRoot } = await import("../src/mastra/workspace-registry.js");
  const body = await readFile(path.join(systemSkillsTemplateRoot(), "automation-task-designer", "SKILL.md"), "utf8");

  for (const trigger of ["创建", "修改", "检查/优化"]) {
    assert.ok(body.includes(trigger), `skill must route ${trigger} requests`);
  }
  for (const tool of ["automation.list", "automation.get", "automation.create", "automation.update", "assets.list", "assets.attachment.save"]) {
    assert.ok(body.includes(tool), `skill must use the mounted ${tool} schema`);
  }
  for (const contract of ["schedule", "instruction", "inputs", "output", "delivery", "去重/幂等", "数据质量", "失败策略", "expectedRevision"]) {
    assert.ok(body.includes(contract), `skill must cover ${contract}`);
  }
  assert.match(body, /每轮最多问 1-2 个问题/);
  assert.match(body, /完整草案，并等待用户下一轮明确确认/);
  assert.ok(
    body.indexOf("用户确认草案后，先用 `assets.attachment.save`") < body.indexOf("创建时调用 `automation.create`"),
    "attachment promotion must be confirmation-gated and precede task creation",
  );
  assert.match(body, /不要把临时附件、文件名或路径直接写进任务定义/);
  assert.match(body, /不向用户展示工具名/);
  assert.match(body, /不固化任何特定用户、行业或数据源规则/);
});
