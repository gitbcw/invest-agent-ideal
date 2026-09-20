/**
 * W1 Agent Space 域隔离测试（返工 R1-R5 后）。
 *
 * 除原验收矩阵外，重点覆盖验收单反例：
 * R1 依赖/快照真实归属（跨域改写、伪 run、外域装配、载荷白名单、幂等冲突）；
 * R2 发布可见性/状态/系统域 owner 令牌；R3 引用真实性与结构化采用约束；
 * R4 批准绑定预期版本、修订不退有效版、状态归属与内容白名单；
 * R5 事务原子性（审计失败注入）与幂等冲突、旧库升级保数据。
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
const OWNER_TOKEN = "w1-test-owner-token";
const now = new Date().toISOString();

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const space = await import("../src/services/agent-space/index.js");
  const seed = db.sqlite;
  seed.prepare("INSERT INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(OWNER_TOKEN);
  seed.prepare(`INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,name,status,current_version_id,created_at,updated_at)
                VALUES ('asset_a1',?,?,?,'A方法资产','active',NULL,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  seed.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at)
                VALUES ('ver_a1','asset_a1',?,?,?,1,'strategy.md','markdown','text/markdown',10,'chk_a1','assets/asset_a1/versions/ver_a1','test',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  seed.prepare(`INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,name,status,current_version_id,created_at,updated_at)
                VALUES ('asset_a2',?,?,?,'A另一资产','active',NULL,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  seed.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at)
                VALUES ('ver_a2','asset_a2',?,?,?,1,'a2.md','markdown','text/markdown',10,'chk_a2','assets/asset_a2/versions/ver_a2','test',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  seed.prepare(`INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,name,status,current_version_id,created_at,updated_at)
                VALUES ('asset_b1',?,?,?,'B资产','active',NULL,?,?)`).run(scopeB.userId, scopeB.projectId, scopeB.instanceId, now, now);
  seed.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at)
                VALUES ('ver_b1','asset_b1',?,?,?,1,'b.md','markdown','text/markdown',10,'chk_b1','assets/asset_b1/versions/ver_b1','test',?)`)
      .run(scopeB.userId, scopeB.projectId, scopeB.instanceId, now);
  seed.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at)
                VALUES ('conv_w1',?,?,?,'invest-agent-a','weixin','W1会话','',1,'active',?,?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  for (const [mid, uid, pid, iid, aid] of [
    ["um_w1_1", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_2", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_s1", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_s2", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_s3", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_m", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_snap", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_lesson", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_lesson2", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_wf", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_install", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_upgrade", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_c", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_c_resume", scopeA.userId, scopeA.projectId, scopeA.instanceId, "invest-agent-a"],
    ["um_w1_b1", scopeB.userId, scopeB.projectId, scopeB.instanceId, "invest-agent-b"],
  ] as const) {
    seed.prepare(`INSERT INTO conversation_messages (message_id,conversation_id,user_id,project_id,instance_id,assistant_id,channel,role,content,status,created_at)
                  VALUES (?, 'conv_w1', ?, ?, ?, ?, 'weixin', 'user', 'w1 seed', 'completed', ?)`)
        .run(mid, uid, pid, iid, aid, now);
  }
  seed.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                VALUES ('task_exec_1',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  seed.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                VALUES ('task_exec_b',?,?,?,'active',1,?,?)`).run(scopeB.userId, scopeB.projectId, scopeB.instanceId, now, now);
  seed.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,description,schedule_json,inputs_json,output_json,delivery_json,created_at)
                VALUES ('rev_w1_1','task_exec_1',?,?,?,1,'W1执行修订','w1','{}','[]','{"mode":"agent"}','{}',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  seed.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                VALUES ('run_w1_1','task_exec_1','rev_w1_1',?,?,?,'manual','idem-run-w1-1',1,'succeeded',?,?,?,?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now, now, now);
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

const CONTENT_A = { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" } as const;

test("isolated DB: tables created, re-running initDb is idempotent (repeatable upgrade)", async () => {
  const { db } = await fixture;
  const tables = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%' ORDER BY name")
    .all()
    .map((r: { name: string }) => r.name);
  assert.equal(tables.length, 19);
  db.initDb();
  const checkpoint = db.sqlite.prepare("SELECT key FROM schema_migrations WHERE key='agent_space_v1'").get();
  assert.ok(checkpoint);
});

test("R5: upgrade with existing data preserves old-domain and new-domain rows", async () => {
  const { db, space } = await fixture;
  const method = space.createMethod({ scope: scopeA, name: "升级保数据方法", idempotencyKey: "upgrade-m1", actor: "user:a" });
  db.initDb();
  const kept = db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_methods WHERE method_id=?").get(method.method_id) as { n: number };
  assert.equal(kept.n, 1, "agent_space rows survive initDb replay");
  const oldRows = db.sqlite.prepare("SELECT COUNT(*) AS n FROM conversation_messages WHERE user_id=?").get(scopeA.userId) as { n: number };
  assert.ok(oldRows.n > 0, "pre-existing domain rows untouched");
});

test("fixture reset (not recovery): dropping the domain recreates an empty structure", async () => {
  const { db } = await fixture;
  const names = db.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%'")
    .all()
    .map((r: { name: string }) => r.name);
  db.sqlite.transaction(() => {
    for (const n of names) db.sqlite.exec(`DROP TABLE IF EXISTS ${n}`);
  })();
  db.initDb();
  const restored = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'agent_space_%'")
    .get() as { n: number };
  assert.equal(restored.n, 19, "structure replay recreates the domain (empty); real-data recovery uses verified backups per W1-delivery §6");
});

test("R3: method content refs must be real, in-scope, checksum-matched", async () => {
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "引用校验方法", actor: "user:a" });
  expectAgentSpaceError(
    () => space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: { assetId: "asset_a1", assetVersionId: "ver_missing", contentChecksum: "chk_a1" }, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  expectAgentSpaceError(
    () => space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: { assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "fake" }, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  expectAgentSpaceError(
    () => space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: { assetId: "asset_b1", assetVersionId: "ver_b1", contentChecksum: "chk_b1" }, actor: "user:a" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  expectAgentSpaceError(
    () => space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: { assetId: "asset_a1", assetVersionId: "ver_a2", contentChecksum: "chk_a2" }, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
});

test("methods: lifecycle, version ownership, verifiable approvals, resolution", async () => {
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "量价波段", actor: "user:a" });
  const v1 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  assert.equal(v1.status, "draft");

  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "随便写的", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "conversation:um_missing", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_b1", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeB, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:b", approvalRef: "conversation:um_w1_b1", actor: "user:b" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );

  const approved = space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v1.version_id,
    approvedBy: "user:a", approvalRef: "conversation:um_w1_1", actor: "user:a",
  });
  assert.equal(approved.method.current_version_id, v1.version_id);
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_2", actor: "user:a" }),
    "AGENT_SPACE_IMMUTABLE",
  );

  const v2 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_2", actor: "user:a" });
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id).version.version_id, v2.version_id);
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id, v1.version_id).version.version_id, v1.version_id);
  const v3 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  expectAgentSpaceError(() => space.resolveMethodVersion(scopeA, method.method_id, v3.version_id), "AGENT_SPACE_VERSION_INVALID");

  const other = space.createMethod({ scope: scopeA, name: "另一方法", actor: "user:a" });
  const otherV = space.addMethodVersion({ scope: scopeA, methodId: other.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: other.method_id, versionId: otherV.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_2", actor: "user:a" });
  expectAgentSpaceError(() => space.resolveMethodVersion(scopeA, method.method_id, otherV.version_id), "AGENT_SPACE_VERSION_INVALID");

  const idem = space.createMethod({ scope: scopeA, name: "幂等方法", idempotencyKey: "idem-m1", actor: "user:a" });
  assert.equal(space.createMethod({ scope: scopeA, name: "幂等方法", idempotencyKey: "idem-m1", actor: "user:a" }).method_id, idem.method_id);
  expectAgentSpaceError(
    () => space.createMethod({ scope: scopeA, name: "换个名字", idempotencyKey: "idem-m1", actor: "user:a" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
});

test("R3: structured adoption constraints block default adoption and runtime binding", async () => {
  const space: Space = await getSpace();
  const holdMethod = space.createMethod({ scope: scopeA, name: "hold方法", actor: "user:a" });
  const holdV = space.addMethodVersion({
    scope: scopeA, methodId: holdMethod.method_id, contentRef: CONTENT_A,
    adoptionConstraints: ["hold-ambiguity"], actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, versionId: holdV.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_m", actor: "user:a" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );
  const holdApproved = space.approveMethodVersion({
    scope: scopeA, methodId: holdMethod.method_id, versionId: holdV.version_id,
    approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w1-hold", ownerToken: OWNER_TOKEN, actor: "owner",
  });
  assert.equal(holdApproved.method.current_version_id, holdV.version_id, "owner decision can adopt a hold version");
  assert.equal(holdApproved.version.adoption_constraints, JSON.stringify(["hold-ambiguity"]));

  const histMethod = space.createMethod({ scope: scopeA, name: "旧KP方法", actor: "user:a" });
  const histV = space.addMethodVersion({
    scope: scopeA, methodId: histMethod.method_id, contentRef: CONTENT_A,
    adoptionConstraints: ["historical-not-default"], actor: "user:a",
  });
  const histApproved = space.approveMethodVersion({
    scope: scopeA, methodId: histMethod.method_id, versionId: histV.version_id,
    approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w1-hist", ownerToken: OWNER_TOKEN, actor: "owner",
  });
  assert.equal(histApproved.method.current_version_id, null, "historical-not-default never becomes current");
  expectAgentSpaceError(() => space.resolveMethodVersion(scopeA, histMethod.method_id, histV.version_id), "AGENT_SPACE_ADOPTION_CONSTRAINT");
  assert.equal(space.getMethodVersion(scopeA, histV.version_id).status, "approved", "historical read path stays available");
});

test("R2/R3: skills — refs, publish visibility, install rules, system domain", async () => {
  const space: Space = await getSpace();
  expectAgentSpaceError(
    () => space.upsertSkill({ domain: "system", scope: null, slug: "sys-x", name: "系统X", actor: "caller" }),
    "AGENT_SPACE_OWNER_AUTH_REQUIRED",
  );
  const sysSkill = space.upsertSkill({ domain: "system", scope: null, slug: "sys-ok", name: "系统OK", ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.ok(sysSkill.skill_id);

  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "chip-analysis", name: "筹码分析", actor: "user:a" });
  await assert.rejects(
    space.addSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_missing", contentChecksum: "chk_a1" }, origin: "private_edit", actor: "user:a" }),
    /AGENT_SPACE_VERSION_INVALID/,
  );
  await assert.rejects(
    space.addSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "fake" }, origin: "private_edit", actor: "user:a" }),
    /AGENT_SPACE_VERSION_INVALID/,
  );
  const sv1 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s1", actor: "user:a" });

  const privateRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.0.0-private", visibility: "private", publishedBy: "user:a", actor: "user:a",
  });
  const agentB = space.createAgent({ scope: scopeB, name: "B助手", actor: "user:b" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: "conversation:um_w1_b1", actor: "user:b" }),
    "AGENT_SPACE_VISIBILITY_INVALID",
  );
  const sharedRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.0.0-shared", visibility: "shared", publishedBy: "user:a", actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: sharedRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: "conversation:um_w1_b1", actor: "user:b" }),
    "AGENT_SPACE_VISIBILITY_INVALID",
  );
  const publicRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "2.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a",
  });
  space.retireSkillRelease({ domain: "user", scope: scopeA, releaseId: publicRelease.releaseId, actor: "user:a" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: publicRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: "conversation:um_w1_b1", actor: "user:b" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  const agentA = space.createAgent({ scope: scopeA, name: "A主助手", actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agentA.agent_id, skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId, versionId: sv1.version_id, installedBy: "user:a", approvalRef: "conversation:um_w1_install", actor: "user:a" });
  const market = space.listPublicSkillReleases().map((r) => r.releaseId);
  assert.ok(!market.includes(privateRelease.releaseId) && !market.includes(sharedRelease.releaseId));
  assert.ok(!market.includes(publicRelease.releaseId), "retired release leaves the market");
});

test("agents: install pinning/upgrade approval, method binding constraints, asset grants", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "主助手", actor: "user:a" });
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "risk-control", name: "风控", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s2", actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv.version_id, installedBy: "user:a", approvalRef: "conversation:um_w1_install", actor: "user:a" });

  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_s3", actor: "user:a" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: "not-a-ref", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: "conversation:um_w1_upgrade", actor: "user:a" });
  const installed = space.listInstalledSkills(scopeA, agent.agent_id);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.version_id, sv2.version_id);

  const method = space.createMethod({ scope: scopeA, name: "绑定方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_m", actor: "user:a" });
  space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mv.version_id, actor: "user:a" });
  const histMethod = space.createMethod({ scope: scopeA, name: "历史绑定方法", actor: "user:a" });
  const histV = space.addMethodVersion({ scope: scopeA, methodId: histMethod.method_id, contentRef: CONTENT_A, adoptionConstraints: ["historical-not-default"], actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: histMethod.method_id, versionId: histV.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/bind-hist", ownerToken: OWNER_TOKEN, actor: "owner" });
  expectAgentSpaceError(
    () => space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: histMethod.method_id, versionPolicy: "pinned", pinnedVersionId: histV.version_id, actor: "user:a" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );

  space.grantAsset({ scope: scopeA, agentId: agent.agent_id, assetId: "asset_a1", grantedBy: "user:a", actor: "user:a" });
  expectAgentSpaceError(
    () => space.grantAsset({ scope: scopeA, agentId: agent.agent_id, assetId: "asset_b1", grantedBy: "user:a", actor: "user:a" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  expectAgentSpaceError(() => space.getAgent(scopeB, agent.agent_id), "AGENT_SPACE_SCOPE_MISMATCH");
});

test("R1: task dependencies verify real ownership; cross-scope overwrite rejected; agent_state fail-closed", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "依赖助手", actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "依赖方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_m", actor: "user:a" });

  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_missing", kind: "method", refId: method.method_id, versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_exec_b", kind: "method", refId: method.method_id, versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_exec_1", agentId: `${agent.agent_id}X`, kind: "method", refId: method.method_id, versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_exec_1", kind: "agent_state", refId: "lesson_x", versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_UNSUPPORTED",
  );
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_exec_1", kind: "asset_input", refId: "asset_b1", versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeA, taskId: "task_exec_1", kind: "skill", refId: "skill_missing", versionPolicy: "latest", actor: "user:a" }),
    "AGENT_SPACE_NOT_FOUND",
  );

  space.upsertTaskDependency({
    scope: scopeA, taskId: "task_exec_1", agentId: agent.agent_id, kind: "method",
    refId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mv.version_id, actor: "user:a",
  });
  expectAgentSpaceError(
    () => space.upsertTaskDependency({ scope: scopeB, taskId: "task_exec_1", agentId: agent.agent_id, kind: "method", refId: method.method_id, versionPolicy: "latest", actor: "user:b" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  space.upsertTaskDependency({ scope: scopeB, taskId: "task_exec_b", kind: "asset_input", refId: "asset_b1", versionPolicy: "latest", actor: "user:b" });
  const aRows = space.listTaskDependencies(scopeA, "task_exec_1");
  assert.equal(aRows.length, 1);
  assert.equal(aRows[0]!.version_policy, "pinned");
  assert.deepEqual(space.listTaskDependencies(scopeB, "task_exec_1"), [], "cross-scope listing leaks nothing");
});

test("R1: run snapshots validate chain, whitelist payload, reject replay conflicts", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "快照助手", actor: "user:a" });
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "snap-skill", name: "快照技能", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_snap", actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "快照方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: "conversation:um_w1_snap", actor: "user:a" });

  const goodAssembly = {
    agent: { agentId: agent.agent_id },
    skills: [{ objectType: "skill", objectId: skill.skill_id, versionId: sv.version_id, versionPolicy: "pinned", contentChecksum: "chk_a1" }],
    methods: [{ objectType: "method", objectId: method.method_id, versionId: mv.version_id, versionPolicy: "pinned", contentChecksum: "chk_a1" }],
    assets: [{ objectType: "asset", objectId: "asset_a1", versionId: "ver_a1", versionPolicy: "pinned", contentChecksum: "chk_a1" }],
    agentState: [],
  };

  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_fake", taskId: "task_exec_1", assembly: goodAssembly, actor: "system" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_1", taskId: "task_exec_b", assembly: goodAssembly, actor: "system" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  const agentB = space.createAgent({ scope: scopeB, name: "B快照助手", actor: "user:b" });
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1", agentId: agentB.agent_id, assembly: goodAssembly, actor: "system" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, skills: [{ ...goodAssembly.skills[0]!, body: "正文不允许" }] }, actor: "system",
    }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, agentState: [{ objectType: "agent_state", objectId: "lesson_x", versionId: null, versionPolicy: "current" }] }, actor: "system",
    }),
    "AGENT_SPACE_UNSUPPORTED",
  );
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeB, runId: "run_w1_1", taskId: "task_exec_1", assembly: goodAssembly, actor: "system" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );

  const snap = space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1", agentId: agent.agent_id, assembly: goodAssembly, actor: "system" });
  assert.equal(snap.assemblyHash.length, 64);
  const replay = space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1", agentId: agent.agent_id, assembly: goodAssembly, actor: "system" });
  assert.equal(replay.snapshotId, snap.snapshotId);
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, skills: [] }, actor: "system",
    }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  const read = space.getTaskRunSnapshot(scopeA, "run_w1_1");
  const assemblyText = JSON.stringify(read.assembly);
  assert.ok(!/"body"/.test(assemblyText) && !/"guidance"/.test(assemblyText), "references only");
  assert.equal(read.assembly.methods.length, 1);
});

test("R4: state candidates — owner binding, content whitelist, expectedVersionId, revision semantics", async () => {
  const space: Space = await getSpace();
  expectAgentSpaceError(
    () => space.createStateCandidate({ scope: scopeA, kind: "lesson", title: "无归属", content: { trigger: "t", guidance: "g" }, ownerKind: "conversation", ownerId: "conv_missing", actor: "agent" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.createStateCandidate({ scope: scopeA, kind: "lesson", title: "任意字段", content: { trigger: "t", guidance: "g", whatever: 1 }, ownerKind: "conversation", ownerId: "conv_w1", actor: "agent" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );

  const lesson = space.createStateCandidate({
    scope: scopeA, kind: "lesson", title: "先查工具结果再引方法",
    content: { trigger: "实时数据任务", guidance: "先查当前工具结果", applicability: { taskType: "market-watch" } },
    ownerKind: "conversation", ownerId: "conv_w1", actor: "agent",
  });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" }).length, 0, "draft excluded");
  expectAgentSpaceError(
    () => space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: "invalid-ref", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: "conversation:um_w1_lesson", actor: "user:a" });
  const effective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(effective.length, 1);
  assert.equal(effective[0]!.ownerId, "conv_w1");

  const rev = space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { trigger: "实时数据任务", guidance: "修订后指引" }, actor: "user:a" });
  const stillEffective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(stillEffective[0]!.versionId, lesson.versionId, "revision does not deactivate the approved version");
  expectAgentSpaceError(
    () => space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: "conversation:um_w1_lesson2", actor: "user:a" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: rev.versionId, approvedBy: "user:a", approvalRef: "conversation:um_w1_lesson2", actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" })[0]!.versionId, rev.versionId);

  const { db } = await fixture;
  const evidenceRow = db.sqlite.prepare("SELECT evidence_state FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { evidence_state: string };
  assert.equal(evidenceRow.evidence_state, "hypothesis");
  assert.equal(space.listEffectiveState({ scope: scopeB, kind: "lesson" }).length, 0);
  space.transitionStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, toStatus: "disabled", reason: "用户停用", actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" }).length, 0);

  const wf = space.createStateCandidate({
    scope: scopeA, kind: "workflow", title: "盯盘流程",
    content: { scenario: "盯盘", steps: ["查规则", "核对持仓"], expectedOutputs: ["结论"] },
    ownerKind: "task", ownerId: "task_exec_1", actor: "agent",
  });
  space.approveStateCandidate({ scope: scopeA, kind: "workflow", objectId: wf.objectId, expectedVersionId: wf.versionId, approvedBy: "user:a", approvalRef: "conversation:um_w1_wf", actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "workflow" }).length, 1);
});

test("commitments: verifiable authorization, executor readiness, recurring semantics", async () => {
  const space: Space = await getSpace();
  const commitment = space.createCommitment({
    scope: scopeA, title: "每交易日盯盘提醒", content: { window: "09:25-11:30" },
    commitmentKind: "recurring", completionCriteria: "窗口结束且异常已推送或确认无异常",
    idempotencyKey: "cmt-idem-1", actor: "agent",
  });
  assert.equal(space.createCommitment({
    scope: scopeA, title: "每交易日盯盘提醒", content: { window: "09:25-11:30" },
    commitmentKind: "recurring", completionCriteria: "窗口结束且异常已推送或确认无异常", idempotencyKey: "cmt-idem-1", actor: "agent",
  }).commitmentId, commitment.commitmentId);
  expectAgentSpaceError(
    () => space.createCommitment({
      scope: scopeA, title: "不同内容", content: {}, commitmentKind: "one_shot",
      completionCriteria: "x", idempotencyKey: "cmt-idem-1", actor: "agent",
    }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  expectAgentSpaceError(
    () => space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: "agent说可以", executorTaskId: "task_exec_1", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: "conversation:um_w1_c", executorTaskId: "task_missing", actor: "user:a" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: "conversation:um_w1_c", executorTaskId: "task_exec_1", actor: "user:a" });

  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-21T11:30:00+08:00", status: "satisfied", runId: "run_w1_1", actor: "system" });
  expectAgentSpaceError(
    () => space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "completed", actor: "user:a" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  expectAgentSpaceError(
    () => space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-22T11:30:00+08:00", status: "satisfied", runId: "run_fake", actor: "system" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-22T11:30:00+08:00", status: "failed_needs_attention", actor: "system" });
  const { db } = await fixture;
  const statusRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(statusRow.status, "active");
  space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "paused", reason: "假期", actor: "user:a" });
  expectAgentSpaceError(
    () => space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-23T11:30:00+08:00", status: "satisfied", actor: "system" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: "conversation:um_w1_c_resume", executorTaskId: "task_exec_1", actor: "user:a" });
});

test("facts are idempotent by natural key", async () => {
  const space: Space = await getSpace();
  const fact = space.recordAgentFact({ scope: scopeA, eventType: "self_correction", sourceType: "trace", sourceId: "tr_w1_1", occurredAt: now });
  const dup = space.recordAgentFact({ scope: scopeA, eventType: "self_correction", sourceType: "trace", sourceId: "tr_w1_1", occurredAt: now });
  assert.equal(fact.factId, dup.factId);
});

test("R5: audit failure rolls back the whole mutation (transactional atomicity)", async () => {
  const { db, space } = await fixture;
  db.sqlite.exec(`
    CREATE TRIGGER w1_fail_method_audit
    BEFORE INSERT ON agent_space_audit_logs
    WHEN NEW.action = 'method.created'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
  `);
  let threw = false;
  try {
    space.createMethod({ scope: scopeA, name: "原子性方法", actor: "user:a" });
  } catch {
    threw = true;
  }
  assert.ok(threw, "audit failure surfaces to caller");
  const leftover = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM agent_space_methods WHERE name='原子性方法'")
    .get() as { n: number };
  assert.equal(leftover.n, 0, "no partial write when audit fails");
  db.sqlite.exec("DROP TRIGGER w1_fail_method_audit");
  space.createMethod({ scope: scopeA, name: "原子性方法", actor: "user:a" });
  const after = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM agent_space_methods WHERE name='原子性方法'")
    .get() as { n: number };
  assert.equal(after.n, 1);
});

test("audit: every lifecycle mutation leaves a scoped audit row with constraints", async () => {
  const { db, space } = await fixture;
  const method = space.createMethod({ scope: scopeA, name: "审计方法", actor: "user:a" });
  const v = space.addMethodVersion({
    scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A,
    adoptionConstraints: ["historical-not-default"], actor: "user:a",
  });
  space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v.version_id,
    approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/audit", ownerToken: OWNER_TOKEN, actor: "owner",
  });
  const actions = db.sqlite
    .prepare("SELECT action, from_status, to_status, detail_json FROM agent_space_audit_logs WHERE object_type='agent_space_method_version' AND object_id=? ORDER BY created_at")
    .all(v.version_id) as Array<{ action: string; from_status: string | null; to_status: string; detail_json: string }>;
  assert.deepEqual(actions.map((a) => a.action), ["method.version.drafted", "method.version.approved"]);
  const detail = JSON.parse(actions[0]!.detail_json);
  assert.deepEqual(detail.adoptionConstraints, ["historical-not-default"]);
  const scopeRow = db.sqlite.prepare("SELECT user_id FROM agent_space_audit_logs WHERE object_id=? LIMIT 1").get(v.version_id) as { user_id: string };
  assert.equal(scopeRow.user_id, scopeA.userId);
});
