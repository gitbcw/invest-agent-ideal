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
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-agent-space-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "agent-space.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// W2：固定版本字节读取走 mastra 项目注册表（唯一存储根来源）。
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scopeA = { userId: "w1-user-a", projectId: "invest-agent", instanceId: "invest-agent-a" };
const scopeB = { userId: "w1-user-b", projectId: "invest-agent", instanceId: "invest-agent-b" };
const OWNER_TOKEN = "w1-test-owner-token";
const now = new Date().toISOString();

// W2 真实字节资产：fixture 落文件、测试断言读值，checksum 由真实字节计算。
const W2_BODY_V1 = Buffer.from("# 量价方法 W2 v1\n正文第一版\n", "utf8");
const W2_BODY_V2 = Buffer.from("# 量价方法 W2 v2\n正文第二版（小改动）\n", "utf8");
const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const W2_CHK_1 = sha256Of(W2_BODY_V1);
const W2_CHK_2 = sha256Of(W2_BODY_V2);
const CONTENT_W2_1 = { assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 } as const;
const CONTENT_W2_2 = { assetId: "asset_w2", assetVersionId: "ver_w2_2", contentChecksum: W2_CHK_2 } as const;

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
                  VALUES (?, 'conv_w1', ?, ?, ?, ?, 'weixin', 'user', 'w1 seed', 'sent', ?)`)
        .run(mid, uid, pid, iid, aid, now);
  }
  // R6：非用户消息（assistant）与未送达消息（failed）不能作为授权来源
  seed.prepare(`INSERT INTO conversation_messages (message_id,conversation_id,user_id,project_id,instance_id,assistant_id,channel,role,content,status,created_at)
                VALUES ('um_w1_asst','conv_w1',?,?,?,'invest-agent-a','weixin','assistant','助手消息并未取得用户批准','sent',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  seed.prepare(`INSERT INTO conversation_messages (message_id,conversation_id,user_id,project_id,instance_id,assistant_id,channel,role,content,status,created_at)
                VALUES ('um_w1_failed','conv_w1',?,?,?,'invest-agent-a','weixin','user','未送达','failed',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  seed.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                VALUES ('task_exec_1',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  seed.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                VALUES ('task_exec_b',?,?,?,'active',1,?,?)`).run(scopeB.userId, scopeB.projectId, scopeB.instanceId, now, now);
  seed.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,description,schedule_json,inputs_json,output_json,delivery_json,created_at)
                VALUES ('rev_w1_1','task_exec_1',?,?,?,1,'W1执行修订','w1','{}','[]','{"mode":"agent"}','{}',?)`)
      .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  for (const rid of ["run_w1_1", "run_w1_2", "run_w1_3"]) {
    seed.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                  VALUES (?,'task_exec_1','rev_w1_1',?,?,?,'manual',?,1,'succeeded',?,?,?,?)`)
        .run(rid, scopeA.userId, scopeA.projectId, scopeA.instanceId, `idem-${rid}`, now, now, now, now);
  }
  // W2：scopeA 注册 mastra 测试项目并落真实字节资产（存储路径与 user-assets 契约一致）。
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectRoot = await registerTestProject(scopeA);
  seed.prepare(`INSERT INTO user_assets (asset_id,user_id,project_id,instance_id,name,status,current_version_id,created_at,updated_at)
                VALUES ('asset_w2',?,?,?,'W2方法资产','active',NULL,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  for (const [vid, body] of [["ver_w2_1", W2_BODY_V1], ["ver_w2_2", W2_BODY_V2]] as const) {
    const dir = path.join(projectRoot, "assets", "asset_w2", "versions", vid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "strategy.md"), body);
    seed.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at)
                  VALUES (?,'asset_w2',?,?,?,1,'strategy.md','markdown','text/markdown',?,?,?,'system',?)`)
        .run(vid, scopeA.userId, scopeA.projectId, scopeA.instanceId, body.length, sha256Of(body), `assets/asset_w2/versions/${vid}/strategy.md`, now);
  }
  return { db, space };
})();

type Space = Awaited<ReturnType<typeof getSpace>>;
async function getSpace() {
  return (await fixture).space;
}

/** R6 授权 helper：以真实用户消息登记绑定式授权，返回凭证字符串。 */
async function authz(
  scope: typeof scopeA | typeof scopeB,
  messageId: string,
  binding: { operation: string; objectType: string; objectId: string; versionId?: string | null; extraBinding?: Record<string, string> },
): Promise<string> {
  const space: Space = await getSpace();
  const { authorizationId } = space.registerUserAuthorization({
    scope, subjectUser: scope.userId, actor: "runtime-confirmation",
    sourceMessageId: messageId, ...binding,
  });
  return `authorization:${authorizationId}`;
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
  assert.equal(tables.length, 20);
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
  assert.equal(restored.n, 20, "structure replay recreates the domain (empty); real-data recovery uses verified backups per W1-delivery §6");
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

  const authzM1 = await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v1.version_id, versionId: v1.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "随便写的", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: "authorization:authz_missing", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  // R6：绑定不匹配（别的对象/版本/操作）拒绝
  const wrongTarget = await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: "other-object", versionId: v1.version_id });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: wrongTarget, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeB, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:b", approvalRef: authzM1, actor: "user:b" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );

  const approved = space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v1.version_id,
    approvedBy: "user:a", approvalRef: authzM1, actor: "user:a",
  });
  assert.equal(approved.method.current_version_id, v1.version_id);
  // R9②：成功后同请求重放返回既有结果，无新增审计/状态转换
  const { db } = await fixture;
  const auditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v1.version_id) as { n: number }).n;
  const replay = space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v1.version_id,
    approvedBy: "user:a", approvalRef: authzM1, actor: "user:a",
  });
  assert.equal(replay.version.status, "approved");
  assert.equal(replay.version.version_id, v1.version_id);
  assert.equal(replay.method.current_version_id, v1.version_id);
  const auditsAfter = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v1.version_id) as { n: number }).n;
  assert.equal(auditsAfter, auditsBefore, "replay adds no audit rows");

  const v2 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v2.version_id, versionId: v2.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id).version.version_id, v2.version_id);
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id, v1.version_id).version.version_id, v1.version_id);
  const v3 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  expectAgentSpaceError(() => space.resolveMethodVersion(scopeA, method.method_id, v3.version_id), "AGENT_SPACE_VERSION_INVALID");

  const other = space.createMethod({ scope: scopeA, name: "另一方法", actor: "user:a" });
  const otherV = space.addMethodVersion({ scope: scopeA, methodId: other.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: other.method_id, versionId: otherV.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: otherV.version_id, versionId: otherV.version_id, extraBinding: { methodId: other.method_id, adopt: "true" } }), actor: "user:a" });
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
  const holdAuth = await authz(scopeA, "um_w1_m", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: holdV.version_id, versionId: holdV.version_id, extraBinding: { methodId: holdMethod.method_id, adopt: "true" } });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, versionId: holdV.version_id, approvedBy: "user:a", approvalRef: holdAuth, actor: "user:a" }),
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
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv1.version_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });

  const privateRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.0.0-private", visibility: "private", publishedBy: "user:a", actor: "user:a",
  });
  const agentB = space.createAgent({ scope: scopeB, name: "B助手", actor: "user:b" });
  const installAuthB = await authz(scopeB, "um_w1_b1", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentB.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId } });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: installAuthB, actor: "user:b" }),
    "AGENT_SPACE_VISIBILITY_INVALID",
  );
  const sharedRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "1.0.0-shared", visibility: "shared", publishedBy: "user:a", actor: "user:a",
  });
  const sharedAuthB = await authz(scopeB, "um_w1_b1", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentB.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "release", releaseId: sharedRelease.releaseId } });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: sharedRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: sharedAuthB, actor: "user:b" }),
    "AGENT_SPACE_VISIBILITY_INVALID",
  );
  const publicRelease = space.publishSkillRelease({
    domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id,
    releaseVersion: "2.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a",
  });
  space.retireSkillRelease({ domain: "user", scope: scopeA, releaseId: publicRelease.releaseId, actor: "user:a" });
  const retiredAuthB = await authz(scopeB, "um_w1_b1", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentB.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "release", releaseId: publicRelease.releaseId } });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeB, agentId: agentB.agent_id, skillId: skill.skill_id, source: "release", releaseId: publicRelease.releaseId, versionId: sv1.version_id, installedBy: "user:b", approvalRef: retiredAuthB, actor: "user:b" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  const agentA = space.createAgent({ scope: scopeA, name: "A主助手", actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agentA.agent_id, skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId, versionId: sv1.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentA.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "release", releaseId: privateRelease.releaseId } }), actor: "user:a" });
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
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s2", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv.version_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });

  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s3", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv2.version_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: "not-a-ref", actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_upgrade", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });
  const installed = space.listInstalledSkills(scopeA, agent.agent_id);
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.version_id, sv2.version_id);

  const method = space.createMethod({ scope: scopeA, name: "绑定方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_m", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv.version_id, versionId: mv.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
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
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_m", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv.version_id, versionId: mv.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });

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
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_snap", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv.version_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "快照方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_snap", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv.version_id, versionId: mv.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });

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
  // R8：同 scope 双 Agent 不一致 → 拒绝
  const agentA2 = space.createAgent({ scope: scopeA, name: "A第二助手", actor: "user:a" });
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1", agentId: agentA2.agent_id, assembly: goodAssembly, actor: "system" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
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
  // R8 反例：无任何版本的 draft Method + null versionId + 伪 checksum → 拒绝
  const draftOnlyMethod = space.createMethod({ scope: scopeA, name: "无版本方法", actor: "user:a" });
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, methods: [{ objectType: "method", objectId: draftOnlyMethod.method_id, versionId: null, versionPolicy: "pinned", contentChecksum: "fabricated" }] }, actor: "system",
    }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  // R8：正式版本但伪 checksum → 拒绝
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, methods: [{ objectType: "method", objectId: method.method_id, versionId: mv.version_id, versionPolicy: "pinned", contentChecksum: "fabricated" }] }, actor: "system",
    }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  // R8：类别错位（skill 条目放进 methods）→ 拒绝
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({
      scope: scopeA, runId: "run_w1_1", taskId: "task_exec_1",
      assembly: { ...goodAssembly, methods: [{ objectType: "skill", objectId: skill.skill_id, versionId: sv.version_id, versionPolicy: "pinned" }] }, actor: "system",
    }),
    "AGENT_SPACE_ARGUMENT_INVALID",
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
  const lessonAuth = await authz(scopeA, "um_w1_lesson", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: lesson.versionId, extraBinding: { kind: "lesson" } });
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: lessonAuth, actor: "user:a" });
  const effective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(effective.length, 1);
  assert.equal(effective[0]!.ownerId, "conv_w1");

  const rev = space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { trigger: "实时数据任务", guidance: "修订后指引" }, actor: "user:a" });
  const stillEffective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(stillEffective[0]!.versionId, lesson.versionId, "revision does not deactivate the approved version");
  const staleAuth = await authz(scopeA, "um_w1_lesson2", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: lesson.versionId, extraBinding: { kind: "lesson" } });
  expectAgentSpaceError(
    () => space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: staleAuth, actor: "user:a" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: rev.versionId, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_lesson2", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: rev.versionId, extraBinding: { kind: "lesson" } }), actor: "user:a" });
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
  space.approveStateCandidate({ scope: scopeA, kind: "workflow", objectId: wf.objectId, expectedVersionId: wf.versionId, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_wf", { operation: "state.approve", objectType: "agent_space_workflow", objectId: wf.objectId, versionId: wf.versionId, extraBinding: { kind: "workflow" } }), actor: "user:a" });
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
  const cmtAuth = await authz(scopeA, "um_w1_c", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_exec_1" } });
  const missingExecAuth = await authz(scopeA, "um_w1_c", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_missing" } });
  expectAgentSpaceError(
    () => space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: missingExecAuth, executorTaskId: "task_missing", actor: "user:a" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: cmtAuth, executorTaskId: "task_exec_1", actor: "user:a" });

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
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: await authz(scopeA, "um_w1_c_resume", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_exec_1" } }), executorTaskId: "task_exec_1", actor: "user:a" });
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

test("R6: message existence is not authorization — source role/status and target binding enforced", async () => {
  const space: Space = await getSpace();
  const method = space.createMethod({ scope: scopeA, name: "授权语义方法", actor: "user:a" });
  const v = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  // assistant 消息 / failed 用户消息不能作为授权来源
  expectAgentSpaceError(
    () => space.registerUserAuthorization({
      scope: scopeA, subjectUser: scopeA.userId, operation: "method.version.approve",
      objectType: "agent_space_method_version", objectId: v.version_id, versionId: v.version_id,
      sourceMessageId: "um_w1_asst", actor: "runtime-confirmation",
    }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.registerUserAuthorization({
      scope: scopeA, subjectUser: scopeA.userId, operation: "method.version.approve",
      objectType: "agent_space_method_version", objectId: v.version_id, versionId: v.version_id,
      sourceMessageId: "um_w1_failed", actor: "runtime-confirmation",
    }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  // 跨 scope 消息不能作为来源
  expectAgentSpaceError(
    () => space.registerUserAuthorization({
      scope: scopeB, subjectUser: scopeB.userId, operation: "method.version.approve",
      objectType: "agent_space_method_version", objectId: v.version_id, versionId: v.version_id,
      sourceMessageId: "um_w1_1", actor: "runtime-confirmation",
    }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  // 合法授权：登记后批准成功；同绑定重放幂等
  const { authorizationId } = space.registerUserAuthorization({
    scope: scopeA, subjectUser: scopeA.userId, operation: "method.version.approve",
    objectType: "agent_space_method_version", objectId: v.version_id, versionId: v.version_id,
    extraBinding: { methodId: method.method_id, adopt: "true" },
    sourceMessageId: "um_w1_1", actor: "runtime-confirmation",
  });
  const approved = space.approveMethodVersion({
    scope: scopeA, methodId: method.method_id, versionId: v.version_id,
    approvedBy: "user:a", approvalRef: `authorization:${authorizationId}`, actor: "user:a",
  });
  assert.equal(approved.version.status, "approved");
  // 同一授权跨对象/动作/版本重放全部拒绝
  const method2 = space.createMethod({ scope: scopeA, name: "授权语义方法2", actor: "user:a" });
  const v2m2 = space.addMethodVersion({ scope: scopeA, methodId: method2.method_id, contentRef: CONTENT_A, actor: "user:a" });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method2.method_id, versionId: v2m2.version_id, approvedBy: "user:a", approvalRef: `authorization:${authorizationId}`, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  expectAgentSpaceError(
    () => space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: "skill_x", versionId: v.version_id, approvedBy: "user:a", approvalRef: `authorization:${authorizationId}`, actor: "user:a" }),
    "AGENT_SPACE_NOT_FOUND",
  );
});

test("R7: initial-draft revision replaces the pointer; old confirmation invalidated; pending revision discardable", async () => {
  const space: Space = await getSpace();
  // 首次草稿：v1 → 修订 v2 替换 current；批准 v2 成功；旧确认(v1)失效
  const lesson = space.createStateCandidate({
    scope: scopeA, kind: "lesson", title: "初始草稿指针",
    content: { trigger: "t", guidance: "v1" },
    ownerKind: "conversation", ownerId: "conv_w1", actor: "agent",
  });
  const oldAuth = await authz(scopeA, "um_w1_1", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: lesson.versionId, extraBinding: { kind: "lesson" } });
  const rev = space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { trigger: "t", guidance: "v2" }, actor: "user:a" });
  expectAgentSpaceError(
    () => space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: oldAuth, actor: "user:a" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: rev.versionId, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_2", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: rev.versionId, extraBinding: { kind: "lesson" } }), actor: "user:a" });
  const effective = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(effective[0]!.versionId, rev.versionId);
  assert.equal(effective[0]!.content.guidance, "v2");

  // active 修订：待批准指针 + 撤销修订不影响有效版本与对象状态
  const rev2 = space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { trigger: "t", guidance: "v3" }, actor: "user:a" });
  assert.equal(space.listEffectiveState({ scope: scopeA, kind: "lesson" })[0]!.versionId, rev.versionId, "pending revision keeps v2 effective");
  // 连续第二次修订拒绝（已有待批准）
  expectAgentSpaceError(
    () => space.reviseStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, content: { trigger: "t", guidance: "v4" }, actor: "user:a" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  space.discardStateRevision({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, reason: "用户拒绝修订", actor: "user:a" });
  const afterDiscard = space.listEffectiveState({ scope: scopeA, kind: "lesson" });
  assert.equal(afterDiscard[0]!.versionId, rev.versionId, "discarded revision does not touch the effective version");
  const { db } = await fixture;
  const row = db.sqlite.prepare("SELECT status, current_version_id, draft_version_id FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { status: string; current_version_id: string; draft_version_id: string | null };
  assert.equal(row.status, "active", "rejecting a revision does not disable the object");
  assert.equal(row.draft_version_id, null);
  // 无待批准时 discard 拒绝
  expectAgentSpaceError(
    () => space.discardStateRevision({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, actor: "user:a" }),
    "AGENT_SPACE_INVALID_TRANSITION",
  );
  void rev2;
});

test("R8: snapshots reject draft/null/fabricated/category-mismatch/hold-bypass entries and stamp checksums server-side", async () => {
  const space: Space = await getSpace();
  const agent = space.createAgent({ scope: scopeA, name: "R8助手", actor: "user:a" });
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "r8-skill", name: "R8技能", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv.version_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  const holdMethod = space.createMethod({ scope: scopeA, name: "R8-hold方法", actor: "user:a" });
  const holdV = space.addMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, contentRef: CONTENT_A, adoptionConstraints: ["hold-ambiguity"], actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, versionId: holdV.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/r8-hold", ownerToken: OWNER_TOKEN, adopt: false, actor: "owner" });

  const base = {
    agent: { agentId: agent.agent_id },
    skills: [{ objectType: "skill", objectId: skill.skill_id, versionId: sv.version_id, versionPolicy: "pinned", contentChecksum: "chk_a1" }],
    methods: [],
    assets: [],
    agentState: [],
  };
  // hold 约束版本不能借快照 pin 绕过默认采用路径
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_2", taskId: "task_exec_1", assembly: { ...base, methods: [{ objectType: "method", objectId: holdMethod.method_id, versionId: holdV.version_id, versionPolicy: "pinned" }] }, actor: "system" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );
  // 正常装配：服务端盖章 checksum（调用方省略 checksum 也可，落库为真实值）
  const snap = space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_2", taskId: "task_exec_1", agentId: agent.agent_id, assembly: { ...base, skills: [{ objectType: "skill", objectId: skill.skill_id, versionId: sv.version_id, versionPolicy: "pinned" }] }, actor: "system" });
  assert.ok(snap.assemblyHash.length === 64);
  const read = space.getTaskRunSnapshot(scopeA, "run_w1_2");
  assert.equal(read.assembly.skills[0].contentChecksum, "chk_a1", "server stamped the real checksum");
  // 同 run 不同装配仍冲突
  expectAgentSpaceError(
    () => space.recordTaskRunSnapshot({ scope: scopeA, runId: "run_w1_2", taskId: "task_exec_1", assembly: { ...base, skills: [] }, actor: "system" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
});

test("R9: authorization consumption is atomic with the business mutation; retry after rollback succeeds", async () => {
  const { db, space } = await fixture;
  const lesson = space.createStateCandidate({
    scope: scopeA, kind: "lesson", title: "授权事务",
    content: { trigger: "t", guidance: "v1" },
    ownerKind: "conversation", ownerId: "conv_w1", actor: "agent",
  });
  const authRef = await authz(scopeA, "um_w1_lesson", { operation: "state.approve", objectType: "agent_space_lesson", objectId: lesson.objectId, versionId: lesson.versionId, extraBinding: { kind: "lesson" } });
  const authzId = authRef.slice("authorization:".length);

  // 注入：lesson.approved 审计失败 → 整体回滚
  db.sqlite.exec(`
    CREATE TRIGGER w1_fail_lesson_approve_audit
    BEFORE INSERT ON agent_space_audit_logs
    WHEN NEW.action = 'lesson.approved'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
  `);
  let threw = false;
  try {
    space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  } catch {
    threw = true;
  }
  assert.ok(threw, "audit failure surfaces");
  // 回滚后：对象仍是 draft、凭证未被消耗、无半成品审计
  const lessonRow = db.sqlite.prepare("SELECT status FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { status: string };
  assert.equal(lessonRow.status, "draft", "business change rolled back");
  const authzRow = db.sqlite.prepare("SELECT status, consumed_at FROM agent_space_authorizations WHERE authorization_id=?").get(authzId) as { status: string; consumed_at: string | null };
  assert.equal(authzRow.status, "active", "authorization consumption rolled back with the business mutation");
  assert.equal(authzRow.consumed_at, null);
  const halfAudit = db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='lesson.approved' AND object_id=?").get(lesson.objectId) as { n: number };
  assert.equal(halfAudit.n, 0);

  // 移除故障后重试：同一凭证完整成功
  db.sqlite.exec("DROP TRIGGER w1_fail_lesson_approve_audit");
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  const after = db.sqlite.prepare("SELECT status FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { status: string };
  assert.equal(after.status, "active", "retry completes the full business path");
  const consumed = db.sqlite.prepare("SELECT status FROM agent_space_authorizations WHERE authorization_id=?").get(authzId) as { status: string };
  assert.equal(consumed.status, "consumed");

  // 成功后同请求重放（R9②）：返回原结果且零副作用——不重复审计、不重复转换
  const rowBefore = db.sqlite.prepare("SELECT status, current_version_id, draft_version_id, approved_at FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as Record<string, unknown>;
  const auditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='lesson.approved' AND object_id=?").get(lesson.objectId) as { n: number }).n;
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  const rowAfter = db.sqlite.prepare("SELECT status, current_version_id, draft_version_id, approved_at FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as Record<string, unknown>;
  assert.deepEqual(rowAfter, rowBefore, "replay leaves the lesson row byte-identical");
  const auditsAfter = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='lesson.approved' AND object_id=?").get(lesson.objectId) as { n: number }).n;
  assert.equal(auditsAfter, auditsBefore, "replay adds no audit rows");
  // 合法回放不得恢复后来被停用的对象：disable 后重放仍是 void 成功且状态不变
  space.transitionStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, toStatus: "disabled", reason: "later disabled", actor: "user:a" });
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  const disabled = db.sqlite.prepare("SELECT status FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { status: string };
  assert.equal(disabled.status, "disabled", "replay must not resurrect a later-disabled object");
});

test("R9: revoked authorization is rejected; method approve replay returns the recorded outcome", async () => {
  const { db, space } = await fixture;
  const method = space.createMethod({ scope: scopeA, name: "R9方法", actor: "user:a" });
  const v = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  const authRef = await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v.version_id, versionId: v.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v.version_id, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  // 成功后重放（R9②）：返回既有结果，行数与审计零变化
  const versionsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_method_versions WHERE method_id=?").get(method.method_id) as { n: number }).n;
  const auditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v.version_id) as { n: number }).n;
  const replay = space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v.version_id, approvedBy: "user:a", approvalRef: authRef, actor: "user:a" });
  assert.equal(replay.version.version_id, v.version_id);
  assert.equal(replay.version.status, "approved");
  const versionsAfter = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_method_versions WHERE method_id=?").get(method.method_id) as { n: number }).n;
  assert.equal(versionsAfter, versionsBefore, "replay creates no version rows");
  const auditsAfter = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v.version_id) as { n: number }).n;
  assert.equal(auditsAfter, auditsBefore, "replay adds no audit rows");
  // revoked 凭证拒绝（用新 draft 版本使业务路径放行、直达凭证层）
  const method3 = space.createMethod({ scope: scopeA, name: "R9-revoked方法", actor: "user:a" });
  const v3 = space.addMethodVersion({ scope: scopeA, methodId: method3.method_id, contentRef: CONTENT_A, actor: "user:a" });
  const revokedRef = await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v3.version_id, versionId: v3.version_id, extraBinding: { methodId: method3.method_id, adopt: "true" } });
  db.sqlite.prepare("UPDATE agent_space_authorizations SET status='revoked' WHERE authorization_id=?").run(revokedRef.slice("authorization:".length));
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method3.method_id, versionId: v3.version_id, approvedBy: "user:a", approvalRef: revokedRef, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  // revoked 凭证即使绑定匹配也不能回放成功路径（已成功消耗后被撤销）
  const method4 = space.createMethod({ scope: scopeA, name: "R9-revoked-replay方法", actor: "user:a" });
  const v4 = space.addMethodVersion({ scope: scopeA, methodId: method4.method_id, contentRef: CONTENT_A, actor: "user:a" });
  const revokedReplayRef = await authz(scopeA, "um_w1_m", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v4.version_id, versionId: v4.version_id, extraBinding: { methodId: method4.method_id, adopt: "true" } });
  space.approveMethodVersion({ scope: scopeA, methodId: method4.method_id, versionId: v4.version_id, approvedBy: "user:a", approvalRef: revokedReplayRef, actor: "user:a" });
  db.sqlite.prepare("UPDATE agent_space_authorizations SET status='revoked' WHERE authorization_id=?").run(revokedReplayRef.slice("authorization:".length));
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method4.method_id, versionId: v4.version_id, approvedBy: "user:a", approvalRef: revokedReplayRef, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
});

test("R9: install/approve/activate replays return recorded outcomes with zero side effects", async () => {
  const { db, space } = await fixture;
  const agent = space.createAgent({ scope: scopeA, name: "回放矩阵助手", actor: "user:a" });
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "replay-skill", name: "回放技能", actor: "user:a" });
  const sv1 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  const skillAuth1 = await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv1.version_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id } });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: skillAuth1, actor: "user:a" });

  const countInstalls = () =>
    (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agent.agent_id) as { n: number }).n;
  const countInstallAudits = () =>
    (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_type='agent_space_agent_skill_installation' AND user_id=?").get(scopeA.userId) as { n: number }).n;

  // —— 安装：成功后立即重放 → 返回同一安装行，零新增 ——
  const installAuth1 = await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } });
  const inst1 = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:a", approvalRef: installAuth1, actor: "user:a" });
  const installsBefore = countInstalls();
  const installAuditsBefore = countInstallAudits();
  const inst1Replay = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:a", approvalRef: installAuth1, actor: "user:a" });
  assert.equal(inst1Replay.installation_id, inst1.installation_id, "install replay returns the original installation row");
  assert.equal(countInstalls(), installsBefore, "install replay inserts nothing");
  assert.equal(countInstallAudits(), installAuditsBefore, "install replay adds no audit");

  // —— 升级到 v2 后重放 v1 安装 → 返回已 superseded 的原安装行，不把当前安装降级 ——
  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  const skillAuth2 = await authz(scopeA, "um_w1_s2", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv2.version_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id } });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: skillAuth2, actor: "user:a" });
  const installAuth2 = await authz(scopeA, "um_w1_upgrade", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: installAuth2, actor: "user:a" });
  const installsAfterUpgrade = countInstalls();
  const oldReplay = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:a", approvalRef: installAuth1, actor: "user:a" });
  assert.equal(oldReplay.installation_id, inst1.installation_id, "old-install replay returns the original row");
  assert.equal(oldReplay.status, "superseded", "replayed installation reflects its later superseded state");
  assert.equal(space.listInstalledSkills(scopeA, agent.agent_id)[0]!.version_id, sv2.version_id, "replay must not downgrade the current install");
  assert.equal(countInstalls(), installsAfterUpgrade, "old-install replay inserts nothing");

  // —— 技能批准重放 → 既有版本行，审计零新增 ——
  const skillAuditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(sv2.version_id) as { n: number }).n;
  const sv2Replay = space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: skillAuth2, actor: "user:a" });
  assert.equal(sv2Replay.version_id, sv2.version_id);
  assert.equal(sv2Replay.status, "approved");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(sv2.version_id) as { n: number }).n, skillAuditsBefore, "skill approve replay adds no audit");

  // —— owner-decision 安装回放（业务行 approval_ref 兜底）→ 同一安装行 ——
  const odInst = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "owner", approvalRef: "owner-decision:2026-09-20/od-install", ownerToken: OWNER_TOKEN, actor: "owner" });
  const odCount = countInstalls();
  const odReplay = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "owner", approvalRef: "owner-decision:2026-09-20/od-install", ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal(odReplay.installation_id, odInst.installation_id, "owner-decision install replay returns the existing row");
  assert.equal(countInstalls(), odCount, "owner-decision install replay inserts nothing");
  // 同一 owner-decision 依据换安装目标拒绝
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "owner", approvalRef: "owner-decision:2026-09-20/od-install", ownerToken: OWNER_TOKEN, actor: "owner" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );

  // —— 撤销后的安装凭证：重放拒绝 ——
  db.sqlite.prepare("UPDATE agent_space_authorizations SET status='revoked' WHERE authorization_id=?").run(installAuth1.slice("authorization:".length));
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:a", approvalRef: installAuth1, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );

  // —— 承诺激活：成功后重放零副作用；后来 paused 不被回放恢复 ——
  const commitment = space.createCommitment({ scope: scopeA, title: "回放承诺", content: {}, commitmentKind: "one_shot", completionCriteria: "推送成功", idempotencyKey: "replay-cmt", actor: "user:a" });
  const actAuth = await authz(scopeA, "um_w1_c", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_exec_1" } });
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: actAuth, executorTaskId: "task_exec_1", actor: "user:a" });
  const actAuditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='commitment.activated' AND object_id=?").get(commitment.commitmentId) as { n: number }).n;
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: actAuth, executorTaskId: "task_exec_1", actor: "user:a" });
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='commitment.activated' AND object_id=?").get(commitment.commitmentId) as { n: number }).n, actAuditsBefore, "activation replay adds no audit");
  space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "paused", reason: "假期", actor: "user:a" });
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: actAuth, executorTaskId: "task_exec_1", actor: "user:a" });
  const pausedRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(pausedRow.status, "paused", "activation replay must not resurrect a later-paused commitment");

  // —— owner-decision 方法批准回放（业务行 approval_ref 兜底）——
  const odm = space.createMethod({ scope: scopeA, name: "owner回放方法", actor: "owner" });
  const odv = space.addMethodVersion({ scope: scopeA, methodId: odm.method_id, contentRef: CONTENT_A, actor: "owner" });
  space.approveMethodVersion({ scope: scopeA, methodId: odm.method_id, versionId: odv.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/od-approve", ownerToken: OWNER_TOKEN, actor: "owner" });
  const odAuditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(odv.version_id) as { n: number }).n;
  const odReplayResult = space.approveMethodVersion({ scope: scopeA, methodId: odm.method_id, versionId: odv.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/od-approve", ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal(odReplayResult.version.status, "approved");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(odv.version_id) as { n: number }).n, odAuditsBefore, "owner-decision approve replay adds no audit");

  // —— 消费后业务校验失败（hold 约束挡采用）→ 凭证随事务回滚、不失耗 ——
  const holdMethod = space.createMethod({ scope: scopeA, name: "回放hold方法", actor: "user:a" });
  const holdV = space.addMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, contentRef: CONTENT_A, adoptionConstraints: ["hold-ambiguity"], actor: "user:a" });
  const holdAuth = await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: holdV.version_id, versionId: holdV.version_id, extraBinding: { methodId: holdMethod.method_id, adopt: "true" } });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: holdMethod.method_id, versionId: holdV.version_id, approvedBy: "user:a", approvalRef: holdAuth, actor: "user:a" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );
  const holdAuthRow = db.sqlite.prepare("SELECT status FROM agent_space_authorizations WHERE authorization_id=?").get(holdAuth.slice("authorization:".length)) as { status: string };
  assert.equal(holdAuthRow.status, "active", "post-consumption business failure must roll the consumption back");
});

test("R9: extraBinding full-key comparison, canonical dedupe, subject validation, registration atomicity", async () => {
  const { db, space } = await fixture;

  // 键序无关：登记 {b,a}，核验 {a,b} → 完整键集合匹配放行
  const reg = space.registerUserAuthorization({
    scope: scopeA, subjectUser: scopeA.userId, operation: "test.op",
    objectType: "test.obj", objectId: "r9-bind-1", versionId: null,
    extraBinding: { b: "2", a: "1" }, sourceMessageId: "um_w1_snap", actor: "runtime-confirmation",
  });
  const verified = space.verifyAuthorization(
    scopeA,
    { operation: "test.op", objectType: "test.obj", objectId: "r9-bind-1", versionId: null, extraBinding: { a: "1", b: "2" } },
    `authorization:${reg.authorizationId}`,
  );
  assert.equal(verified.replayed, false);

  // canonical 去重：同绑定换键序再登记 → duplicated 且同 id
  const dup = space.registerUserAuthorization({
    scope: scopeA, subjectUser: scopeA.userId, operation: "test.op",
    objectType: "test.obj", objectId: "r9-bind-1", versionId: null,
    extraBinding: { a: "1", b: "2" }, sourceMessageId: "um_w1_snap", actor: "runtime-confirmation",
  });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.authorizationId, reg.authorizationId);

  // 缺键 / 多键 / 改值全部拒绝（不能只比对调用方提供的子集）
  const reg2 = space.registerUserAuthorization({
    scope: scopeA, subjectUser: scopeA.userId, operation: "test.op",
    objectType: "test.obj", objectId: "r9-bind-2", versionId: null,
    extraBinding: { a: "1", b: "2" }, sourceMessageId: "um_w1_1", actor: "runtime-confirmation",
  });
  const reg2Ref = `authorization:${reg2.authorizationId}`;
  const reg2Binding = { operation: "test.op", objectType: "test.obj", objectId: "r9-bind-2", versionId: null };
  expectAgentSpaceError(() => space.verifyAuthorization(scopeA, { ...reg2Binding, extraBinding: { a: "1" } }, reg2Ref), "AGENT_SPACE_APPROVAL_REQUIRED");
  expectAgentSpaceError(() => space.verifyAuthorization(scopeA, { ...reg2Binding, extraBinding: { a: "1", b: "2", c: "3" } }, reg2Ref), "AGENT_SPACE_APPROVAL_REQUIRED");
  expectAgentSpaceError(() => space.verifyAuthorization(scopeA, { ...reg2Binding, extraBinding: { a: "1", b: "changed" } }, reg2Ref), "AGENT_SPACE_APPROVAL_REQUIRED");
  const intact = db.sqlite.prepare("SELECT status FROM agent_space_authorizations WHERE authorization_id=?").get(reg2.authorizationId) as { status: string };
  assert.equal(intact.status, "active", "rejected mismatches must not consume the credential");

  // 冒名主体拒绝：subjectUser 与 scope 本人不一致
  expectAgentSpaceError(
    () => space.registerUserAuthorization({
      scope: scopeA, subjectUser: "user:impersonator", operation: "test.op",
      objectType: "test.obj", objectId: "r9-bind-3", versionId: null,
      sourceMessageId: "um_w1_2", actor: "runtime-confirmation",
    }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  const impersonated = db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_authorizations WHERE object_id='r9-bind-3'").get() as { n: number };
  assert.equal(impersonated.n, 0, "impersonated registration leaves no credential row");

  // 登记审计失败 → 无凭证残留；修复后登记成功
  db.sqlite.exec(`
    CREATE TRIGGER w1_fail_authz_register_audit
    BEFORE INSERT ON agent_space_audit_logs
    WHEN NEW.action = 'authorization.registered'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;
  `);
  let registerThrew = false;
  try {
    space.registerUserAuthorization({
      scope: scopeA, subjectUser: scopeA.userId, operation: "test.op",
      objectType: "test.obj", objectId: "r9-bind-4", versionId: null,
      sourceMessageId: "um_w1_c_resume", actor: "runtime-confirmation",
    });
  } catch {
    registerThrew = true;
  }
  assert.ok(registerThrew, "registration audit failure surfaces");
  const residue = db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_authorizations WHERE object_id='r9-bind-4'").get() as { n: number };
  assert.equal(residue.n, 0, "failed registration leaves no credential residue");
  db.sqlite.exec("DROP TRIGGER w1_fail_authz_register_audit");
  const recovered = space.registerUserAuthorization({
    scope: scopeA, subjectUser: scopeA.userId, operation: "test.op",
    objectType: "test.obj", objectId: "r9-bind-4", versionId: null,
    sourceMessageId: "um_w1_c_resume", actor: "runtime-confirmation",
  });
  assert.ok(recovered.authorizationId);
});

test("R9: owner-decision channel keeps stable operation records; replays never resurrect or re-execute", async () => {
  const { db, space } = await fixture;

  // —— owner 本轮反例：owner 激活承诺 → 暂停 → 重放原激活请求 ——
  // 稳定操作记录（source_kind='owner_decision' + result_json）保证回放返回
  // 原结果，不依赖可变业务行，也不借 paused 这类合法再转换路径复活。
  const commitment = space.createCommitment({ scope: scopeA, title: "owner回放承诺", content: {}, commitmentKind: "one_shot", completionCriteria: "推送成功", idempotencyKey: "owner-replay-cmt", actor: "user:a" });
  const odRef = "owner-decision:2026-09-20/od-activate";
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: odRef, executorTaskId: "task_exec_1", ownerToken: OWNER_TOKEN, actor: "owner" });
  space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "paused", reason: "假期", actor: "user:a" });
  const actAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='commitment.activated' AND object_id=?").get(commitment.commitmentId) as { n: number }).n;
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: odRef, executorTaskId: "task_exec_1", ownerToken: OWNER_TOKEN, actor: "owner" });
  const pausedRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(pausedRow.status, "paused", "owner activation replay must not resurrect a paused commitment");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='commitment.activated' AND object_id=?").get(commitment.commitmentId) as { n: number }).n, actAudits, "owner activation replay adds no audit");
  const odRecord = db.sqlite.prepare("SELECT status, result_json FROM agent_space_authorizations WHERE source_kind='owner_decision' AND source_ref=?").get(odRef) as { status: string; result_json: string };
  assert.equal(odRecord.status, "consumed");
  assert.ok(odRecord.result_json, "owner decision record carries the stable outcome");
  // 同 ref 换执行器 → 绑定不匹配拒绝（一个 ref 只命名一个操作）
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at)
                     VALUES ('task_exec_2',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  expectAgentSpaceError(
    () => space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: odRef, executorTaskId: "task_exec_2", ownerToken: OWNER_TOKEN, actor: "owner" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );

  // —— owner 方法批准（adopt 入绑定）：adopt=false 批准后回放返回原结果；
  //    同 ref 换 adopt=true 拒绝 ——
  const method = space.createMethod({ scope: scopeA, name: "owner-adopt方法", actor: "owner" });
  const v1 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "owner" });
  const approveRef = "owner-decision:2026-09-20/od-adopt-false";
  const approvedFalse = space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "owner", approvalRef: approveRef, ownerToken: OWNER_TOKEN, adopt: false, actor: "owner" });
  assert.equal(approvedFalse.method.current_version_id, null, "adopt=false leaves current unset");
  const mAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v1.version_id) as { n: number }).n;
  const replayFalse = space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "owner", approvalRef: approveRef, ownerToken: OWNER_TOKEN, adopt: false, actor: "owner" });
  assert.equal(replayFalse.version.status, "approved");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(v1.version_id) as { n: number }).n, mAudits, "owner approve replay adds no audit");
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "owner", approvalRef: approveRef, ownerToken: OWNER_TOKEN, adopt: true, actor: "owner" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
  // 普通凭证同样：登记 adopt=true，换 adopt=false 调用拒绝
  const v2 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_A, actor: "user:a" });
  const adoptAuth = await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v2.version_id, versionId: v2.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } });
  expectAgentSpaceError(
    () => space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "user:a", approvalRef: adoptAuth, adopt: false, actor: "user:a" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );

  // —— owner 技能批准回放 → 既有版本行，零新增 ——
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "owner-replay-skill", name: "owner回放技能", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_a1", assetVersionId: "ver_a1", contentChecksum: "chk_a1" },
    origin: "private_edit", actor: "user:a",
  });
  const svApproveRef = "owner-decision:2026-09-20/od-skill-approve";
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "owner", approvalRef: svApproveRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  const svAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(sv.version_id) as { n: number }).n;
  const svReplay = space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "owner", approvalRef: svApproveRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal(svReplay.status, "approved");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE object_id=?").get(sv.version_id) as { n: number }).n, svAudits, "owner skill approve replay adds no audit");

  // —— owner 状态批准回放：void 零变化；后来 disabled 不被复活 ——
  const lesson = space.createStateCandidate({ scope: scopeA, kind: "lesson", title: "owner回放lesson", content: { trigger: "t", guidance: "g" }, ownerKind: "conversation", ownerId: "conv_w1", actor: "agent" });
  const lessonRef = "owner-decision:2026-09-20/od-lesson";
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "owner", approvalRef: lessonRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  const lessonAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='lesson.approved' AND object_id=?").get(lesson.objectId) as { n: number }).n;
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "owner", approvalRef: lessonRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='lesson.approved' AND object_id=?").get(lesson.objectId) as { n: number }).n, lessonAudits, "owner state approve replay adds no audit");
  space.transitionStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, toStatus: "disabled", reason: "later disabled", actor: "user:a" });
  space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: lesson.objectId, expectedVersionId: lesson.versionId, approvedBy: "owner", approvalRef: lessonRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal((db.sqlite.prepare("SELECT status FROM agent_space_lessons WHERE lesson_id=?").get(lesson.objectId) as { status: string }).status, "disabled", "owner replay must not resurrect a disabled lesson");

  // —— owner release 安装回放（releaseId 入绑定）：同一 ref 换 release 拒绝 ——
  const agent = space.createAgent({ scope: scopeA, name: "owner回放安装助手", actor: "user:a" });
  const rel1 = space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "owner", ownerToken: OWNER_TOKEN, actor: "owner" });
  const rel2 = space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, releaseVersion: "1.0.1", visibility: "public", publishedBy: "owner", ownerToken: OWNER_TOKEN, actor: "owner" });
  const installRef = "owner-decision:2026-09-20/od-release-install";
  const inst = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "release", releaseId: rel1.releaseId, versionId: sv.version_id, installedBy: "owner", approvalRef: installRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  const instCount = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agent.agent_id) as { n: number }).n;
  const instReplay = space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "release", releaseId: rel1.releaseId, versionId: sv.version_id, installedBy: "owner", approvalRef: installRef, ownerToken: OWNER_TOKEN, actor: "owner" });
  assert.equal(instReplay.installation_id, inst.installation_id, "owner release install replay returns the original row");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agent.agent_id) as { n: number }).n, instCount, "owner release install replay inserts nothing");
  expectAgentSpaceError(
    () => space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "release", releaseId: rel2.releaseId, versionId: sv.version_id, installedBy: "owner", approvalRef: installRef, ownerToken: OWNER_TOKEN, actor: "owner" }),
    "AGENT_SPACE_APPROVAL_REQUIRED",
  );
});

test("W2: method paths — pinned byte reads, readopt rollback, small-change formal versions, drafts outside formal history", async () => {
  const { db, space } = await fixture;
  const method = space.createMethod({ scope: scopeA, name: "量价W2", actor: "user:a" });

  // 草稿不进入正式历史
  const v1 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  assert.equal(space.getMethodVersionHistory(scopeA, method.method_id).length, 0, "draft versions stay out of formal history");

  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v1.version_id, versionId: v1.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  const v1Read = await space.readMethodVersionContent(scopeA, v1.version_id);
  assert.ok(v1Read.bytes.equals(W2_BODY_V1), "pinned read returns the exact canonical bytes");

  // 小改动也形成正式版本：v2 采为 current，v1 转 superseded 仍可固定读取
  const v2 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_2, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_2", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v2.version_id, versionId: v2.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id).version.version_id, v2.version_id);
  const v1After = await space.readMethodVersionContent(scopeA, v1.version_id);
  assert.ok(v1After.bytes.equals(W2_BODY_V1) && v1After.version.status === "superseded", "superseded versions stay reproducible byte-for-byte");

  // 同内容再成新正式版本：去重不吞版本，diff 报 identical 但两行独立可读
  const v3 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_2, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v3.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_m", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v3.version_id, versionId: v3.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  const diff = space.diffMethodVersions(scopeA, v2.version_id, v3.version_id);
  assert.equal(diff.identical, true, "same-content versions diff as identical");
  assert.notEqual(v2.version_id, v3.version_id);
  const history = space.getMethodVersionHistory(scopeA, method.method_id);
  assert.deepEqual(history.map((h) => h.versionId), [v3.version_id, v2.version_id, v1.version_id], "history lists the formal lineage");

  // 显式回退：re-adopt v1（授权与 R9 契约一致），旧 current 转 superseded
  const readoptRef = await authz(scopeA, "um_w1_snap", { operation: "method.readopt", objectType: "agent_space_method_version", objectId: v1.version_id, versionId: v1.version_id, extraBinding: { methodId: method.method_id } });
  const readopted = space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvalRef: readoptRef, actor: "user:a" });
  assert.equal(readopted.method.current_version_id, v1.version_id);
  assert.equal(readopted.version.status, "approved");
  assert.equal(space.resolveMethodVersion(scopeA, method.method_id).version.version_id, v1.version_id);
  const v3AfterReadopt = space.getMethodVersion(scopeA, v3.version_id);
  assert.equal(v3AfterReadopt.status, "superseded", "readopt demotes the previous current without deleting it");
  // 回退请求重放（R9）：返回原结果、零新增审计
  const readoptAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='method.version.readopted' AND object_id=?").get(v1.version_id) as { n: number }).n;
  const readoptReplay = space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvalRef: readoptRef, actor: "user:a" });
  assert.equal(readoptReplay.method.current_version_id, v1.version_id);
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='method.version.readopted' AND object_id=?").get(v1.version_id) as { n: number }).n, readoptAudits, "readopt replay adds no audit");
  // 已是 current 的版本再 readopt（换新凭证）→ 明确失败
  const readoptAgainRef = await authz(scopeA, "um_w1_lesson", { operation: "method.readopt", objectType: "agent_space_method_version", objectId: v1.version_id, versionId: v1.version_id, extraBinding: { methodId: method.method_id } });
  expectAgentSpaceError(
    () => space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvalRef: readoptAgainRef, actor: "user:a" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  // draft 版本不可 readopt
  const v4draft = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  expectAgentSpaceError(
    () => space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v4draft.version_id, approvalRef: "owner-decision:w2/readopt-draft", ownerToken: OWNER_TOKEN, actor: "owner" }),
    "AGENT_SPACE_VERSION_INVALID",
  );

  // hash 变化明确失败：篡改 v1 背书文件字节 → checksum 校验拒绝，恢复后可读
  const registry = await import("../src/mastra/workspace-registry.js");
  const entry = await registry.mastraWorkspaceRegistry.resolve(scopeA);
  const assetFile = path.join(entry!.projectRoot, "assets", "asset_w2", "versions", "ver_w2_1", "strategy.md");
  const { writeFileSync: wf, readFileSync: rf } = await import("node:fs");
  const original = rf(assetFile);
  wf(assetFile, Buffer.concat([original, Buffer.from("tampered")]));
  await assert.rejects(
    () => space.readMethodVersionContent(scopeA, v1.version_id),
    (error: unknown) => (error as { code?: string }).code === "ASSET_CHECKSUM_MISMATCH",
  );
  wf(assetFile, original);
  assert.ok((await space.readMethodVersionContent(scopeA, v1.version_id)).bytes.equals(W2_BODY_V1), "restored bytes read again");

  // 缺版本/缺文件明确失败
  expectAgentSpaceError(() => space.getMethodVersion(scopeA, "mver_missing"), "AGENT_SPACE_NOT_FOUND");
  await assert.rejects(
    () => space.readMethodVersionContent(scopeA, "mver_missing"),
    (error: unknown) => (error as { code?: string }).code === "AGENT_SPACE_NOT_FOUND",
  );

  // 默认发现只呈现方法与 current 版本，不含历史版本
  const listing = space.listUserMethods(scopeA);
  const mine = listing.find((m) => m.methodId === method.method_id)!;
  assert.equal(mine.currentVersionId, v1.version_id);
  assert.ok(!JSON.stringify(listing).includes(v2.version_id), "default discovery never surfaces historical version ids");

  // 运行可回指：快照固定 v2，读取快照后按 versionId 重现字节
  const agent = space.createAgent({ scope: scopeA, name: "W2运行助手", actor: "user:a" });
  const snap = space.recordTaskRunSnapshot({
    scope: scopeA, runId: "run_w1_3", taskId: "task_exec_1", agentId: agent.agent_id,
    assembly: {
      agent: { agentId: agent.agent_id },
      skills: [],
      methods: [{ objectType: "method", objectId: method.method_id, versionId: v2.version_id, versionPolicy: "pinned" }],
      assets: [], agentState: [],
    },
    actor: "system",
  });
  const readSnap = space.getTaskRunSnapshot(scopeA, "run_w1_3");
  const pinned = readSnap.assembly.methods.find((m) => m.objectId === method.method_id)!;
  assert.equal(pinned.versionId, v2.version_id);
  assert.ok((await space.readMethodVersionContent(scopeA, pinned.versionId!)).bytes.equals(W2_BODY_V2), "run-referenced version reproduces exact bytes");
  void snap;
});
