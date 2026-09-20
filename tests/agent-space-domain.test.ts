/**
 * W1 Agent Space 域隔离测试。
 *
 * 覆盖 docs/agent-space-execution/W1-domain-contracts.md 验收矩阵：
 * 隔离 DB 可重复升级；跨 scope 读写/批准/安装/发布/引用全部拒绝；草稿不可
 * 安装/运行；版本固定；运行快照可表达 Agent/Skill/Method/资产/状态依赖且
 * 不可变；生命周期、幂等、审计与 scope 全覆盖。全程临时目录 DB，不碰生产。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-agent-space-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "agent-space.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scopeA = { userId: "w1-user-a", projectId: "invest-agent", instanceId: "invest-agent-a" };
const scopeB = { userId: "w1-user-b", projectId: "invest-agent", instanceId: "invest-agent-b" };

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const space = await import("../src/services/agent-space/index.js");
  // 真实 user_assets 行（跨域引用校验用）
  db.sqlite
    .prepare(
      `INSERT INTO user_assets (asset_id, user_id, project_id, instance_id, name, status, current_version_id, created_at, updated_at)
       VALUES ('asset_a1', ?, ?, ?, '方法底座资产', 'active', NULL, ?, ?)`,
    )
    .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, new Date().toISOString(), new Date().toISOString());
  db.sqlite
    .prepare(
      `INSERT INTO user_asset_versions (version_id, asset_id, user_id, project_id, instance_id, version_number, file_name, format, mime_type, size_bytes, checksum, storage_path, source, created_at)
       VALUES ('ver_a1', 'asset_a1', ?, ?, ?, 1, 'strategy.md', 'markdown', 'text/markdown', 10, 'chk_a1', 'assets/asset_a1/versions/ver_a1', 'test', ?)`,
    )
    .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, new Date().toISOString());
  db.sqlite
    .prepare(
      `INSERT INTO automation_tasks (task_id, user_id, project_id, instance_id, status, current_revision, created_at, updated_at)
       VALUES ('task_exec_1', ?, ?, ?, 'active', 1, ?, ?)`,
    )
    .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, new Date().toISOString(), new Date().toISOString());
  return { db, space };
})();

type Space = Awaited<ReturnType<typeof getSpace>>;
async function getSpace() {
  return (await fixture).space;
}

function expectAgentSpaceError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    const message = (error as Error).message;
    assert.ok(message.startsWith(`${code}:`), `expected ${code}, got ${message}`);
    return;
  }
  assert.fail(`expected ${code} error, but call succeeded`);
}

test("isolated DB: tables created, re-running initDb is idempotent (repeatable upgrade)", async () => {
  const { db } = await fixture;
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%' ORDER BY name")
    .all()
    .map((r: { name: string }) => r.name);
  assert.equal(tables.length, 19, `expected 19 agent_space tables, got ${tables.length}`);
  db.initDb(); // 幂等重放
  const checkpoint = db.sqlite.prepare("SELECT key FROM schema_migrations WHERE key='agent_space_v1'").get();
  assert.ok(checkpoint, "agent_space_v1 checkpoint marked");
});

test("rollback/forward-fix semantics: dropping the domain restores pre-W1 state; re-init recreates", async () => {
  const { db } = await fixture;
  const names = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%'")
    .all()
    .map((r: { name: string }) => r.name);
  const inTx = db.sqlite.transaction(() => {
    for (const n of names) db.sqlite.exec(`DROP TABLE IF EXISTS ${n}`);
  });
  inTx();
  const remaining = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%'")
    .get() as { n: number };
  assert.equal(remaining.n, 0, "rollback drops the whole additive domain");
  db.initDb(); // forward fix：重放迁移
  const restored = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%'")
    .get() as { n: number };
  assert.equal(restored.n, 19, "forward fix recreates the domain");
});

test("methods: lifecycle, approval binding, immutability, version resolution", async () => {
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "量价波段", actor: "user:a" });
  assert.equal(method.status, "draft");

  const v1 = space.addMethodVersion({
    scope: scopeA,
    methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    adoptionNote: "W0: 无采用约束",
    actor: "user:a",
  });
  assert.equal(v1.status, "draft");

  // 无 approvalRef 不得批准；跨 scope 批准拒绝
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "  ", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeB, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:b", approvalRef: "msg:1", actor: "user:b" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );

  const approved = space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v1.version_id,
    approvedBy: "user:a", approvalRef: "conversation:um_w1_1", actor: "user:a",
  });
  assert.equal(approved.version.status, "approved");
  assert.equal(approved.method.status, "active");
  assert.equal(approved.method.current_version_id, v1.version_id);

  // 已批准版本不可变：再批准一次拒绝
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "msg:2", actor: "user:a" }),
    "AGENT_SPACE_IMMUTABLE",
  );

  // v2 批准采用后 v1 superseded；任务仍可 pin v1（受保护版本可重现）
  const v2 = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    actor: "user:a",
  });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_2", actor: "user:a" });
  const resolvedCurrent = space.resolveMethodVersion(scopeA, method.method_id);
  assert.equal(resolvedCurrent.version.version_id, v2.version_id, "default load resolves current adopted version");
  const resolvedPinned = space.resolveMethodVersion(scopeA, method.method_id, v1.version_id);
  assert.equal(resolvedPinned.version.status, "superseded");
  assert.equal(resolvedPinned.version.version_id, v1.version_id, "pinned formal version stays fully reproducible");

  // draft 永不解析为运行版本
  const v3 = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" }, actor: "user:a",
  });
  expectAgentSpaceError(() => space.resolveMethodVersion(scopeA, method.method_id, v3.version_id), "AGENT_SPACE_VERSION_INVALID");

  // 跨 scope 读取拒绝
  expectAgentSpaceError(() => space.getMethod(scopeB, method.method_id), "AGENT_SPACE_SCOPE_MISMATCH");

  // 幂等创建
  const idem = space.createMethod({ scope: scopeA, name: "幂等方法", idempotencyKey: "idem-m1", actor: "user:a" });
  const idem2 = space.createMethod({ scope: scopeA, name: "幂等方法", idempotencyKey: "idem-m1", actor: "user:a" });
  assert.equal(idem.method_id, idem2.method_id);
});

test("methods: W0 blocked semantics cannot be adopted silently (hold note survives approval)", async () => {
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "mg-策略-含hold", actor: "user:a" });
  const blocked = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    adoptionNote: "W0: hold-ambiguity(未决条款，禁止自动作为运行 Method 采用)",
    actor: "user:a",
  });
  assert.ok(blocked.adoption_note?.includes("hold-ambiguity"), "adoption note carries W0 constraint");
  // 服务层不禁止 owner 批准，但批准依据必须显式；审计里保留 note（详见 audit 测试）
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: blocked.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w1", actor: "owner" });
  const row = space.getMethodVersion(scopeA, blocked.version_id);
  assert.equal(row.adoption_note?.includes("hold-ambiguity"), true, "constraint stays attached post-approval");
});

test("skills: domains, publish decoupling, market visibility, install/upgrade rules", async () => {
  const space: Space = await getSpace();
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "chip-analysis", name: "筹码分析", actor: "user:a" });
  const sv1 = space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_s1" },
    origin: "private_edit", actor: "user:a",
  });
  // draft 不可发布、不可安装
  expectAgentSpaceError(
    () => space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s1", actor: "user:a" });
  const release = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a",
  });
  assert.equal(release.contentChecksum, "chk_s1");

  // 发布后私有继续修改：新 draft 不改变 release
  const sv2 = space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_s2" },
    origin: "private_edit", actor: "user:a",
  });
  const marketAfter = space.listPublicSkillReleases();
  const marketEntry = marketAfter.find((r) => r.releaseId === release.releaseId);
  assert.ok(marketEntry, "release visible in public market");
  assert.equal(marketEntry!.contentChecksum, "chk_s1", "market release pinned checksum; private edit did not leak");

  // 市场查询不泄漏 shared/private 可见性
  space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.1.0-shared", visibility: "shared", publishedBy: "user:a", actor: "user:a",
  });
  const marketShared = space.listPublicSkillReleases().filter((r) => r.releaseVersion === "1.1.0-shared");
  assert.equal(marketShared.length, 0, "shared release is not public-market visible");

  // 跨 scope 安装私有版本拒绝；draft 安装拒绝
  const agentB = space.createAgent({ scope: scopeB, name: "B助手", actor: "user:b" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:b", approvalRef: "x", actor: "user:b" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  const draftInstallAgent = space.createAgent({ scope: scopeA, name: "草稿安装助手", actor: "user:a" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: draftInstallAgent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: "x", actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );

  // 系统域技能：不得携带用户 scope（分域）
  expectAgentSpaceError(
    () => space.upsertSkill({ domain: "system", scope: scopeA, slug: "sys", name: "sys", actor: "owner" }),
    "AGENT_SPACE_SYSTEM_DOMAIN_REQUIRED",
  );
  const sysSkill = space.upsertSkill({ domain: "system", scope: null, slug: "fundamental-analysis", name: "基本面分析", actor: "owner" });
  const sysVersion = space.addSkillVersion({
    domain: "system", scope: null, skillId: sysSkill.skill_id,
    contentRef: { contentRefType: "system_template", systemTemplatePath: "templates/skills/fundamental-analysis/SKILL.md", contentChecksum: "chk_sys_1" },
    origin: "system_seed", actor: "owner",
  });
  assert.ok(sysVersion.version_id, "system seed version created");
});

test("agents: install pinning, upgrade requires explicit approval, method binding, asset grants", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "主助手", actor: "user:a" });
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "risk-control", name: "风控", actor: "user:a" });
  const sv = space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_r1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s2", actor: "user:a" });

  const install = space.installSkill({
    scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id,
    source: "private", versionId: sv.version_id, installedBy: "user:a", approvalRef: "conversation:um_w1_install", actor: "user:a",
  });
  assert.equal(install.version_id, sv.version_id, "installation pins a fixed version");

  // 升级需显式批准依据：无 approvalRef 拒绝
  const sv2 = space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_r2" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s3", actor: "user:a" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: " ", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  const upgraded = space.installSkill({
    scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id,
    source: "private", versionId: sv2.version_id, installedBy: "user:a",
    approvalRef: "conversation:um_w1_upgrade", actor: "user:a",
  });
  const installed = space.listInstalledSkills(scopeA, agent.agent_id);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.version_id, upgraded.version_id, "upgrade moves current installation");

  // 方法绑定：pin 必须是正式版本
  const method = space.createMethod({ scope: scopeA, name: "绑定目标方法", actor: "user:a" });
  const mvDraft = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_m" }, actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mvDraft.version_id, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mvDraft.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_m", actor: "user:a" });
  space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mvDraft.version_id, actor: "user:a" });

  // 资产授权：引用本 scope 资产；跨 scope 资产拒绝
  const grant = space.grantAsset({ scope: scopeA, agentId: agent.agent_id, assetId: "asset_a1", grantedBy: "user:a", actor: "user:a" });
  assert.ok(grant.grantId);
  const { db } = await fixture;
  db.sqlite
    .prepare(
      `INSERT INTO user_assets (asset_id, user_id, project_id, instance_id, name, status, current_version_id, created_at, updated_at)
       VALUES ('asset_b1', ?, ?, ?, 'B资产', 'active', NULL, ?, ?)`,
    )
    .run(scopeB.userId, scopeB.projectId, scopeB.instanceId, new Date().toISOString(), new Date().toISOString());
  expectAgentSpaceError(
    () => space.grantAsset({ scope: scopeA, agentId: agent.agent_id, assetId: "asset_b1", grantedBy: "user:a", actor: "user:a" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );

  // 跨 scope 读取 agent 拒绝
  expectAgentSpaceError(() => space.getAgent(scopeB, agent.agent_id), "AGENT_SPACE_SCOPE_MISMATCH");
});

test("task dependencies and immutable run snapshots express full assembly", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "快照助手", idempotencyKey: "snap-agent", actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "快照方法", actor: "user:a" });
  const mv = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_snap" }, actor: "user:a",
  });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_snap", actor: "user:a" });

  // pinned 依赖校验：draft 版本拒绝、跨 scope 版本拒绝
  const draftMethod = space.createMethod({ scope: scopeA, name: "快照方法2", actor: "user:a" });
  const draftVer = space.addMethodVersion({
    scope: scopeA, methodId: draftMethod.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_snap2" }, actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_w1", kind: "method", refId: draftMethod.method_id, versionPolicy: "pinned", pinnedVersionId: draftVer.version_id, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  space.upsertTaskDependency({
    scope: scopeA, taskId: "task_w1", agentId: agent.agent_id, kind: "method",
    refId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mv.version_id, actor: "user:a",
  });
  space.upsertTaskDependency({
    scope: scopeA, taskId: "task_w1", kind: "asset_input", refId: "asset_a1",
    versionPolicy: "pinned", pinnedVersionId: "ver_a1", actor: "user:a",
  });
  // 资产 pin 不属于 ref 资产 → 拒绝
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_w1", kind: "asset_input", refId: "asset_wrong", versionPolicy: "pinned", pinnedVersionId: "ver_a1", actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );

  const deps = space.listTaskDependencies(scopeA, "task_w1");
  assert.equal(deps.length, 2);
  assert.deepEqual(space.listTaskDependencies(scopeB, "task_w1"), [], "cross-scope listing leaks no rows");

  const snap = space.recordTaskRunSnapshot({
    scope: scopeA, runId: "run_w1_1", taskId: "task_w1", agentId: agent.agent_id,
    assembly: {
      agent: { agentId: agent.agent_id },
      skills: [{ objectType: "skill", objectId: "skill_x", versionId: "sver_x", versionPolicy: "pinned", contentChecksum: "chk_s" }],
      methods: [{ objectType: "method", objectId: method.method_id, versionId: mv.version_id, versionPolicy: "pinned", contentChecksum: "chk_snap" }],
      assets: [{ objectType: "asset", objectId: "asset_a1", versionId: "ver_a1", versionPolicy: "pinned", contentChecksum: "chk_a1" }],
      agentState: [{ objectType: "agent_state", objectId: "lesson_y", versionId: "lver_y", versionPolicy: "current" }],
    },
    actor: "system",
  });
  assert.ok(snap.assemblyHash.length === 64);

  // 幂等：同 run 重复记录返回同一快照
  const snapAgain = space.recordTaskRunSnapshot({
    scope: scopeA, runId: "run_w1_1", taskId: "task_w1",
    assembly: { skills: [], methods: [], assets: [], agentState: [] }, actor: "system",
  });
  assert.equal(snapAgain.snapshotId, snap.snapshotId);

  // 快照只有引用没有正文：assembly JSON 不含 guidance/内容字段
  const read = space.getTaskRunSnapshot(scopeA, "run_w1_1");
  const assemblyText = JSON.stringify(read.assembly);
  assert.ok(!/"guidance"/.test(assemblyText) && !/"content"/.test(assemblyText), "snapshot stores references only");
  assert.ok(read.assembly.methods && Array.isArray(read.assembly.methods) && read.assembly.methods.length === 1);

  // 不可变：服务层无更新路径；直接 SQL 改写会破坏契约——用只读断言验证快照行为不变
  expectAgentSpaceError(() => space.getTaskRunSnapshot(scopeB, "run_w1_1"), "AGENT_SPACE_SCOPE_MISMATCH");
});

test("T-524 state: facts idempotent, drafts excluded from effective retrieval, approval semantics", async () => {
  const space: Space = await getSpace();
  const fact = space.recordAgentFact({
    scope: scopeA, eventType: "self_correction", sourceType: "trace", sourceId: "tr_w1_1", occurredAt: new Date().toISOString(),
  });
  const factDup = space.recordAgentFact({
    scope: scopeA, eventType: "self_correction", sourceType: "trace", sourceId: "tr_w1_1", occurredAt: new Date().toISOString(),
  });
  assert.equal(fact.factId, factDup.factId, "facts are idempotent by natural key");

  const lesson = space.createStateCandidate({
    scope: scopeA, kind: "lesson", title: "先查工具结果再引方法",
    content: { trigger: "实时数据任务", guidance: "先查当前工具结果，再参考旧方法文件", applicability: { taskType: "market-watch" } },
    actor: "agent",
  });
  // draft 不进入有效检索
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" }).length, 0);

  // 无依据不得批准；批准不改证据状态
  expectAgentSpaceError(
    () => space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, approvedBy: "user:a", approvalRef: "", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, approvedBy: "user:a", approvalRef: "conversation:um_w1_lesson", actor: "user:a" });
  const effective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(effective.length, 1);
  assert.equal(effective[0]!.versionId, lesson.versionId, "approval binds the specific version");
  const { db } = await fixture;
  const lessonRow = db.sqlite.prepare("SELECT evidence_state FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { evidence_state: string };
  assert.equal(lessonRow.evidence_state, "hypothesis", "approval does not change evidence state");

  // 跨 scope 检索不串（B 看不到 A 的 active lesson）
  assert.equal(space.listEffectiveState({ scope: scopeB, kind: "lesson" }).length, 0);

  // 修订：active → draft（新版本），draft 不注入
  space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { guidance: "修订后" }, actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" }).length, 0, "revised draft excluded until re-approved");

  // 停用/拒绝终态
  const wf = space.createStateCandidate({ scope: scopeA, kind: "workflow", title: "盯盘流程", content: { steps: [] }, actor: "agent" });
  space.approveStateCandidate({ scope: scopeA, kind: "workflow", objectId: wf.objectId, approvedBy: "user:a", approvalRef: "conversation:um_w1_wf", actor: "user:a" });
  space.transitionStateCandidate({ scope: scopeA, kind: "workflow", objectId: wf.objectId, toStatus: "disabled", reason: "用户停用", actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "workflow" }).length, 0);
});

test("commitments: authorization + executor readiness, recurring stays active across periods", async () => {
  const space: Space = await getSpace();
  const commitment = space.createCommitment({
    scope: scopeA, title: "每交易日盯盘提醒", content: { window: "09:25-11:30" },
    commitmentKind: "recurring", completionCriteria: "盯盘窗口结束且异常已推送或确认无异常",
    idempotencyKey: "cmt-idem-1", actor: "agent",
  });
  const dup = space.createCommitment({
    scope: scopeA, title: "每交易日盯盘提醒", content: { window: "09:25-11:30" },
    commitmentKind: "recurring", completionCriteria: "同上", idempotencyKey: "cmt-idem-1", actor: "agent",
  });
  assert.equal(commitment.commitmentId, dup.commitmentId, "commitment creation is idempotent");

  // 缺执行器/缺授权拒绝激活
  expectAgentSpaceError(
    () => space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: "conversation:um_w1_c", executorTaskId: "task_missing", actor: "user:a" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  space.activateCommitment({
    scope: scopeA, commitmentId: commitment.commitmentId,
    authorizationRef: "conversation:um_w1_c", executorTaskId: "task_exec_1", actor: "user:a",
  });

  // 周期承诺：一期 satisfied 后仍 active，可记下一期
  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-21T11:30:00+08:00", status: "satisfied", runId: "run_w1_c1", actor: "system" });
  expectAgentSpaceError(
    () => space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "completed", actor: "user:a" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-22T11:30:00+08:00", status: "failed_needs_attention", runId: "run_w1_c2", actor: "system" });
  const { db } = await fixture;
  const statusRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(statusRow.status, "active", "recurring commitment stays active across periods");
  const fulfillments = db.sqlite
    .prepare("SELECT status, commitment_version_number FROM agent_space_commitment_fulfillments WHERE commitment_id=? ORDER BY due_at")
    .all(commitment.commitmentId) as Array<{ status: string; commitment_version_number: number }>;
  assert.equal(fulfillments.length, 2);
  assert.equal(fulfillments[0]!.commitment_version_number, 1, "fulfillment binds commitment version");

  // 暂停后不可登记履约；可重新激活
  space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "paused", reason: "假期", actor: "user:a" });
  expectAgentSpaceError(
    () => space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-23T11:30:00+08:00", status: "satisfied", actor: "system" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  space.activateCommitment({
    scope: scopeA, commitmentId: commitment.commitmentId,
    authorizationRef: "conversation:um_w1_c_resume", executorTaskId: "task_exec_1", actor: "user:a",
  });
});

test("audit: every lifecycle mutation leaves a scoped audit row", async () => {
  const { db } = await fixture;
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "审计方法", actor: "user:a" });
  const v = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id,
    contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_audit" },
    adoptionNote: "W0: historical-not-default(历史定位，禁止默认采用)", actor: "user:a",
  });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/audit", actor: "owner" });

  const actions = db.sqlite
    .prepare(
      "SELECT action, from_status, to_status, detail_json FROM agent_space_audit_logs WHERE object_type='agent_space_method_version' AND object_id=? ORDER BY created_at",
    )
    .all(v.version_id) as Array<{ action: string; from_status: string | null; to_status: string; detail_json: string }>;
  assert.deepEqual(actions.map((a) => a.action), ["method.version.drafted", "method.version.approved"]);
  assert.equal(actions[0]!.from_status, null);
  assert.equal(actions[1]!.to_status, "approved");
  const detail = JSON.parse(actions[0]!.detail_json);
  assert.ok(String(detail.adoptionNote).includes("historical-not-default"), "W0 constraint recorded in audit trail");
  const scopeRow = db.sqlite
    .prepare("SELECT user_id FROM agent_space_audit_logs WHERE object_id=? LIMIT 1")
    .get(v.version_id) as { user_id: string };
  assert.equal(scopeRow.user_id, scopeA.userId, "audit rows carry scope");
});
