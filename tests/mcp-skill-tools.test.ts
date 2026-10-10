import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mcp-skill-tools-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "skill-tools.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const tools = await import("../src/mcp/service-tools-core.js");
  const agents = await import("../src/services/agent-space/agents.js");
  const classification = await import("../src/mcp/service-tool-classification.js");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  await registerTestProject({ userId: "mcp-skill-a", projectId: "invest-agent", instanceId: "mcp-skill-instance-a" });
  await registerTestProject({ userId: "mcp-skill-b", projectId: "invest-agent", instanceId: "mcp-skill-instance-b" });
  const agentA = agents.createAgent({
    scope: { userId: "mcp-skill-a", projectId: "invest-agent", instanceId: "mcp-skill-instance-a" },
    name: "助手A",
    actor: "user:mcp-skill-a",
    idempotencyKey: "mcp-skill-agent-a",
  });
  const agentB = agents.createAgent({
    scope: { userId: "mcp-skill-b", projectId: "invest-agent", instanceId: "mcp-skill-instance-b" },
    name: "助手B",
    actor: "user:mcp-skill-b",
    idempotencyKey: "mcp-skill-agent-b",
  });
  return { tools, agents, classification, db, agentA, agentB };
})();

const scopeA = {
  userId: "mcp-skill-a",
  projectId: "invest-agent",
  instanceId: "mcp-skill-instance-a",
  conversationId: "mcp-skill-conversation-a",
};
const scopeB = {
  userId: "mcp-skill-b",
  projectId: "invest-agent",
  instanceId: "mcp-skill-instance-b",
  conversationId: "mcp-skill-conversation-b",
};

function seedConversation(db: any, scope: typeof scopeA) {
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    INSERT OR IGNORE INTO conversation_sessions
      (conversation_id, user_id, project_id, instance_id, assistant_id, channel, title, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'web', 'Skill MCP tools', ?, ?)
  `).run(scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, now, now);
}

function addUserConfirmation(db: any, scope: typeof scopeA, messageId: string, content: string) {
  db.sqlite.prepare(`
    INSERT INTO conversation_messages
      (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'web', 'user', ?, ?)
  `).run(messageId, scope.conversationId, scope.userId, scope.projectId, scope.instanceId, scope.instanceId, content, new Date(Date.now() + 1_000).toISOString());
}

async function createSkill(tools: any, scope: typeof scopeA, slug: string) {
  const created = await tools.callServiceTool("skill.create", {
    slug,
    name: `技能 ${slug}`,
    description: `测试技能 ${slug}`,
    text: `# ${slug}\n\n按用户确认的方式工作。`,
  }, scope) as any;
  assert.equal(created.ok, true, `skill.create ${slug}: ${JSON.stringify(created)}`);
  return created.skill as { skillId: string; slug: string; name: string };
}

test("skill tools are classified (list=read, writes=other-write)", async () => {
  const { classification } = await fixture;
  assert.equal(classification.classifyServiceTool("skill.list"), "read");
  assert.equal(classification.classifyServiceTool("skill.create"), "other-write");
  assert.equal(classification.classifyServiceTool("skill.install"), "other-write");
  assert.equal(classification.classifyServiceTool("skill.set_enabled"), "other-write");
  assert.equal(classification.classifyServiceTool("skill.uninstall"), "other-write");
  assert.equal(classification.classifyServiceTool("skill.edit"), "other-write");
});

test("skill.create then skill.install enables the draft in the same turn without confirmation", async () => {
  const { tools, agents } = await fixture;
  const skill = await createSkill(tools, scopeA, "skill-install-flow");

  const listed = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  assert.equal(listed.ok, true);
  const card = listed.items.find((item: any) => item.skillId === skill.skillId);
  assert.ok(card, "skill.list should include the new private skill");
  assert.equal(card.installation, null);
  assert.ok(card.pendingDraft, "fresh draft should be pending");

  const installed = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(installed.ok, true, `skill.install: ${JSON.stringify(installed)}`);
  assert.equal(installed.installation.status, "installed");
  assert.equal(installed.installation.skillId, skill.skillId);

  const manifest = agents.getInstalledSkillManifest(
    { userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
    installed.agent.agentId,
  );
  const entry = manifest.find((item: any) => item.skillId === skill.skillId);
  assert.ok(entry, "installed skill should appear in the agent manifest");
  assert.equal(entry.versionId, installed.installation.versionId);
});

test("skill.set_enabled false requires confirmation; true does not", async () => {
  const { db, tools } = await fixture;
  seedConversation(db, scopeA);
  const skill = await createSkill(tools, scopeA, "skill-toggle-flow");
  const installed = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(installed.ok, true);

  // 未确认停用：拒绝且状态不变。
  await assert.rejects(
    () => tools.callServiceTool("skill.set_enabled", { skillId: skill.skillId, enabled: false }, scopeA),
    /confirmedByUser|confirmationId/i,
  );
  let listed = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  assert.equal(listed.items.find((item: any) => item.skillId === skill.skillId).installation.status, "installed");

  // 登记停用草案 → 用户确认 → 停用成功。
  const requested = await tools.callServiceTool("confirmations.request", {
    operation: "skill.set_enabled",
    payload: { skillId: skill.skillId, enabled: false },
  }, scopeA) as any;
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.ok(requested.confirmationId);

  addUserConfirmation(db, scopeA, "mcp-skill-disable-confirmation", "确认停用");
  const disabled = await tools.callServiceTool("skill.set_enabled", {
    skillId: skill.skillId,
    enabled: false,
    confirmationId: requested.confirmationId,
    confirmedByUser: true,
  }, scopeA) as any;
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.equal(disabled.result.status, "disabled");

  // 启用无需确认，直接生效。
  const enabled = await tools.callServiceTool("skill.set_enabled", { skillId: skill.skillId, enabled: true }, scopeA) as any;
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(enabled.result.status, "installed");

  listed = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  assert.equal(listed.items.find((item: any) => item.skillId === skill.skillId).installation.status, "installed");
});

test("skill.uninstall requires confirmation and removes the installation", async () => {
  const { db, tools, agents } = await fixture;
  seedConversation(db, scopeA);
  const skill = await createSkill(tools, scopeA, "skill-uninstall-flow");
  const installed = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(installed.ok, true);

  await assert.rejects(
    () => tools.callServiceTool("skill.uninstall", { skillId: skill.skillId }, scopeA),
    /confirmedByUser|confirmationId/i,
  );

  const requested = await tools.callServiceTool("confirmations.request", {
    operation: "skill.uninstall",
    payload: { skillId: skill.skillId },
  }, scopeA) as any;
  assert.equal(requested.ok, true, JSON.stringify(requested));

  addUserConfirmation(db, scopeA, "mcp-skill-uninstall-confirmation", "确认卸载");
  const uninstalled = await tools.callServiceTool("skill.uninstall", {
    skillId: skill.skillId,
    confirmationId: requested.confirmationId,
    confirmedByUser: true,
  }, scopeA) as any;
  assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled));
  assert.equal(uninstalled.result.status, "removed");

  // 运行解析随即拒绝（安装行已 removed）。
  await assert.rejects(
    () => agents.resolveInstalledSkillContent(
      { userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
      installed.agent.agentId,
      skill.skillId,
    ),
    (error: unknown) => (error as { code?: string }).code === "AGENT_SPACE_NOT_FOUND",
  );

  // 2026-10-08 裁决「删除就消失」：私有技能卸载即墓碑——skill.list 不再出现、
  // 技能行 status='deleted' 且 slug 已让位、不可再安装；同 slug 可重新创建。
  const listed = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  assert.equal(listed.ok, true);
  assert.equal(listed.items.some((item: any) => item.skillId === skill.skillId), false, "卸载后 skill.list 不得再出现该技能");

  const tombstone = db.sqlite.prepare("SELECT status, slug FROM agent_space_skills WHERE skill_id=?").get(skill.skillId) as any;
  assert.equal(tombstone.status, "deleted");
  assert.notEqual(tombstone.slug, skill.slug, "墓碑必须让出原 slug");
  assert.ok(tombstone.slug.startsWith(`${skill.slug}-deleted-`));

  const reinstalled = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(reinstalled.ok, false, "墓碑技能不可再安装");
  assert.equal(reinstalled.error, "SKILL_NOT_USER_MANAGEABLE");

  const recreated = await createSkill(tools, scopeA, "skill-uninstall-flow");
  assert.notEqual(recreated.skillId, skill.skillId, "同 slug 重新创建得到新技能");
});

test("skill.edit saves a new draft version with name/description and skill.install activates it", async () => {
  const { db, tools } = await fixture;
  seedConversation(db, scopeA);
  const skill = await createSkill(tools, scopeA, "skill-edit-flow");
  const installed = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(installed.ok, true);

  const edited = await tools.callServiceTool("skill.edit", {
    skillId: skill.skillId,
    name: "编辑后的技能",
    description: "编辑后的说明",
    text: "# 编辑后的正文\n\n新的工作方式。",
  }, scopeA) as any;
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.version.status, "draft");
  assert.equal(edited.version.versionNumber, 2);

  const listed = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  const card = listed.items.find((item: any) => item.skillId === skill.skillId);
  assert.equal(card.name, "编辑后的技能");
  assert.equal(card.pendingDraft.versionId, edited.version.versionId);
  // 已安装版本仍是 v1（草案未生效）。
  assert.equal(card.installation.versionId, installed.installation.versionId);

  const upgraded = await tools.callServiceTool("skill.install", { skillId: skill.skillId }, scopeA) as any;
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(upgraded.installation.versionId, edited.version.versionId);
});

test("system-domain skills are rejected with structured errors", async () => {
  const { db, tools } = await fixture;
  const now = new Date().toISOString();
  db.sqlite.prepare(`
    INSERT INTO agent_space_skills
      (skill_id, domain, user_id, project_id, instance_id, slug, name, description, status, is_core, current_private_version_id, created_at, updated_at)
    VALUES ('skill-sys-seed', 'system', NULL, NULL, NULL, 'sys-seed', '系统技能', NULL, 'active', 0, NULL, ?, ?)
  `).run(now, now);

  const installed = await tools.callServiceTool("skill.install", { skillId: "skill-sys-seed" }, scopeA) as any;
  assert.equal(installed.ok, false);
  assert.equal(installed.error, "SKILL_NOT_USER_MANAGEABLE");

  const enabled = await tools.callServiceTool("skill.set_enabled", { skillId: "skill-sys-seed", enabled: true }, scopeA) as any;
  assert.equal(enabled.ok, false);
  assert.equal(enabled.error, "SKILL_NOT_USER_MANAGEABLE");

  const edited = await tools.callServiceTool("skill.edit", { skillId: "skill-sys-seed", text: "# hijack" }, scopeA) as any;
  assert.equal(edited.ok, false);
  assert.equal(edited.error, "SKILL_NOT_USER_MANAGEABLE");

  // 确认流登记端同样拒绝系统域技能。
  await assert.rejects(
    () => tools.callServiceTool("confirmations.request", {
      operation: "skill.uninstall",
      payload: { skillId: "skill-sys-seed" },
    }, scopeA),
    /确认草案不可执行/,
  );
});

test("skill tools reject cross-scope skills", async () => {
  const { tools } = await fixture;
  const skillB = await createSkill(tools, scopeB, "skill-cross-scope");

  const listedA = await tools.callServiceTool("skill.list", {}, scopeA) as any;
  assert.equal(listedA.items.some((item: any) => item.skillId === skillB.skillId), false);

  const edited = await tools.callServiceTool("skill.edit", { skillId: skillB.skillId, text: "# 越权编辑" }, scopeA) as any;
  assert.equal(edited.ok, false);
  assert.equal(edited.error, "SKILL_NOT_USER_MANAGEABLE");

  const crossInstall = await tools.callServiceTool("skill.install", { skillId: skillB.skillId }, scopeA) as any;
  assert.equal(crossInstall.ok, false, "cross-scope install must be rejected");
  assert.equal(crossInstall.error, "SKILL_NOT_USER_MANAGEABLE");

  // scopeB 自己仍可正常安装。
  const installedB = await tools.callServiceTool("skill.install", { skillId: skillB.skillId }, scopeB) as any;
  assert.equal(installedB.ok, true, JSON.stringify(installedB));
});
