/**
 * T-538 portal-actions 层测试：GUI 读模型与显式动作的服务边界。
 *
 * 覆盖：
 * - scope 强制（跨 scope 读/写拒绝，不返回对象）；
 * - portal-action 凭证的一次性消耗与幂等回放（同 idempotencyKey 重放返回首次结果）；
 * - 方法 create→add_version→adopt→readopt 生命周期与「保存≠生效」（draft 不改变 current）；
 * - 私有 Skill create→approve→install→remove 链路；
 * - 一个 sourceRef 绑定多个不同操作时拒绝（凭证不可复用）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-portal-actions-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "portal-actions.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scopeA = { userId: "pa-user-a", projectId: "invest-agent", instanceId: "invest-agent-a" };
const scopeB = { userId: "pa-user-b", projectId: "invest-agent", instanceId: "invest-agent-b" };

// 现有套件模式：env 先行，模块在首个测试回调内动态加载（避免顶层 await 的 CJS 转换限制）。
let spaceModule: typeof import("../src/services/agent-space/index.js") | null = null;
async function load() {
  if (!spaceModule) {
    const { initDb } = await import("../src/db/index.js");
    initDb();
    const { registerTestProject } = await import("./helpers/mastra-project.js");
    await registerTestProject(scopeA);
    await registerTestProject(scopeB);
    spaceModule = await import("../src/services/agent-space/index.js");
  }
  return spaceModule;
}

test("portal method lifecycle: create → draft add_version does not change current → adopt → readopt", async () => {
  const space = await load();
  const created = await space.portalCreateMethod({
    scope: scopeA,
    name: "portal 生命周期方法",
    text: "# v1 正文",
    idempotencyKey: "pa:m1",
    actor: "portal:pa-user-a",
  });
  const methodId = created.method.method_id;
  assert.equal(created.version.status, "draft");
  assert.equal(created.method.current_version_id, null, "首个版本是草稿；保存不等于生效");

  // 先采用 v1（草稿经显式 adopt 成为正式版本）
  await space.portalAdoptMethodVersion(
    { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:adopt-v1" },
    methodId,
    created.version.version_id,
  );

  const v2 = await space.portalAddMethodVersion({
    scope: scopeA,
    methodId,
    text: "# v2 正文",
    idempotencyKey: "pa:m1-v2",
    actor: "portal:pa-user-a",
  });
  let card = space.getPortalMethodCard(scopeA, methodId);
  assert.equal(card.currentVersionId, created.version.version_id, "新增草稿版本仍不改变采用状态");

  await space.portalAdoptMethodVersion(
    { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:adopt-v2" },
    methodId,
    v2.version.version_id,
  );
  card = space.getPortalMethodCard(scopeA, methodId);
  assert.equal(card.currentVersionId, v2.version.version_id);
  assert.ok(card.pendingDraft === null || card.pendingDraft.versionId !== v2.version.version_id);

  // v1 恢复采用（readopt）：current 指回 v1，v2 superseded
  const v1 = created.version.version_id;
  await space.portalReadoptMethodVersion(
    { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:readopt-v1" },
    methodId,
    v1,
  );
  card = space.getPortalMethodCard(scopeA, methodId);
  assert.equal(card.currentVersionId, v1);
});

test("cross-scope reads and writes are rejected", async () => {
  const space = await load();
  const created = await space.portalCreateMethod({
    scope: scopeA,
    name: "跨域防护方法",
    text: "# body",
    idempotencyKey: "pa:m2",
    actor: "portal:pa-user-a",
  });
  assert.equal(space.listPortalMethods(scopeB).length, 0, "B scope 看不到 A 的方法");
  assert.throws(() => space.getPortalMethodCard(scopeB, created.method.method_id), /SCOPE_MISMATCH|NOT_FOUND/);
  await assert.rejects(
    () => space.portalAddMethodVersion({ scope: scopeB, methodId: created.method.method_id, text: "# hack", actor: "portal:pa-user-b" }),
    /SCOPE_MISMATCH|NOT_FOUND/,
  );
});

test("project Skill previews are scope-bound and cannot follow symlinks", async () => {
  await load();
  const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
  const { listProjectSkillPreviews } = await import("../src/services/agent-space/project-skills.js");
  const projectA = await mastraWorkspaceRegistry.resolve(scopeA);
  assert.ok(projectA);
  const skills = path.join(projectA.realProjectRoot, "skills");
  mkdirSync(path.join(skills, "only-for-a"));
  writeFileSync(path.join(skills, "only-for-a", "SKILL.md"), "---\nname: A only\ndescription: Scoped preview\n---\n# Body\n");
  symlinkSync(path.join(skills, "only-for-a"), path.join(skills, "linked-dir"));
  mkdirSync(path.join(skills, "linked-file"));
  symlinkSync(path.join(skills, "only-for-a", "SKILL.md"), path.join(skills, "linked-file", "SKILL.md"));
  const a = await listProjectSkillPreviews(scopeA);
  const b = await listProjectSkillPreviews(scopeB);
  assert.equal(a.find((item) => item.slug === "only-for-a")?.name, "A only");
  assert.equal(b.some((item) => item.slug === "only-for-a"), false);
  assert.equal(a.some((item) => item.slug === "linked-dir" || item.slug === "linked-file"), false);
  assert.equal(a.find((item) => item.slug === "only-for-a")?.text.includes("# Body"), true);
});

test("portal actions are idempotent per GUI idempotency key (replay returns first outcome)", async () => {
  const space = await load();
  const created = await space.portalCreateMethod({
    scope: scopeA,
    name: "幂等方法",
    text: "# 幂等正文",
    idempotencyKey: "pa:m3",
    actor: "portal:pa-user-a",
  });
  const methodId = created.method.method_id;
  const v2 = await space.portalAddMethodVersion({
    scope: scopeA,
    methodId,
    text: "# v2 for replay",
    idempotencyKey: "pa:m3-v2",
    actor: "portal:pa-user-a",
  });
  const ctx = { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:replay-adopt" };
  const first = space.portalAdoptMethodVersion(ctx, methodId, v2.version.version_id);
  const replay = space.portalAdoptMethodVersion(ctx, methodId, v2.version.version_id);
  assert.equal(first.method.current_version_id, replay.method.current_version_id, "同幂等键回放返回首次结果");

  // 同一凭证 ref 不能绑定另一个不同操作（换 versionId 的 adopt 是不同绑定）
  const v3 = await space.portalAddMethodVersion({ scope: scopeA, methodId, text: "# v3", actor: "portal:pa-user-a", idempotencyKey: "pa:m3-v3" });
  await space.portalAdoptMethodVersion({ ...ctx, idempotencyKey: "pa:adopt-v3" }, methodId, v3.version.version_id);
  assert.throws(
    () => space.portalAdoptMethodVersion(ctx, methodId, v3.version.version_id),
    /bound to a different target/,
    "同 sourceRef 换绑定必须拒绝",
  );
});

test("private skill: create draft → approve (enable) → install → list installed → remove", async () => {
  const space = await load();
  const created = await space.portalCreateSkill({
    scope: scopeA,
    slug: "pa-skill-one",
    name: "PA Skill One",
    text: "# SKILL one",
    idempotencyKey: "pa:s1",
    actor: "portal:pa-user-a",
  });
  const skillId = created.skill.skill_id;
  assert.equal(space.listPortalPrivateSkills(scopeA).find((s) => s.skillId === skillId)?.currentVersionId, null, "创建后无启用版本");

  const agent = space.createAgent({ scope: scopeA, name: "PA 测试 Agent", idempotencyKey: "pa:agent-a", actor: "portal:pa-user-a" });
  const ctx = { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:enable-s1" };
  space.portalApproveSkillVersion(ctx, skillId, created.version.version_id);
  space.portalInstallSkill({
    ctx: { scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:install-s1" },
    agentId: agent.agent_id,
    skillId,
    source: "private",
    versionId: created.version.version_id,
    installedBy: "portal:pa-user-a",
  });

  const installed = space.listPortalInstalledSkills(scopeA);
  assert.equal(installed.items.length, 1);
  assert.equal(installed.items[0]!.skillId, skillId);

  const privateCard = space.listPortalPrivateSkills(scopeA).find((s) => s.skillId === skillId);
  assert.ok(privateCard?.installation, "私有卡片带安装信息");

  const { sqlite } = await import("../src/db/index.js");
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
    VALUES ('pa-skill-task',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "pa-skill-task", kind: "skill", refId: skillId,
    versionPolicy: "pinned", pinnedVersionId: created.version.version_id, actor: "portal:pa-user-a" });
  assert.equal(space.listPortalInstalledSkills(scopeA).items[0]?.taskBindingCount, 1);
  assert.throws(() => space.portalRemoveInstalledSkill({ scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:blocked-remove" }, agent.agent_id, skillId), /ADOPTION_CONSTRAINT/);
  assert.equal(space.listPortalInstalledSkills(scopeA).items.length, 1, "被任务引用时不得误称已卸载");
  sqlite.prepare("DELETE FROM agent_space_task_dependencies WHERE task_id='pa-skill-task'").run();

  space.portalRemoveInstalledSkill({ scope: scopeA, actor: "portal:pa-user-a", idempotencyKey: "pa:remove-s1" }, agent.agent_id, skillId);
  assert.equal(space.listPortalInstalledSkills(scopeA).items.length, 0, "卸载后不再出现在已安装列表");
});

test("listPortalAgents returns camelCase agentId usable as install target", async () => {
  const space = await load();
  const agents = space.listPortalAgents(scopeA);
  assert.ok(agents.length >= 1);
  assert.equal(typeof agents[0]!.agentId, "string");
  assert.ok(agents[0]!.agentId.length > 0, "agentId 必须是真实字符串（曾因列名映射缺失而为 undefined）");
});
