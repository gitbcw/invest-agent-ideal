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

  // 2026-10-08 用户裁决：技能内容资产不在「我的文件」可见——默认列表隐藏，
  // 显式按 skill_content 来源查询仍可读到（技能域内部链路）。
  const { listUserAssets } = await import("../src/services/user-assets.js");
  assert.equal((await listUserAssets(scopeA)).some((a) => a.assetId === created.content.assetId), false, "技能内容资产不出现在默认资产列表");
  assert.equal((await listUserAssets({ ...scopeA, source: "skill_content" })).some((a) => a.assetId === created.content.assetId), true, "显式 skill_content 来源可查");

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

  // 2026-10-08 裁决「删除就消失」：私有技能卸载即墓碑——私有列表与找回目录都不再出现，
  // 技能详情（历史引用/审计）仍可读，同 slug 可重新创建。
  assert.equal(space.listPortalPrivateSkills(scopeA).some((s) => s.skillId === skillId), false, "墓碑技能不出现在私有列表");
  assert.equal(space.listPortalSkillCatalog(scopeA).items.some((item) => item.skillId === skillId), false, "墓碑技能不出现在找回目录");
  const detail = await space.getPortalSkillDetail(scopeA, skillId);
  assert.equal(detail.skill.skillId, skillId, "墓碑技能的详情仍可读（历史引用/审计）");
  const recreated = await space.portalCreateSkill({
    scope: scopeA,
    slug: "pa-skill-one",
    name: "PA Skill One Recreated",
    text: "# recreated",
    idempotencyKey: "pa:s1-recreated",
    actor: "portal:pa-user-a",
  });
  assert.notEqual(recreated.skill.skill_id, skillId, "墓碑让出 slug 后同 slug 可重新创建");
});

test("listPortalAgents returns camelCase agentId usable as install target", async () => {
  const space = await load();
  const agents = space.listPortalAgents(scopeA);
  assert.ok(agents.length >= 1);
  assert.equal(typeof agents[0]!.agentId, "string");
  assert.ok(agents[0]!.agentId.length > 0, "agentId 必须是真实字符串（曾因列名映射缺失而为 undefined）");
});

test("my strategies: first create becomes primary; set_primary is exclusive swap (2026-10-08)", async () => {
  const space = await load();
  const { listStrategies, createStrategy, setPrimaryStrategy } = await import("../src/services/agent-space/strategy-actions.js");
  const allAgents = space.listPortalAgents(scopeA);
  for (const agent of allAgents.filter((a) => a.status === "active").slice(1)) {
    space.setAgentStatus(scopeA, agent.agentId, "disabled", "test");
  }
  if (allAgents.filter((a) => a.status === "active").length === 0) {
    const created = space.createAgent({ scope: scopeA, name: "策略测试 Agent", actor: "portal:pa-user-a" });
    space.setAgentStatus(scopeA, created.agent_id, "active", "portal:pa-user-a");
  }
  const first = await createStrategy({ scope: scopeA, name: "双均线策略", text: "5 日均线上穿 20 日均线买入；下穿卖出。", actor: "portal:pa-user-a", idempotencyKey: "pa:strategy-1" });
  assert.equal(first.becamePrimary, true, "首个策略保存即成为主策略");
  const second = await createStrategy({ scope: scopeA, name: "放量突破策略", text: "创 60 日新高且量能 1.5 倍买入；破 10 日线卖出。", actor: "portal:pa-user-a", idempotencyKey: "pa:strategy-2" });
  assert.equal(second.becamePrimary, false, "已有主策略时新策略不自动换主");
  let cards = listStrategies(scopeA);
  assert.equal(cards.filter((c) => c.isPrimary).length, 1, "主策略唯一");
  assert.equal(cards.find((c) => c.isPrimary)?.name, "双均线策略");
  // 换绑：切换后旧的让位，主策略仍唯一。
  const swapped = setPrimaryStrategy({ scope: scopeA, strategyId: second.strategy.strategyId, actor: "portal:pa-user-a" });
  assert.equal(swapped.isPrimary, true);
  cards = listStrategies(scopeA);
  assert.equal(cards.filter((c) => c.isPrimary).length, 1, "换绑后主策略依然唯一");
  assert.equal(cards.find((c) => c.isPrimary)?.name, "放量突破策略");
  // 策略内容资产不在「我的文件」默认列表。
  const { listUserAssets } = await import("../src/services/user-assets.js");
  const visible = await listUserAssets(scopeA);
  const { sqlite } = await import("../src/db/index.js");
  const contentAssetIds = new Set(
    (sqlite.prepare("SELECT DISTINCT asset_id AS assetId FROM agent_space_method_versions WHERE user_id=? AND project_id=? AND instance_id=?").all(scopeA.userId, scopeA.projectId, scopeA.instanceId) as Array<{ assetId: string }>),
  );
  for (const card of visible) assert.ok(!contentAssetIds.has({ assetId: card.assetId } as never) || true, "");
  assert.equal(visible.some((a) => [...contentAssetIds].some((c) => c.assetId === a.assetId)), false, "策略内容资产默认不出现在我的文件");
});
