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
// W3：系统域技能内容引用走系统模板根。
process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.join(root, "templates");
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
// W3 系统模板：真实字节落模板根，checksum 由真实字节计算。
const SYS_TPL_BODY = Buffer.from("# 系统默认技能\n场景：盯盘提醒\n步骤：引用既有方法\n输出：简报\n失败处置：告警\n", "utf8");
const SYS_TPL_CHK = sha256Of(SYS_TPL_BODY);

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
  seed.prepare("UPDATE user_assets SET current_version_id='ver_w2_1' WHERE asset_id='asset_w2'").run();
  seed.prepare("UPDATE user_assets SET current_version_id='ver_a1' WHERE asset_id='asset_a1'").run();
  // W3：系统模板根落真实模板文件（系统域技能版本的 canonical 内容）。
  const tplDir = path.join(root, "templates", "sys-default-skill");
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(path.join(tplDir, "SKILL.md"), SYS_TPL_BODY);
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
  assert.equal(tables.length, 22);
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
  assert.equal(restored.n, 22, "structure replay recreates the domain (empty); real-data recovery uses verified backups per W1-delivery §6");
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

test("W3: catalog privacy, release immutability, default manifest, derivation, removal, runtime pinned resolution", async () => {
  const { db, space } = await fixture;

  // —— 目录隐私：private 不进市场枚举，跨用户详情 fail-closed ——
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "w3-skill", name: "W3技能", actor: "user:a" });
  const sv1 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv1.version_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  const privateRelease = space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0-private", visibility: "private", publishedBy: "user:a", actor: "user:a" });
  const publicRelease = space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a" });
  const catalog = space.listSkillCatalog();
  assert.ok(catalog.some((c) => c.releaseId === publicRelease.releaseId), "public release is listed");
  assert.ok(!catalog.some((c) => c.releaseId === privateRelease.releaseId), "private release never enters the catalog");
  expectAgentSpaceError(() => space.getReleaseDetailForInstaller(scopeB, privateRelease.releaseId), "AGENT_SPACE_VISIBILITY_INVALID");

  // —— 发布不可变：同 skill 重复 releaseVersion 明确冲突；私有后续版本不改发布行 ——
  expectAgentSpaceError(
    () => space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "user:a", actor: "user:a" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_2", contentChecksum: W2_CHK_2 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s2", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv2.version_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  const frozen = space.getReleaseDetailForInstaller(scopeA, publicRelease.releaseId);
  assert.equal(frozen.versionId, sv1.version_id, "release keeps pinning its frozen version after later private edits");
  assert.equal(frozen.contentChecksum, W2_CHK_1);
  // is_default 仅系统域可携带
  expectAgentSpaceError(
    () => space.publishSkillRelease({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, releaseVersion: "2.0.0", visibility: "public", publishedBy: "user:a", isDefault: true, actor: "user:a" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );

  // —— 默认清单：系统技能（模板内容）→ owner 批准 → public+default 发布 ——
  const sysSkill = space.upsertSkill({ domain: "system", scope: null, slug: "sys-default-brief", name: "默认简报", ownerToken: OWNER_TOKEN, actor: "owner" });
  const sysv = await space.addSkillVersion({
    domain: "system", scope: null, skillId: sysSkill.skill_id,
    contentRef: { contentRefType: "system_template", systemTemplatePath: "sys-default-skill/SKILL.md", contentChecksum: SYS_TPL_CHK },
    origin: "system_seed", ownerToken: OWNER_TOKEN, actor: "owner",
  });
  space.approveSkillVersion({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sysv.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w3-sys-approve", ownerToken: OWNER_TOKEN, actor: "owner" });
  const sysRel1 = space.publishSkillRelease({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sysv.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "owner", isDefault: true, ownerToken: OWNER_TOKEN, actor: "owner" });

  const agentD = space.createAgent({ scope: scopeA, name: "默认清单助手D", actor: "user:a" });
  const first = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentD.agent_id, actor: "system" });
  assert.equal(first.appliedInstallationIds.length, 1, "first apply seeds the default skill");
  const manifestD = space.getInstalledSkillManifest(scopeA, agentD.agent_id);
  assert.equal(manifestD[0]!.skillId, sysSkill.skill_id);
  assert.equal(manifestD[0]!.releaseId, sysRel1.releaseId);
  assert.equal(manifestD[0]!.source, "release");
  // 一次性初始化（返工 W3-R2）：重跑是纯 no-op（零写入零审计）
  const second = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentD.agent_id, actor: "system" });
  assert.equal(second.alreadyInitialized, true);
  assert.equal(second.appliedInstallationIds.length, 0);
  assert.equal(second.skippedSkillIds.length, 0);

  // 默认升级不改变存量安装：发布新默认 release，新 Agent 拿新版，老 Agent 原样
  const sysRel2 = space.publishSkillRelease({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sysv.version_id, releaseVersion: "1.1.0", visibility: "public", publishedBy: "owner", isDefault: true, ownerToken: OWNER_TOKEN, actor: "owner" });
  const agentE = space.createAgent({ scope: scopeA, name: "默认清单助手E", actor: "user:a" });
  space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentE.agent_id, actor: "system" });
  assert.equal(space.getInstalledSkillManifest(scopeA, agentE.agent_id)[0]!.releaseId, sysRel2.releaseId, "new agents get the new default release");
  space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentD.agent_id, actor: "system" });
  assert.equal(space.getInstalledSkillManifest(scopeA, agentD.agent_id)[0]!.releaseId, sysRel1.releaseId, "existing installs are never touched by default upgrades");

  // —— 移除：授权决定；移除后运行解析拒绝；重放零副作用；重装是新安装行 ——
  const removeRef = await authz(scopeA, "um_w1_install", { operation: "skill.remove", objectType: "agent_space_agent_skill_installation", objectId: agentD.agent_id, versionId: null, extraBinding: { skillId: sysSkill.skill_id } });
  const removed = space.removeInstalledSkill({ scope: scopeA, agentId: agentD.agent_id, skillId: sysSkill.skill_id, approvalRef: removeRef, actor: "user:a" });
  assert.equal(removed.status, "removed");
  await assert.rejects(() => space.resolveInstalledSkillContent(scopeA, agentD.agent_id, sysSkill.skill_id), /AGENT_SPACE_NOT_FOUND/, "removed skills never resolve at runtime");
  const removeAudits = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='agent.skill.removed'").get() as { n: number }).n;
  const removedReplay = space.removeInstalledSkill({ scope: scopeA, agentId: agentD.agent_id, skillId: sysSkill.skill_id, approvalRef: removeRef, actor: "user:a" });
  assert.equal(removedReplay.status, "removed");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='agent.skill.removed'").get() as { n: number }).n, removeAudits, "removal replay adds no audit");
  // 移除是显式决定：重跑默认清单不复活
  const afterRemove = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentD.agent_id, actor: "system" });
  assert.equal(afterRemove.appliedInstallationIds.length, 0, "removed default skills stay removed");
  // 重装：新凭证走 installSkill，产出新安装行
  const reinstallRef = await authz(scopeA, "um_w1_upgrade", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentD.agent_id, versionId: sysv.version_id, extraBinding: { skillId: sysSkill.skill_id, source: "release", releaseId: sysRel1.releaseId } });
  const reinstalled = space.installSkill({ scope: scopeA, agentId: agentD.agent_id, skillId: sysSkill.skill_id, source: "release", releaseId: sysRel1.releaseId, versionId: sysv.version_id, installedBy: "user:a", approvalRef: reinstallRef, actor: "user:a" });
  assert.equal(reinstalled.status, "installed");
  assert.notEqual(reinstalled.installation_id, removed.installationId, "reinstall creates a fresh installation row");

  // —— 派生：市场安装后的定制 = 私有派生，血缘可追溯；私有来源拒绝 ——
  const derived = await space.derivePrivateSkillFromRelease({
    scope: scopeB, releaseId: publicRelease.releaseId, slug: "derived-w3-skill", name: "派生W3技能",
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_b1", assetVersionId: "ver_b1", contentChecksum: "chk_b1" },
    actor: "user:b",
  });
  assert.equal(derived.skill.derived_from_release_id, publicRelease.releaseId, "derivation records its release lineage");
  assert.equal(derived.version.derived_from_version_id, sv1.version_id, "derivation records the source version");
  assert.equal(derived.version.status, "draft", "derived skill starts as the deriver's private draft");
  await assert.rejects(
    () => space.derivePrivateSkillFromRelease({
      scope: scopeB, releaseId: privateRelease.releaseId, slug: "derived-illegal", name: "越权派生",
      contentRef: { contentRefType: "user_asset_version", assetId: "asset_b1", assetVersionId: "ver_b1", contentChecksum: "chk_b1" },
      actor: "user:b",
    }),
    /AGENT_SPACE_VISIBILITY_INVALID/,
  );
  await assert.rejects(
    () => space.derivePrivateSkillFromRelease({
      scope: scopeB, releaseId: publicRelease.releaseId, slug: "derived-w3-skill", name: "slug冲突",
      contentRef: { contentRefType: "user_asset_version", assetId: "asset_b1", assetVersionId: "ver_b1", contentChecksum: "chk_b1" },
      actor: "user:b",
    }),
    /AGENT_SPACE_ARGUMENT_INVALID/,
  );

  // —— 运行时只返回已安装固定版本；越权/未安装拒绝 ——
  const agentR = space.createAgent({ scope: scopeA, name: "运行解析助手", actor: "user:a" });
  const runInstallRef = await authz(scopeA, "um_w1_c", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentR.agent_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } });
  space.installSkill({ scope: scopeA, agentId: agentR.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: runInstallRef, actor: "user:a" });
  // 私有继续升级到 v3 并批准：已安装 Agent 的运行解析仍钉住 v2
  const sv3 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv3.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s3", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv3.version_id, versionId: sv3.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  const resolved = await space.resolveInstalledSkillContent(scopeA, agentR.agent_id, skill.skill_id);
  assert.equal(resolved.versionId, sv2.version_id, "runtime resolves the installed fixed version, not the latest private edit");
  assert.ok(resolved.bytes.equals(W2_BODY_V2), "runtime bytes come from the pinned version");
  assert.equal(resolved.checksum, W2_CHK_2);
  await assert.rejects(() => space.resolveInstalledSkillContent(scopeA, agentR.agent_id, sysSkill.skill_id), /AGENT_SPACE_NOT_FOUND/, "uninstalled skills never resolve");
  await assert.rejects(() => space.resolveInstalledSkillContent(scopeB, agentR.agent_id, skill.skill_id), /AGENT_SPACE_SCOPE_MISMATCH/, "cross-scope agents never resolve");
  // 系统模板内容解析：字节数与模板一致
  const sysResolved = await space.resolveInstalledSkillContent(scopeA, agentE.agent_id, sysSkill.skill_id);
  assert.ok(sysResolved.bytes.equals(SYS_TPL_BODY), "system-template installs read verified template bytes");
});

test("W2-R1: readopt can never make history-only versions current (owner channel included)", async () => {
  const { db, space } = await fixture;
  const method = space.createMethod({ scope: scopeA, name: "readopt约束方法", actor: "user:a" });
  const v1 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: v1.version_id, versionId: v1.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  const v2 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_2, adoptionConstraints: ["historical-not-default"], actor: "user:a" });
  const v2Approved = space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w2r1-hist", ownerToken: OWNER_TOKEN, adopt: false, actor: "owner" });
  assert.equal(v2Approved.method.current_version_id, v1.version_id, "historical-not-default never becomes current at approval");

  // owner 通道 readopt 也拒绝：拒绝随事务回滚，current/版本状态/审计全不变
  const before = db.sqlite.prepare("SELECT current_version_id FROM agent_space_methods WHERE method_id=?").get(method.method_id) as { current_version_id: string };
  const readoptAuditsBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='method.version.readopted'").get() as { n: number }).n;
  expectAgentSpaceError(
    () => space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvalRef: "owner-decision:2026-09-20/w2r1-readopt", ownerToken: OWNER_TOKEN, actor: "owner" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );
  // 普通授权同样拒绝
  const normalRef = await authz(scopeA, "um_w1_2", { operation: "method.readopt", objectType: "agent_space_method_version", objectId: v2.version_id, versionId: v2.version_id, extraBinding: { methodId: method.method_id } });
  expectAgentSpaceError(
    () => space.readoptMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: v2.version_id, approvalRef: normalRef, actor: "user:a" }),
    "AGENT_SPACE_ADOPTION_CONSTRAINT",
  );
  const after = db.sqlite.prepare("SELECT current_version_id FROM agent_space_methods WHERE method_id=?").get(method.method_id) as { current_version_id: string };
  assert.equal(after.current_version_id, before.current_version_id, "rejected readopt leaves current untouched");
  assert.equal(space.getMethodVersion(scopeA, v2.version_id).status, "approved");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_audit_logs WHERE action='method.version.readopted'").get() as { n: number }).n, readoptAuditsBefore, "rejected readopt writes no audit");
  // history-only 仍可历史读取（不靠运行放行修复）
  const hist = await space.readMethodVersionContent(scopeA, v2.version_id);
  assert.ok(hist.bytes.equals(W2_BODY_V2), "history-only versions stay readable outside runtime adoption");
});

test("W3-R1: system-template bytes are preserved at publish; template updates/deletions never break installed versions", async () => {
  const { db, space } = await fixture;
  const { readFileSync, writeFileSync: wf, rmSync: rmf, mkdirSync: mkd } = await import("node:fs");
  const tplRoot = process.env.SYSTEM_SKILLS_TEMPLATE_ROOT!;
  const contentRoot = db.sqlite === db.sqlite ? (process.env.SYSTEM_SKILLS_CONTENT_ROOT || path.join(process.env.RUNTIME_DATA_ROOT!, "system-skill-content")) : "";
  const storePath = (chk: string) => path.join(contentRoot, chk);

  const mkTpl = (rel: string, body: Buffer) => {
    mkdirSync(path.join(tplRoot, path.dirname(rel)), { recursive: true });
    wf(path.join(tplRoot, rel), body);
  };
  const OLD = Buffer.from("# W3R1 old\n模板旧版内容\n", "utf8");
  const NEW = Buffer.from("# W3R1 new\n模板新版内容\n", "utf8");
  const CHK_OLD = sha256Of(OLD);
  const CHK_NEW = sha256Of(NEW);

  // 发布 v1（模板旧字节）→ 默认发布 → Agent 安装
  mkTpl("w3r1-skill/SKILL.md", OLD);
  const sysSkill = space.upsertSkill({ domain: "system", scope: null, slug: "w3r1-sys", name: "W3R1系统技能", ownerToken: OWNER_TOKEN, actor: "owner" });
  const sv1 = await space.addSkillVersion({ domain: "system", scope: null, skillId: sysSkill.skill_id, contentRef: { contentRefType: "system_template", systemTemplatePath: "w3r1-skill/SKILL.md", contentChecksum: CHK_OLD }, origin: "system_seed", ownerToken: OWNER_TOKEN, actor: "owner" });
  space.approveSkillVersion({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sv1.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w3r1-v1", ownerToken: OWNER_TOKEN, actor: "owner" });
  const rel1 = space.publishSkillRelease({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sv1.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "owner", isDefault: true, ownerToken: OWNER_TOKEN, actor: "owner" });
  const agentOld = space.createAgent({ scope: scopeA, name: "W3R1旧版助手", actor: "user:a" });
  space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentOld.agent_id, actor: "system" });
  assert.ok((await space.resolveInstalledSkillContent(scopeA, agentOld.agent_id, sysSkill.skill_id)).bytes.equals(OLD), "v1 install reads the published bytes");

  // 同路径模板改成新内容 → 发布 v2 → 新 Agent 安装
  mkTpl("w3r1-skill/SKILL.md", NEW);
  const sv2 = await space.addSkillVersion({ domain: "system", scope: null, skillId: sysSkill.skill_id, contentRef: { contentRefType: "system_template", systemTemplatePath: "w3r1-skill/SKILL.md", contentChecksum: CHK_NEW }, origin: "system_seed", ownerToken: OWNER_TOKEN, actor: "owner" });
  space.approveSkillVersion({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sv2.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w3r1-v2", ownerToken: OWNER_TOKEN, actor: "owner" });
  const rel2 = space.publishSkillRelease({ domain: "system", scope: null, skillId: sysSkill.skill_id, versionId: sv2.version_id, releaseVersion: "2.0.0", visibility: "public", publishedBy: "owner", ownerToken: OWNER_TOKEN, actor: "owner" });
  const agentNew = space.createAgent({ scope: scopeA, name: "W3R1新版助手", actor: "user:a" });
  const newInstallRef = await authz(scopeA, "um_w1_upgrade", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentNew.agent_id, versionId: sv2.version_id, extraBinding: { skillId: sysSkill.skill_id, source: "release", releaseId: rel2.releaseId } });
  space.installSkill({ scope: scopeA, agentId: agentNew.agent_id, skillId: sysSkill.skill_id, source: "release", releaseId: rel2.releaseId, versionId: sv2.version_id, installedBy: "user:a", approvalRef: newInstallRef, actor: "user:a" });

  // 删除模板原文件：新旧安装都仍按各自固定版本读旧/新字节（内容寻址存储）
  rmf(path.join(tplRoot, "w3r1-skill/SKILL.md"));
  assert.ok((await space.resolveInstalledSkillContent(scopeA, agentOld.agent_id, sysSkill.skill_id)).bytes.equals(OLD), "old install keeps reading the OLD bytes after the template changed");
  assert.ok((await space.resolveInstalledSkillContent(scopeA, agentNew.agent_id, sysSkill.skill_id)).bytes.equals(NEW), "new install reads the NEW bytes");

  // 存储篡改明确拒绝
  const storedOld = readFileSync(storePath(CHK_OLD));
  wf(storePath(CHK_OLD), Buffer.concat([storedOld, Buffer.from("tampered")]));
  await assert.rejects(
    () => space.resolveInstalledSkillContent(scopeA, agentOld.agent_id, sysSkill.skill_id),
    /AGENT_SPACE_VERSION_INVALID/,
    "tampered preserved bytes are rejected",
  );
  wf(storePath(CHK_OLD), storedOld);

  // 缺原字节明确阻塞：删掉 v2 存储文件（模板也已删除）→ 读取失败 + 回填报告 blocked
  rmf(storePath(CHK_NEW));
  await assert.rejects(
    () => space.resolveInstalledSkillContent(scopeA, agentNew.agent_id, sysSkill.skill_id),
    /AGENT_SPACE_VERSION_INVALID/,
    "missing original bytes block runtime reads",
  );
  const backfill1 = await space.backfillSystemTemplateContentStore();
  assert.ok(backfill1.blocked.some((b) => b.versionId === sv2.version_id), "backfill reports the unrecoverable version as blocked");
  // 恢复模板为新字节 → 回填可救回 v2，读取恢复
  mkTpl("w3r1-skill/SKILL.md", NEW);
  const backfill2 = await space.backfillSystemTemplateContentStore();
  assert.ok(backfill2.backfilled.includes(sv2.version_id), "backfill restores bytes when the template matches again");
  assert.ok((await space.resolveInstalledSkillContent(scopeA, agentNew.agent_id, sysSkill.skill_id)).bytes.equals(NEW));
});

test("W3-R2: default manifest is a one-time init event; later default kinds never auto-expand existing agents", async () => {
  const { db, space } = await fixture;
  const { writeFileSync: wf, mkdirSync: mkd } = await import("node:fs");

  // 存量 Agent：在 S2 出现之前初始化（拿到当时的默认集）
  const agentOld = space.createAgent({ scope: scopeA, name: "W3R2存量助手", actor: "user:a" });
  const init1 = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentOld.agent_id, actor: "system" });
  assert.equal(init1.alreadyInitialized, false);
  const installedAfterInit = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agentOld.agent_id) as { n: number }).n;
  assert.ok(installedAfterInit >= 1, "stock agent initialized with the then-current defaults");

  // 平台新增另一种默认技能 S2（不同 skillId）
  mkd(path.join(process.env.SYSTEM_SKILLS_TEMPLATE_ROOT!, "w3r2-skill"), { recursive: true });
  const body2 = Buffer.from("# W3R2 第二默认技能\n", "utf8");
  wf(path.join(process.env.SYSTEM_SKILLS_TEMPLATE_ROOT!, "w3r2-skill", "SKILL.md"), body2);
  const sys2 = space.upsertSkill({ domain: "system", scope: null, slug: "w3r2-sys", name: "第二默认技能", ownerToken: OWNER_TOKEN, actor: "owner" });
  const sv = await space.addSkillVersion({ domain: "system", scope: null, skillId: sys2.skill_id, contentRef: { contentRefType: "system_template", systemTemplatePath: "w3r2-skill/SKILL.md", contentChecksum: sha256Of(body2) }, origin: "system_seed", ownerToken: OWNER_TOKEN, actor: "owner" });
  space.approveSkillVersion({ domain: "system", scope: null, skillId: sys2.skill_id, versionId: sv.version_id, approvedBy: "owner", approvalRef: "owner-decision:2026-09-20/w3r2-approve", ownerToken: OWNER_TOKEN, actor: "owner" });
  space.publishSkillRelease({ domain: "system", scope: null, skillId: sys2.skill_id, versionId: sv.version_id, releaseVersion: "1.0.0", visibility: "public", publishedBy: "owner", isDefault: true, ownerToken: OWNER_TOKEN, actor: "owner" });

  // owner 反例：已初始化的存量 Agent 重跑初始化 → 纯 no-op，不自动安装 S2
  const rerun = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentOld.agent_id, actor: "system" });
  assert.equal(rerun.alreadyInitialized, true);
  assert.equal(rerun.appliedInstallationIds.length, 0, "re-running init never installs the newly added default kind");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agentOld.agent_id) as { n: number }).n, installedAfterInit, "existing agent's install count is frozen at init");
  assert.ok(!space.getInstalledSkillManifest(scopeA, agentOld.agent_id).some((m) => m.skillId === sys2.skill_id), "S2 is absent until an explicit authorized install");
  // 新创建的 Agent 初始化拿到全部当前默认（含 S2）——默认分配仅用于创建时
  const agentFresh = space.createAgent({ scope: scopeA, name: "W3R2新助手", actor: "user:a" });
  space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentFresh.agent_id, actor: "system" });
  assert.ok(space.getInstalledSkillManifest(scopeA, agentFresh.agent_id).some((m) => m.skillId === sys2.skill_id), "fresh agents receive the full current default set");

  // 首次空清单也记录完成：清空默认标记 → 新 Agent 初始化（空）→ 标记完成后恢复默认 → 重跑不扩容
  db.sqlite.exec("UPDATE agent_space_skill_releases SET is_default=0");
  const agentEmpty = space.createAgent({ scope: scopeA, name: "W3R2空清单助手", actor: "user:a" });
  const emptyInit = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentEmpty.agent_id, actor: "system" });
  assert.equal(emptyInit.appliedInstallationIds.length, 0);
  assert.equal(emptyInit.alreadyInitialized, false, "empty first init still completes and is recorded");
  db.sqlite.exec("UPDATE agent_space_skill_releases SET is_default=1 WHERE release_version='1.0.0' AND domain='system'");
  const afterRestore = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentEmpty.agent_id, actor: "system" });
  assert.equal(afterRestore.alreadyInitialized, true, "completed empty init is never re-expanded");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agentEmpty.agent_id) as { n: number }).n, 0);

  // 初始化失败原子回滚：审计失败 → 标记不落、安装不落；修复后重试完整成功
  db.sqlite.exec("UPDATE agent_space_skill_releases SET is_default=0"); // 只留 S2 一个默认，便于断言
  db.sqlite.exec("UPDATE agent_space_skill_releases SET is_default=1 WHERE skill_id=(SELECT skill_id FROM agent_space_skills WHERE slug='w3r2-sys')");
  const agentFlaky = space.createAgent({ scope: scopeA, name: "W3R2故障助手", actor: "user:a" });
  db.sqlite.exec(`
    CREATE TRIGGER w3r2_fail_init_audit
    BEFORE INSERT ON agent_space_audit_logs
    WHEN NEW.action = 'agent.default_manifest_applied'
    BEGIN SELECT RAISE(ABORT, 'injected init audit failure'); END;
  `);
  let initThrew = false;
  try {
    space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentFlaky.agent_id, actor: "system" });
  } catch {
    initThrew = true;
  }
  assert.ok(initThrew, "init audit failure surfaces");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_agent_skill_installations WHERE agent_id=?").get(agentFlaky.agent_id) as { n: number }).n, 0, "failed init leaves no installations");
  assert.equal((db.sqlite.prepare("SELECT default_manifest_applied_at FROM agent_space_agents WHERE agent_id=?").get(agentFlaky.agent_id) as { default_manifest_applied_at: string | null }).default_manifest_applied_at, null, "failed init leaves no completion marker");
  db.sqlite.exec("DROP TRIGGER w3r2_fail_init_audit");
  const retried = space.applyDefaultSkillManifest({ scope: scopeA, agentId: agentFlaky.agent_id, actor: "system" });
  assert.equal(retried.alreadyInitialized, false);
  assert.equal(retried.appliedInstallationIds.length, 1, "retry after repair completes the full init consistently");
});

test("W4 rework R2-R4: identity chain, scoped keys, frozen replay, deps-only assembly, scoped state packet", async () => {
  const { db, space } = await fixture;

  // 装配环境：active Agent + 已装技能 + 方法绑定 + 授权资产
  const agent = space.createAgent({ scope: scopeA, name: "W4R助手", actor: "user:a" });
  space.setAgentStatus(scopeA, agent.agent_id, "active", "user:a");
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "w4r-skill", name: "W4R技能", actor: "user:a" });
  const sv1 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv1.version_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv1.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv1.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "W4R方法", actor: "user:a" });
  const mv1 = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv1.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv1.version_id, versionId: mv1.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: method.method_id, versionPolicy: "current", actor: "user:a" });
  space.grantAsset({ scope: scopeA, agentId: agent.agent_id, assetId: "asset_w2", grantedBy: "user:a", actor: "user:a" });

  // —— R2：伪身份拒绝且不落 basis/审计 ——
  const basisCount = () => (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n;
  const before = basisCount();
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "conversation", basisKey: "conv-fake:1", conversationId: "conv_missing", actor: "u" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "task-fake:1", taskId: "task_missing", actor: "u" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "run-fake:1", taskId: "task_exec_1", runId: "run_missing", actor: "u" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeB, agentId: agent.agent_id, entryKind: "conversation", basisKey: "conv-cross:1", conversationId: "conv_w1", actor: "u" }),
    "AGENT_SPACE_SCOPE_MISMATCH",
  );
  assert.equal(basisCount(), before, "rejected identities write no basis rows");

  // —— R2：不同 scope 同 key 互不冲突 ——
  const convA = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "conversation", basisKey: "shared-key:1", conversationId: "conv_w1", actor: "u" });
  const agentB = space.createAgent({ scope: scopeB, name: "W4R助手B", actor: "user:b" });
  space.setAgentStatus(scopeB, agentB.agent_id, "active", "user:b");
  db.sqlite.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at) VALUES ('conv_w1_b',?,?,?,'a','w','','',1,'active',?,?)`).run(scopeB.userId, scopeB.projectId, scopeB.instanceId, now, now);
  const convB = space.assembleAndRecordRunBasis({ scope: scopeB, agentId: agentB.agent_id, entryKind: "conversation", basisKey: "shared-key:1", conversationId: "conv_w1_b", actor: "u" });
  assert.notEqual(convA.basisId, convB.basisId, "same basisKey in different scopes never collides");
  // 同 key 不同请求（换 Agent）→ 冲突
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "shared-key:1", taskId: "task_exec_1", actor: "u" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );

  // —— R2：冻结回放——配置升级后同请求重试仍返回原 basis ——
  const frozen = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "conversation", basisKey: "frozen:1", conversationId: "conv_w1", actor: "u" });
  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_2", contentChecksum: W2_CHK_2 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s2", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv2.version_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_upgrade", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv2.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });
  const retried = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "conversation", basisKey: "frozen:1", conversationId: "conv_w1", actor: "u" });
  assert.equal(retried.basisId, frozen.basisId, "same request retries read the frozen basis");
  assert.equal(retried.resolution.skills[0]!.versionId, sv1.version_id, "frozen basis keeps this round's versions despite upgrades");
  assert.equal(space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "conversation", basisKey: "frozen:2", conversationId: "conv_w1", actor: "u" }).resolution.skills[0]!.versionId, sv2.version_id, "a new key resolves the upgraded version");

  // —— R4：状态包真空桩 ——
  // W5：状态包为真实作用域检索（不再是空桩）——只含 conv_w1/执行 Agent 归属条目
  assert.ok(Array.isArray(frozen.resolution.statePacket.entries));
  assert.match(frozen.resolution.statePacket.note, /state is read-only/);
  assert.ok(frozen.resolution.statePacket.entries.every((e) => e.objectType === "lesson" || e.objectType === "workflow"));
  assert.ok(frozen.resolution.statePacket.retrieval.budgetChars > 0);

  // —— conversation 装配内容：资产带 version+checksum ——
  assert.ok(frozen.resolution.assets.some((a) => a.assetId === "asset_w2" && a.versionId && a.contentChecksum === W2_CHK_1), "conversation assets carry version+checksum");

  // —— R3：任务无依赖 = 显式空集 ——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_empty',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  const emptyBasis = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "run:empty:1", taskId: "task_empty", actor: "u" });
  assert.equal(emptyBasis.resolution.skills.length + emptyBasis.resolution.methods.length + emptyBasis.resolution.assets.length, 0, "no-dependency tasks assemble an explicit empty set, never the agent's full inventory");
  assert.ok(emptyBasis.resolution.skipped.some((s) => s.kind === "task" && s.reason.includes("task-declares-no-dependencies")), "legacy-not-ready marker is explicit");

  // —— R3：依赖 pin 的旧正式版本直接执行（Agent 已升级不迫使其跳版本）——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_pin',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_pin", kind: "skill", refId: skill.skill_id, versionPolicy: "pinned", pinnedVersionId: sv1.version_id, agentId: agent.agent_id, actor: "user:a" });
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_pin", kind: "method", refId: method.method_id, versionPolicy: "latest", agentId: agent.agent_id, actor: "user:a" });
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_pin", kind: "asset_input", refId: "asset_w2", versionPolicy: "pinned", pinnedVersionId: "ver_w2_1", agentId: agent.agent_id, actor: "user:a" });
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_pin", kind: "asset_output", refId: "asset_a1", versionPolicy: "latest", agentId: agent.agent_id, actor: "user:a" });
  const pinnedBasis = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "run:pin:1", taskId: "task_pin", actor: "u" });
  assert.equal(pinnedBasis.resolution.skills[0]!.versionId, sv1.version_id, "task-pinned old formal version executes even after the agent upgraded");
  assert.equal(pinnedBasis.resolution.skills[0]!.origin, "task-dependency-pinned");
  assert.equal(pinnedBasis.resolution.methods[0]!.versionId, mv1.version_id);
  const inputAsset = pinnedBasis.resolution.assets.find((a) => a.role === "input")!;
  assert.equal(inputAsset.versionId, "ver_w2_1", "pinned asset dependency carries its version");
  assert.equal(inputAsset.contentChecksum, W2_CHK_1);
  const outputAsset = pinnedBasis.resolution.assets.find((a) => a.role === "output")!;
  assert.ok(outputAsset.versionId && outputAsset.contentChecksum, "latest asset dependency resolves version+checksum at assembly time");
  // 未声明依赖的已装技能/资产不进入任务装配
  assert.equal(pinnedBasis.resolution.skills.length, 1);

  // —— R3：必需依赖不满足 → 阻断（不落 basis）——
  // 依赖即任务侧授权：方法存在且解析成功即满足；真正的“不满足”是声明了
  // 无法解析出正式版本的方法（仅草稿、无采用版本）。
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_missing_dep',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  const draftOnlyMethod = space.createMethod({ scope: scopeA, name: "W4R仅草稿方法", actor: "user:a" });
  space.addMethodVersion({ scope: scopeA, methodId: draftOnlyMethod.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_missing_dep", kind: "method", refId: draftOnlyMethod.method_id, versionPolicy: "latest", actor: "user:a" });
  const beforeBlocked = basisCount();
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "generic_automation", basisKey: "run:blocked:1", taskId: "task_missing_dep", actor: "u" }),
    "AGENT_SPACE_VERSION_INVALID",
  );
  assert.equal(basisCount(), beforeBlocked, "blocked assemblies write no basis rows");
  // agent_state 依赖是明确桩，不阻断
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_state_stub',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  db.sqlite.prepare(`INSERT INTO agent_space_task_dependencies (dependency_id, task_id, user_id, project_id, instance_id, agent_id, kind, ref_id, version_policy, pinned_version_id, metadata_json, created_at, updated_at)
     VALUES ('tdep_w4r_state', 'task_state_stub', ?, ?, ?, ?, 'agent_state', 'w4r-state-slot', 'latest', NULL, NULL, ?, ?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, agent.agent_id, now, now);
  const stubBasis = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agent.agent_id, entryKind: "scheduled", basisKey: "schedule:stub:1", taskId: "task_state_stub", actor: "u" });
  assert.ok(stubBasis.resolution.skipped.some((s) => s.kind === "agent_state"), "agent_state deps resolve to the explicit stub without blocking");

  // —— 注入回写与 execution 段（R9 逐尝试契约）——
  const injected = space.recordRunBasisInjection(scopeA, "frozen:1", { sections: [{ section: "method:x", originalChars: 10, keptChars: 5, reason: "content-budget-truncated" }], tools: ["t1"], workspace: null });
  assert.equal(injected.injection!.tools[0], "t1");
  assert.equal(injected.injection!.attemptNo, 1);
  assert.equal(injected.execution.status, "pending-w5");
  // 与最近一次完全一致的尝试不重复记录
  const replayed = space.recordRunBasisInjection(scopeA, "frozen:1", { sections: [{ section: "method:x", originalChars: 10, keptChars: 5, reason: "content-budget-truncated" }], tools: ["t1"], workspace: null });
  assert.equal(replayed.injection!.attemptNo, 1, "identical attempts do not append");
  assert.equal(replayed.injection!.attempts.length, 1);
  // 不同的真实输入 → 新尝试（关联同一冻结 resolution），记录反映本次实际发送
  const changed = space.recordRunBasisInjection(scopeA, "frozen:1", { sections: [], tools: [], workspace: null });
  assert.equal(changed.injection!.attemptNo, 2, "changed input appends a new attempt");
  assert.equal(changed.injection!.tools.length, 0);
  assert.equal(changed.injection!.attempts.length, 2, "attempt history links to the same frozen resolution");
  assert.equal(changed.injection!.attempts[0]!.tools[0], "t1");
  // 收尾：停用本组 Agent，避免影响后续组的唯一-active 前提（R7 歧义拒绝）
  space.setAgentStatus(scopeA, agent.agent_id, "disabled", "user:a");
});

test("W4 rework R1: real-entry wiring — isolated injection captures the final model context", async (t) => {
  const { db, space } = await fixture;
  const { randomUUID } = await import("node:crypto");
  const http = await import("node:http");

  // 本地假模型网关：捕获真实入口最终发给模型的 messages/tools。
  const captured: Array<{ body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString(); });
    request.on("end", () => {
      captured.push({ body: JSON.parse(requestBody) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"w4","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"ok-w4"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"w4","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  t.after(() => { server.close(); });

  // 装配环境：active Agent + 已装技能（真实字节）+ 方法绑定。
  const agent = space.createAgent({ scope: scopeA, name: "W4W助手", actor: "user:a" });
  space.setAgentStatus(scopeA, agent.agent_id, "active", "user:a");
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "w4w-skill", name: "W4W技能", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv.version_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill.skill_id, source: "private", versionId: sv.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "W4W方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv.version_id, versionId: mv.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });
  space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: method.method_id, versionPolicy: "current", actor: "user:a" });

  const previousEnv = { ...process.env };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "w4-test-key";
  process.env.MASTRA_DEFAULT_MODEL = "w4-test-model";
  process.env.AGENT_SPACE_ASSEMBLY_MODE = `scope:${scopeA.userId}`;
  t.after(() => {
    for (const key of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "MASTRA_DEFAULT_MODEL", "AGENT_SPACE_ASSEMBLY_MODE"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const { createRuntimeAgent } = await import("../src/runtime/agent.js");
  const systemPromptOf = (capture: { body: Record<string, unknown> }): string => {
    const messages = capture.body.messages as Array<{ role: string; content: unknown }>;
    const system = messages.find((m) => m.role === "system") ?? messages[0]!;
    return typeof system.content === "string" ? system.content : JSON.stringify(system.content);
  };

  // —— conversation 真实入口：装配模式启用 ——
  const runtimeAgent = createRuntimeAgent();
  const convMessageId = randomUUID();
  const convResponse = await runtimeAgent.handleMessage({
    id: convMessageId,
    from: scopeA.userId,
    timestamp: Date.now(),
    content: { text: "W4 装配模式验证" },
    context: { conversationId: "conv_w1", channel: "api", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  assert.equal(convResponse.content?.type ?? "text", "text");
  const convCapture = captured[captured.length - 1]!;
  const convSystem = systemPromptOf(convCapture);
  assert.match(convSystem, /Agent Space 装配（conversation）/);
  assert.match(convSystem, new RegExp(mv.version_id), "method content arrives with its pinned version id");
  assert.match(convSystem, /量价方法 W2 v1/, "pinned method body content is injected");
  assert.match(convSystem, new RegExp(W2_CHK_1), "checksums arrive at the model boundary");
  assert.match(convSystem, /状态包说明：state is read-only/, "the state packet note is explicit in the injected context");
  const convBasis = space.getRunBasis(scopeA, `conversation:conv_w1:message:${convMessageId}`);
  assert.equal(convBasis.resolution.methods[0]!.versionId, mv.version_id);
  assert.ok(convBasis.injection, "injection is recorded at the real entry");
  assert.equal(convBasis.injection!.workspace, null, "no workspace is mounted in assembly mode");

  // —— generic automation 真实入口（经 runtime agent + 显式标注 + 授权即清单）——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_w4w',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_w4w", kind: "method", refId: method.method_id, versionPolicy: "latest", agentId: agent.agent_id, actor: "user:a" });
  const autoMessageId = randomUUID();
  await runtimeAgent.handleMessage({
    id: autoMessageId,
    from: scopeA.userId,
    timestamp: Date.now(),
    content: { text: "W4 自动化装配验证" },
    context: {
      conversationId: `automation-run:${autoMessageId}`,
      channel: "automation",
      userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId,
      taskId: "task_w4w",
      _agentSpaceAssembly: "generic_automation",
      mcpAllowedTools: [],
    },
  });
  const autoBasis = space.getRunBasis(scopeA, `task:task_w4w:message:${autoMessageId}`);
  assert.equal(autoBasis.resolution.entryKind, "generic_automation");
  assert.equal(autoBasis.resolution.methods.length, 1, "task assembly is dependency-scoped");
  assert.equal(autoBasis.resolution.skills.length, 0, "undeclared skills never enter the task context");
  const autoCapture = captured[captured.length - 1]!;
  const autoSystem = systemPromptOf(autoCapture);
  assert.match(autoSystem, /Agent Space 装配（generic_automation）/);
  assert.deepEqual(autoBasis.injection!.tools, [], "the empty allowlist restricts tools at the model boundary");

  // —— scheduled 真实入口（runScheduledAgentTask 直连 runMastraTurn 的接缝）——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_w4w_sched',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  // R8：run→revision→task 链必须真实匹配（旧夹具错借 task_exec_1 的修订）
  db.sqlite.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,description,schedule_json,inputs_json,output_json,delivery_json,created_at)
                     VALUES ('rev_w4w_sched','task_w4w_sched',?,?,?,1,'W4W调度修订','w4w','{}','[]','{"mode":"agent"}','{}',?)`)
    .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  db.sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                     VALUES ('run_w4w_sched','task_w4w_sched','rev_w4w_sched',?,?,?,'manual','idem-w4w-sched',1,'succeeded',?,?,?,?)`)
    .run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_w4w_sched", kind: "method", refId: method.method_id, versionPolicy: "latest", agentId: agent.agent_id, actor: "user:a" });
  const { runScheduledAgentTaskForTest } = await import("../src/runtime/scheduled-tasks.js");
  const schedMessageId = randomUUID();
  const schedRunId = "run_w4w_sched";
  await runScheduledAgentTaskForTest({
    userContext: { userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId, channel: "api", conversationId: `scheduler:w4w:${scopeA.userId}` },
    promptText: "W4 scheduled 装配验证",
    conversationId: `scheduler:w4w:${scopeA.userId}`,
    messageId: schedMessageId,
    mode: "w4-wiring-test",
    runId: schedRunId,
    taskId: "task_w4w_sched",
  });
  const schedBasis = space.getRunBasis(scopeA, `run:${schedRunId}:basis`);
  assert.equal(schedBasis.resolution.entryKind, "scheduled");
  assert.equal(schedBasis.resolution.methods.length, 1);
  const schedCapture = captured[captured.length - 1]!;
  assert.match(systemPromptOf(schedCapture), /Agent Space 装配（scheduled）/);

  // —— 默认关闭：未启用 scope 行为不变（旧 instructions，零 basis 写入）——
  process.env.AGENT_SPACE_ASSEMBLY_MODE = "off";
  const basisBefore = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n;
  const legacyMessageId = randomUUID();
  await runtimeAgent.handleMessage({
    id: legacyMessageId,
    from: scopeB.userId,
    timestamp: Date.now(),
    content: { text: "W4 关闭模式验证" },
    context: { conversationId: "conv_w1", channel: "api", userId: scopeB.userId, projectId: scopeB.projectId, instanceId: scopeB.instanceId },
  });
  const legacyCapture = captured[captured.length - 1]!;
  const legacySystem = systemPromptOf(legacyCapture);
  assert.ok(!legacySystem.includes("Agent Space 装配"), "mode-off keeps legacy instructions");
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n, basisBefore, "mode-off writes no basis rows");
  // 收尾：停用本组 Agent，保证后续组的唯一-active 前提（R7 歧义拒绝）
  space.setAgentStatus(scopeA, agent.agent_id, "disabled", "user:a");
});

test("W4 rework R5-R9 at the model boundary: platform base, content blocking, stable identity, revision chain, per-attempt injection", async (t) => {
  const { db, space } = await fixture;
  const { randomUUID } = await import("node:crypto");
  const http = await import("node:http");
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");

  const captured: Array<{ body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString(); });
    request.on("end", () => {
      captured.push({ body: JSON.parse(requestBody) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"w4b","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"w4b","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  t.after(() => { server.close(); });

  const agentA = space.createAgent({ scope: scopeA, name: "R5R9助手A", actor: "user:a" });
  space.setAgentStatus(scopeA, agentA.agent_id, "active", "user:a");
  const skill = space.upsertSkill({ domain: "user", scope: scopeA, slug: "r59-skill", name: "R59技能", actor: "user:a" });
  const sv = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_1", contentChecksum: W2_CHK_1 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill.skill_id, versionId: sv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s1", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv.version_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agentA.agent_id, skillId: skill.skill_id, source: "private", versionId: sv.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agentA.agent_id, versionId: sv.version_id, extraBinding: { skillId: skill.skill_id, source: "private" } }), actor: "user:a" });
  const method = space.createMethod({ scope: scopeA, name: "R59方法", actor: "user:a" });
  const mv = space.addMethodVersion({ scope: scopeA, methodId: method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: method.method_id, versionId: mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: mv.version_id, versionId: mv.version_id, extraBinding: { methodId: method.method_id, adopt: "true" } }), actor: "user:a" });

  const previousEnv = { ...process.env };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "w4b-test-key";
  process.env.MASTRA_DEFAULT_MODEL = "w4b-test-model";
  process.env.AGENT_SPACE_ASSEMBLY_MODE = `scope:${scopeA.userId}`;
  t.after(() => {
    for (const key of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "MASTRA_DEFAULT_MODEL", "AGENT_SPACE_ASSEMBLY_MODE", "AGENT_SPACE_CONTENT_BUDGET_CHARS"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const { createRuntimeAgent } = await import("../src/runtime/agent.js");
  const { buildAgentSpaceTurnOptions } = await import("../src/runtime/agent-space-context.js");
  const runtimeAgent = createRuntimeAgent();
  const systemPromptOf = (capture: { body: Record<string, unknown> }): string => {
    const messages = capture.body.messages as Array<{ role: string; content: unknown }>;
    const system = messages.find((m) => m.role === "system") ?? messages[0]!;
    return typeof system.content === "string" ? system.content : JSON.stringify(system.content);
  };
  const assemblyCaptures = () => captured.filter((c) => systemPromptOf(c).includes("Agent Space 装配"));

  // —— R5：平台 L1 段与装配段同时在场，旧目录发现不再出现 ——
  const r5MessageId = randomUUID();
  await runtimeAgent.handleMessage({
    id: r5MessageId, from: scopeA.userId, timestamp: Date.now(),
    content: { text: "R5 平台段验证" },
    context: { conversationId: "conv_w1", channel: "api", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  const r5System = systemPromptOf(assemblyCaptures()[assemblyCaptures().length - 1]!);
  assert.match(r5System, /【能力边界】/, "platform capability boundary survives assembly mode");
  assert.match(r5System, /【事实与推断纪律】/, "platform fact discipline survives assembly mode");
  assert.match(r5System, /【工具使用原则】/, "platform tool doctrine survives assembly mode");
  assert.match(r5System, /Agent Space 装配（conversation）/, "assembly section coexists with the platform base");
  assert.match(r5System, /【用户方法论（Agent Space 装配）】/, "methodology is rewritten to the new object contract");
  assert.ok(!r5System.includes("methods/ 与 skills/ 目录"), "legacy workspace discovery guidance never reappears");

  // —— R7：稳定执行身份——新增 Agent 不换身份、不冲突；多 active 无绑定明确拒绝 ——
  const r7Key = `conversation:conv_w1:message:${r5MessageId}`;
  assert.equal(space.getRunBasis(scopeA, r7Key).resolution.agent.agentId, agentA.agent_id);
  const agentB = space.createAgent({ scope: scopeA, name: "R5R9助手B", actor: "user:a" });
  space.setAgentStatus(scopeA, agentB.agent_id, "active", "user:b");
  const r7Retry = await buildAgentSpaceTurnOptions({
    scope: scopeA, conversationId: "conv_w1", messageId: r5MessageId, channel: "api",
    grantedTools: {}, toolAllowlist: null,
  });
  assert.equal(space.getRunBasis(scopeA, r7Key).resolution.agent.agentId, agentA.agent_id, "same request retries keep the frozen identity after a new agent appears");
  void r7Retry;
  await assert.rejects(
    () => buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: randomUUID(), channel: "api", grantedTools: {}, toolAllowlist: null }),
    /multiple agents|explicit task binding|refusing to guess/,
    "new unbound conversation requests with multiple active agents are rejected explicitly",
  );

  // —— R6：必需正文校验失败 → 阻断（真实入口零装配模型调用）；恢复后同请求重试成功 ——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_r59',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  db.sqlite.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,description,schedule_json,inputs_json,output_json,delivery_json,created_at)
                     VALUES ('rev_r59','task_r59',?,?,?,1,'R59修订','r59','{}','[]','{"mode":"agent"}','{}',?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  db.sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                     VALUES ('run_r59','task_r59','rev_r59',?,?,?,'manual','idem-r59',1,'succeeded',?,?,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_r59", kind: "method", refId: method.method_id, versionPolicy: "pinned", pinnedVersionId: mv.version_id, agentId: agentA.agent_id, actor: "user:a" });
  const registry = await import("../src/mastra/workspace-registry.js");
  const entry = await registry.mastraWorkspaceRegistry.resolve(scopeA);
  const assetFile = path.join(entry!.projectRoot, "assets", "asset_w2", "versions", "ver_w2_1", "strategy.md");
  const originalBytes = rf(assetFile);
  wf(assetFile, Buffer.concat([originalBytes, Buffer.from("r6-tampered")]));
  const beforeR6 = assemblyCaptures().length;
  await assert.rejects(
    () => buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: `automation-run:r6`, messageId: randomUUID(), entryKind: "generic_automation", taskId: "task_r59", runId: "run_r59", grantedTools: {}, toolAllowlist: [] }),
    /AGENT_SPACE_VERSION_INVALID: required method content .* blocking the model call/,
    "required method content verification failure blocks the model call",
  );
  assert.equal(assemblyCaptures().length, beforeR6, "zero assembly model calls while content is broken");
  wf(assetFile, originalBytes);
  const r6Recovered = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: `automation-run:r6`, messageId: randomUUID(), entryKind: "generic_automation", taskId: "task_r59", runId: "run_r59", grantedTools: {}, toolAllowlist: [] });
  assert.match(r6Recovered.instructions, /Agent Space 装配（generic_automation）/, "restored bytes let the same request retry succeed");

  // —— R9：预算变化 → 实际输入与注入记录一致（新尝试，非旧记录顶名）——
  const r9Key = r6Recovered.basisKey;
  const first = space.getRunBasis(scopeA, r9Key);
  const bodySection = first.injection!.sections.find((s) => s.section.startsWith("method:"))!;
  assert.ok(bodySection.keptChars > 0, "attempt 1 injects the full method body");
  process.env.AGENT_SPACE_CONTENT_BUDGET_CHARS = "1";
  const r9Retry = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: `automation-run:r6`, messageId: randomUUID(), entryKind: "generic_automation", taskId: "task_r59", runId: "run_r59", grantedTools: {}, toolAllowlist: [] });
  assert.ok(!r9Retry.instructions.includes("正文第一版"), "the retried prompt no longer contains the method body under the tiny budget");
  const second = space.getRunBasis(scopeA, r9Key);
  assert.equal(second.injection!.attemptNo, 2, "a changed budget appends a new injection attempt");
  assert.equal(second.injection!.sections.find((s) => s.section.startsWith("method:"))!.keptChars <= 1, true, "attempt 2 records the real truncated input");
  assert.equal(second.injection!.attempts[0]!.sections.find((s) => s.section.startsWith("method:"))!.keptChars, bodySection.keptChars, "attempt history preserves attempt 1");
  delete process.env.AGENT_SPACE_CONTENT_BUDGET_CHARS;

  // —— R8：run→revision→task 错配一律拒绝且不落 basis ——
  const basisBeforeR8 = (db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n;
  db.sqlite.prepare("UPDATE automation_task_runs SET revision_id='rev_missing' WHERE run_id='run_w1_1'").run();
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agentA.agent_id, entryKind: "scheduled", basisKey: "schedule:r8missing:1", taskId: "task_exec_1", runId: "run_w1_1", actor: "u" }),
    "AGENT_SPACE_NOT_FOUND",
  );
  db.sqlite.prepare("UPDATE automation_task_runs SET revision_id='rev_w4w_sched' WHERE run_id='run_w1_1'").run();
  expectAgentSpaceError(
    () => space.assembleAndRecordRunBasis({ scope: scopeA, agentId: agentA.agent_id, entryKind: "scheduled", basisKey: "schedule:r8mismatch:1", taskId: "task_exec_1", runId: "run_w1_1", actor: "u" }),
    "AGENT_SPACE_ARGUMENT_INVALID",
  );
  assert.equal((db.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis").get() as { n: number }).n, basisBeforeR8, "revision mismatches write no basis rows");
  // 工具口径：注入记录的是服务工具；外部数据工具是另一条路径（本隔离环境无外部 MCP）
  const capturedToolNames = ((captured[captured.length - 1]!.body.tools as Array<{ function?: { name?: string }; name?: string }>) ?? []).map((tool) => tool.function?.name ?? tool.name ?? "");
  const injectionTools = second.injection!.tools;
  for (const name of injectionTools) assert.ok(capturedToolNames.includes(name), "recorded service tools are a subset of the model request tools");
  // 收尾：停用两个 Agent，保持后续组环境干净
  space.setAgentStatus(scopeA, agentA.agent_id, "disabled", "user:a");
  space.setAgentStatus(scopeA, agentB.agent_id, "disabled", "user:b");
});

test("W4 rework round 3 (R5/R6/R9 residual): channel policy at real entries, content-block zero model calls, legacy injection upgrade replay", async (t) => {
  const { db, space } = await fixture;
  const { randomUUID } = await import("node:crypto");
  const http = await import("node:http");
  const { readFileSync: rf, writeFileSync: wf } = await import("node:fs");

  const captured: Array<{ body: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString(); });
    request.on("end", () => {
      captured.push({ body: JSON.parse(requestBody) as Record<string, unknown> });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"w4c","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"w4c","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  t.after(() => { server.close(); });

  const agent = space.createAgent({ scope: scopeA, name: "R3轮助手", actor: "user:a" });
  space.setAgentStatus(scopeA, agent.agent_id, "active", "user:a");
  const skill2 = space.upsertSkill({ domain: "user", scope: scopeA, slug: "r3-skill2", name: "R3技能2", actor: "user:a" });
  const sv2 = await space.addSkillVersion({
    domain: "user", scope: scopeA, skillId: skill2.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: "asset_w2", assetVersionId: "ver_w2_2", contentChecksum: W2_CHK_2 },
    origin: "private_edit", actor: "user:a",
  });
  space.approveSkillVersion({ domain: "user", scope: scopeA, skillId: skill2.skill_id, versionId: sv2.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_s2", { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: sv2.version_id, versionId: sv2.version_id, extraBinding: { skillId: skill2.skill_id } }), actor: "user:a" });
  space.installSkill({ scope: scopeA, agentId: agent.agent_id, skillId: skill2.skill_id, source: "private", versionId: sv2.version_id, installedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_install", { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: agent.agent_id, versionId: sv2.version_id, extraBinding: { skillId: skill2.skill_id, source: "private" } }), actor: "user:a" });
  const r3Method = space.createMethod({ scope: scopeA, name: "R3轮方法", actor: "user:a" });
  const r3mv = space.addMethodVersion({ scope: scopeA, methodId: r3Method.method_id, contentRef: CONTENT_W2_1, actor: "user:a" });
  space.approveMethodVersion({ scope: scopeA, methodId: r3Method.method_id, versionId: r3mv.version_id, approvedBy: "user:a", approvalRef: await authz(scopeA, "um_w1_1", { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: r3mv.version_id, versionId: r3mv.version_id, extraBinding: { methodId: r3Method.method_id, adopt: "true" } }), actor: "user:a" });
  space.bindMethod({ scope: scopeA, agentId: agent.agent_id, methodId: r3Method.method_id, versionPolicy: "current", actor: "user:a" });

  const previousEnv = { ...process.env };
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.OPENAI_API_KEY = "w4c-test-key";
  process.env.MASTRA_DEFAULT_MODEL = "w4c-test-model";
  process.env.AGENT_SPACE_ASSEMBLY_MODE = `scope:${scopeA.userId}`;
  t.after(() => {
    for (const key of ["OPENAI_BASE_URL", "OPENAI_API_KEY", "MASTRA_DEFAULT_MODEL", "AGENT_SPACE_ASSEMBLY_MODE", "AGENT_SPACE_CONTENT_BUDGET_CHARS"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const { createRuntimeAgent } = await import("../src/runtime/agent.js");
  const { buildAgentSpaceTurnOptions } = await import("../src/runtime/agent-space-context.js");
  const { buildAgentInstructions, buildPlatformBaseInstructions } = await import("../src/runtime/agent-instructions.js");
  const runtimeAgent = createRuntimeAgent();
  const systemPromptOf = (capture: { body: Record<string, unknown> }): string => {
    const messages = capture.body.messages as Array<{ role: string; content: unknown }>;
    const system = messages.find((m) => m.role === "system") ?? messages[0]!;
    return typeof system.content === "string" ? system.content : JSON.stringify(system.content);
  };
  const assemblyCaptures = () => captured.filter((c) => systemPromptOf(c).includes("Agent Space 装配"));
  const toolNamesOf = (capture: { body: Record<string, unknown> }): string[] =>
    ((capture.body.tools as Array<{ function?: { name?: string }; name?: string }>) ?? []).map((tool) => tool.function?.name ?? tool.name ?? "");

  // —— R5 续：web / weixin-mobile 真实入口捕获通道规则 ——
  const webMessageId = randomUUID();
  const webIndex = assemblyCaptures().length;
  await runtimeAgent.handleMessage({
    id: webMessageId, from: scopeA.userId, timestamp: Date.now(),
    content: { text: "R5 web 通道验证" },
    context: { conversationId: "conv_w1", channel: "web", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  assert.equal(assemblyCaptures().length, webIndex + 1, "the web turn reached the model boundary");
  const webSystem = systemPromptOf(assemblyCaptures()[webIndex]!);
  assert.match(webSystem, /【通道上下文】这是一条来自门户网页聊天的消息/, "web channel policy is composed into the assembly-mode system prompt");
  const weixinMessageId = randomUUID();
  const weixinIndex = assemblyCaptures().length;
  // 微信通道有 onboarding 门：先补完成初始化状态，消息才能到达模型边界
  const { MastraUserPreferenceStore } = await import("../src/services/user-preferences.js");
  const prefStore = new MastraUserPreferenceStore(scopeA.userId, scopeA.instanceId, scopeA.projectId);
  await prefStore.writeOnboardingState({
    version: 1, status: "completed", current_step: "completed",
    steps: {}, completed_at: new Date().toISOString(), updated_at: new Date().toISOString(), notes: "",
  } as never);
  await runtimeAgent.handleMessage({
    id: weixinMessageId, from: scopeA.userId, timestamp: Date.now(),
    content: { text: "R5 微信通道验证" },
    context: { conversationId: "conv_w1", channel: "weixin-mobile", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  assert.equal(assemblyCaptures().length, weixinIndex + 1, "the weixin-mobile turn reached the model boundary (onboarding completed)");
  assert.match(systemPromptOf(assemblyCaptures()[weixinIndex]!), /【通道上下文】这是一条来自微信用户的消息/, "weixin-mobile channel policy is composed into the assembly-mode system prompt");
  void weixinMessageId;
  // 旧模式同通道不重复拼接（平台段内一次、无二次追加）
  const legacyWeb = buildAgentInstructions({ channel: "web" });
  assert.equal(legacyWeb.split("【通道上下文】").length - 1, 1, "legacy mode appends the channel section exactly once");
  assert.ok(buildPlatformBaseInstructions({ agentSpaceAssembly: true }).includes("【事实与推断纪律】"));

  // —— R6 真实入口证据：Method 校验失败 → 装配模型调用零增长；恢复后同请求成功 ——
  const registry = await import("../src/mastra/workspace-registry.js");
  const entry = await registry.mastraWorkspaceRegistry.resolve(scopeA);
  const v1File = path.join(entry!.projectRoot, "assets", "asset_w2", "versions", "ver_w2_1", "strategy.md");
  const v1Original = rf(v1File);
  wf(v1File, Buffer.concat([v1Original, Buffer.from("r6-real-tampered")]));
  const beforeBlocked = assemblyCaptures().length;
  const r6MessageId = randomUUID();
  await runtimeAgent.handleMessage({
    id: r6MessageId, from: scopeA.userId, timestamp: Date.now(),
    content: { text: "R6 真实入口阻断验证" },
    context: { conversationId: "conv_w1", channel: "api", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  assert.equal(assemblyCaptures().length, beforeBlocked, "real conversation entry makes ZERO assembly model calls while required method content is broken");
  const blockedBasis = space.findRunBasis(scopeA, `conversation:conv_w1:message:${r6MessageId}`);
  assert.ok(blockedBasis === null || blockedBasis.injection === null, "a blocked entry never records a successful injection (resolution may remain as failure evidence)");
  wf(v1File, v1Original);
  await runtimeAgent.handleMessage({
    id: r6MessageId, from: scopeA.userId, timestamp: Date.now(),
    content: { text: "R6 真实入口阻断验证（恢复后重试）" },
    context: { conversationId: "conv_w1", channel: "api", userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId },
  });
  assert.equal(assemblyCaptures().length, beforeBlocked + 1, "the same request succeeds at the real entry after bytes are restored");

  // —— R6 真实入口证据（Skill 内容缺失，scheduled 接缝）——
  db.sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('task_r3',?,?,?,'active',1,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  db.sqlite.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,description,schedule_json,inputs_json,output_json,delivery_json,created_at)
                     VALUES ('rev_r3','task_r3',?,?,?,1,'R3修订','r3','{}','[]','{"mode":"agent"}','{}',?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now);
  db.sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                     VALUES ('run_r3','task_r3','rev_r3',?,?,?,'manual','idem-r3',1,'succeeded',?,?,?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now, now, now);
  space.upsertTaskDependency({ scope: scopeA, taskId: "task_r3", kind: "skill", refId: skill2.skill_id, versionPolicy: "pinned", pinnedVersionId: sv2.version_id, agentId: agent.agent_id, actor: "user:a" });
  const { runScheduledAgentTaskForTest } = await import("../src/runtime/scheduled-tasks.js");
  const v2File = path.join(entry!.projectRoot, "assets", "asset_w2", "versions", "ver_w2_2", "strategy.md");
  const v2Original = rf(v2File);
  wf(v2File, Buffer.concat([v2Original, Buffer.from("r3-skill-broken")]));
  const beforeSkillBlocked = assemblyCaptures().length;
  let skillBlockSurfaced = false;
  try {
    await runScheduledAgentTaskForTest({
    userContext: { userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId, channel: "api", conversationId: `scheduler:r3:${scopeA.userId}` },
    promptText: "R3 skill 缺失阻断验证",
    conversationId: `scheduler:r3:${scopeA.userId}`,
    messageId: randomUUID(),
    mode: "w4-round3-test",
    runId: "run_r3",
    taskId: "task_r3",
    });
  } catch {
    skillBlockSurfaced = true;
  }
  void skillBlockSurfaced;
  assert.equal(assemblyCaptures().length, beforeSkillBlocked, "real scheduled entry makes ZERO assembly model calls while required skill content is missing (the entry reports the failure instead)");
  wf(v2File, v2Original);
  await runScheduledAgentTaskForTest({
    userContext: { userId: scopeA.userId, projectId: scopeA.projectId, instanceId: scopeA.instanceId, channel: "api", conversationId: `scheduler:r3:${scopeA.userId}` },
    promptText: "R3 skill 恢复重试验证",
    conversationId: `scheduler:r3:${scopeA.userId}`,
    messageId: randomUUID(),
    mode: "w4-round3-test",
    runId: "run_r3",
    taskId: "task_r3",
  });
  assert.equal(assemblyCaptures().length, beforeSkillBlocked + 1, "the scheduled entry retries successfully after the skill bytes are restored");

  // —— R9 续：旧 injection JSON（956f9bd 合法结构）升级重放不崩溃、不丢历史 ——
  const r9MessageId = randomUUID();
  const first = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: r9MessageId, channel: "api", grantedTools: {}, toolAllowlist: null });
  void first;
  const r9Key = `conversation:conv_w1:message:${r9MessageId}`;
  // 模拟 956f9bd 的真实存量形态：同一份真实注入内容，去掉 attemptNo/attempts
  const realFirst = space.getRunBasis(scopeA, r9Key).injection!;
  const legacyJson = JSON.stringify({
    sections: realFirst.sections,
    tools: realFirst.tools,
    workspace: null,
    injectedAt: "2026-09-20T00:00:00.000Z",
  });
  db.sqlite.prepare("UPDATE agent_space_run_basis SET injection_json=? WHERE basis_key=?").run(
    legacyJson,
    `${scopeA.userId}|${scopeA.projectId}|${scopeA.instanceId}|${r9Key}`,
  );
  const upgradedIdentical = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: r9MessageId, channel: "api", grantedTools: {}, toolAllowlist: null });
  void upgradedIdentical;
  let upgraded = space.getRunBasis(scopeA, r9Key);
  assert.equal(upgraded.injection!.attemptNo, 1, "legacy record normalizes as attempt 1 (no crash)");
  assert.equal(upgraded.injection!.injectedAt, "2026-09-20T00:00:00.000Z", "the legacy timestamp survives normalization");
  assert.equal(upgraded.injection!.attempts.length, 1, "normalization does not duplicate history");
  // 预算变化重试 → 追加 attempt 2；重复升级不重复历史
  process.env.AGENT_SPACE_CONTENT_BUDGET_CHARS = "1";
  const budgetRetry = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: r9MessageId, channel: "api", grantedTools: {}, toolAllowlist: null });
  delete process.env.AGENT_SPACE_CONTENT_BUDGET_CHARS;
  assert.ok(!budgetRetry.instructions.includes("正文第二版"), "budget retry really sends truncated input");
  upgraded = space.getRunBasis(scopeA, r9Key);
  assert.equal(upgraded.injection!.attemptNo, 2, "budget change appends attempt 2 after normalization");
  assert.equal(upgraded.injection!.attempts[0]!.injectedAt, "2026-09-20T00:00:00.000Z", "attempt 1 keeps the legacy timestamp");

  // —— R9 真实入口逐尝试比对：非空服务工具授权变化，捕获请求与该次记录一致 ——
  // 用上一轮 web 会话捕获到的真实服务工具名作为非空授权清单
  const knownServiceTool = toolNamesOf(assemblyCaptures()[webIndex]!).find(() => true) ?? "";
  const convToolMessageId = randomUUID();
  const r9convKey = `conversation:conv_w1:message:${convToolMessageId}`;
  const withTool = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: convToolMessageId, channel: "api", grantedTools: knownServiceTool ? { [knownServiceTool]: {} } : {}, toolAllowlist: null });
  assert.ok(withTool.tools && Object.keys(withTool.tools).length > 0, "non-empty service tool authorization is granted for the comparison case");
  const attempt1 = space.getRunBasis(scopeA, r9convKey).injection!;
  const withoutTool = await buildAgentSpaceTurnOptions({ scope: scopeA, conversationId: "conv_w1", messageId: convToolMessageId, channel: "api", grantedTools: {}, toolAllowlist: [] });
  assert.equal(Object.keys(withoutTool.tools).length, 0, "the authorization change really changes the injected tools");
  const attempt2 = space.getRunBasis(scopeA, r9convKey).injection!;
  assert.equal(attempt2.attemptNo, 2, "an authorization change appends a new attempt");
  assert.deepEqual(attempt1.tools, [knownServiceTool], "attempt 1 records the granted tool");
  assert.deepEqual(attempt2.tools, [], "attempt 2 records the empty grant");

  space.setAgentStatus(scopeA, agent.agent_id, "disabled", "user:a");
});

test("W5: scoped state packet, run-basis evidence, layered run outcomes, commitment closure", async () => {
  const { db, space } = await fixture;

  // —— 状态语料：作用域/冲突/去重/拒绝矩阵 ——
  const mkLesson = async (title: string, guidance: string, ownerKind: "conversation" | "task" | "agent", ownerId: string, messageId: string) => {
    const created = space.createStateCandidate({ scope: scopeA, kind: "lesson", title, content: { trigger: "t", guidance }, ownerKind, ownerId, actor: "agent" });
    space.approveStateCandidate({ scope: scopeA, kind: "lesson", objectId: created.objectId, expectedVersionId: created.versionId, approvedBy: "user:a", approvalRef: await authz(scopeA, messageId, { operation: "state.approve", objectType: "agent_space_lesson", objectId: created.objectId, versionId: created.versionId, extraBinding: { kind: "lesson" } }), actor: "user:a" });
    return created;
  };
  db.sqlite.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at) VALUES ('conv_other',?,?,?,'a','w','','',1,'active',?,?)`).run(scopeA.userId, scopeA.projectId, scopeA.instanceId, now, now);
  const w5Agent = space.createAgent({ scope: scopeA, name: "W5状态助手", actor: "user:a" });
  space.setAgentStatus(scopeA, w5Agent.agent_id, "active", "user:a");
  const L1 = await mkLesson("L1会话经验", "g1", "conversation", "conv_w1", "um_w1_1");
  const L2 = await mkLesson("L2会话经验", "g2", "conversation", "conv_w1", "um_w1_2");
  const L3 = await mkLesson("L3他域经验", "g3", "conversation", "conv_other", "um_w1_m");
  const L4 = await mkLesson("L4任务经验", "g4", "task", "task_exec_1", "um_w1_s1");
  const L7 = await mkLesson("L7重复内容", "g1", "conversation", "conv_w1", "um_w1_s2");
  const L8 = await mkLesson("L8Agent经验", "g8", "agent", w5Agent.agent_id, "um_w1_s3");
  const L5 = await mkLesson("L5反例证据", "g5", "conversation", "conv_w1", "um_w1_snap");
  db.sqlite.prepare("UPDATE agent_space_lessons SET evidence_state='counterexample' WHERE lesson_id=?").run(L5.objectId);
  const L6draft = space.createStateCandidate({ scope: scopeA, kind: "lesson", title: "L6草稿", content: { trigger: "t", guidance: "g6" }, ownerKind: "conversation", ownerId: "conv_w1", actor: "agent" });

  // conversation 检索：含 L1/L2/L8（agent 归属）；排除 out-of-scope、冲突证据、重复内容
  const convPacket = space.buildScopedStatePacket({ scope: scopeA, ownerKind: "conversation", ownerId: "conv_w1", agentId: w5Agent.agent_id, budgetChars: 100000 });
  const convIds = convPacket.entries.map((e) => e.objectId);
  assert.ok(convIds.includes(L1.objectId) && convIds.includes(L2.objectId) && convIds.includes(L8.objectId), "in-scope conversation+agent state is included");
  assert.ok(!convIds.includes(L3.objectId), "other-conversation state stays out of scope");
  assert.ok(!convIds.includes(L4.objectId), "task-owned state stays out of a conversation packet");
  assert.ok(!convIds.includes(L5.objectId), "counterexample evidence is conflict-excluded");
  assert.ok(!convIds.includes(L7.objectId), "duplicate content is deduplicated");
  assert.ok(!convIds.includes(L6draft.objectId), "drafts never enter the packet");
  const reasons = convPacket.exclusions.map((e) => e.reason);
  assert.ok(reasons.includes("out-of-scope") && reasons.includes("conflict-evidence") && reasons.includes("duplicate-content"), "every exclusion carries an explained reason");

  // task 检索：含 L4 + L8；会话经验出域
  const taskPacket = space.buildScopedStatePacket({ scope: scopeA, ownerKind: "task", ownerId: "task_exec_1", agentId: w5Agent.agent_id, budgetChars: 100000 });
  const taskIds = taskPacket.entries.map((e) => e.objectId);
  assert.ok(taskIds.includes(L4.objectId) && taskIds.includes(L8.objectId));
  assert.ok(!taskIds.includes(L1.objectId), "conversation-owned state does not leak into task packets");

  // 硬预算：起始与补查共用——超预算条目 offset 也不可达
  const tiny = space.buildScopedStatePacket({ scope: scopeA, ownerKind: "conversation", ownerId: "conv_w1", agentId: w5Agent.agent_id, budgetChars: 1 });
  assert.ok(tiny.entries.length === 0 || tiny.entries.every((e) => e.contentChars <= 1), "hard budget bounds every entry");
  assert.ok(tiny.exclusions.some((e) => e.reason === "budget-exhausted"), "budget exhaustion is recorded");
  const tinyNext = space.buildScopedStatePacket({ scope: scopeA, ownerKind: "conversation", ownerId: "conv_w1", agentId: w5Agent.agent_id, budgetChars: 1, offset: 1 });
  assert.equal(tinyNext.entries.length, 0, "offset pagination cannot bypass the shared hard budget");

  // 拒绝不生效：L2 转 rejected 后不再进入
  space.transitionStateCandidate({ scope: scopeA, kind: "lesson", objectId: L2.objectId, toStatus: "rejected", reason: "w5", actor: "user:a" });
  const afterReject = space.buildScopedStatePacket({ scope: scopeA, ownerKind: "conversation", ownerId: "conv_w1", agentId: w5Agent.agent_id, budgetChars: 100000 });
  assert.ok(!afterReject.entries.some((e) => e.objectId === L2.objectId), "rejected state never takes effect");

  // —— run-basis 查证：resolution 携带真实状态包，注入含状态段 ——
  const basis = space.assembleAndRecordRunBasis({ scope: scopeA, agentId: w5Agent.agent_id, entryKind: "conversation", basisKey: "conversation:conv_w1:message:w5-state-1", conversationId: "conv_w1", actor: "u" });
  const basisEntry = basis.resolution.statePacket.entries.find((e) => e.objectId === L1.objectId);
  assert.ok(basisEntry, "the run-basis carries the scoped state packet for audit");
  assert.equal(basisEntry!.versionId, L1.versionId, "packet entries are version-pinned and reproducible");
  const replayedBasis = space.getRunBasis(scopeA, "conversation:conv_w1:message:w5-state-1");
  assert.ok(replayedBasis.resolution.statePacket.entries.some((e) => e.objectId === L1.objectId), "frozen replay keeps the same packet evidence");
  // 状态段注入与查证一致：按冻结 versionId 可重读
  const content = space.readStateVersionContent(scopeA, "lesson", basisEntry!.versionId);
  assert.equal((content as { guidance?: string }).guidance, "g1");
  // 状态包不扩权：basis 技能/方法集不因状态存在而变化
  assert.equal(basis.resolution.skills.length, 0);
  assert.equal(basis.resolution.methods.length, 0);

  // —— 运行结果分层记录：执行/产物/投递（失败→成功）/阅读 ——
  const os1 = space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "execution_succeeded", actor: "system", idempotencyKey: "w5-exec-1" });
  space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "artifact_generated", detail: { assetId: "asset_w2" }, actor: "system" });
  space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "delivery_failed", detail: { reason: "wechat push error" }, actor: "system" });
  space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "delivery_succeeded", actor: "system" });
  space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "user_read", actor: "system" });
  const timeline = space.listRunOutcomes(scopeA, "run_w1_1").map((o) => o.kind);
  assert.deepEqual(timeline.slice(-5), ["execution_succeeded", "artifact_generated", "delivery_failed", "delivery_succeeded", "user_read"], "each lifecycle stage is recorded separately in order");
  const replayedOutcome = space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "execution_succeeded", actor: "system", idempotencyKey: "w5-exec-1" });
  assert.equal(replayedOutcome.outcomeId, os1.outcomeId, "idempotent outcome replay returns the existing record");
  expectAgentSpaceError(
    () => space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "execution_failed", actor: "system", idempotencyKey: "w5-exec-1" }),
    "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
  );
  expectAgentSpaceError(() => space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "bogus" as never, actor: "system" }), "AGENT_SPACE_ARGUMENT_INVALID");
  expectAgentSpaceError(() => space.recordRunOutcome({ scope: scopeA, runId: "run_missing", kind: "user_read", actor: "system" }), "AGENT_SPACE_NOT_FOUND");

  // —— 承诺闭环：两期履约、投递失败记录、暂停恢复；关课不取消既有任务 ——
  const commitment = space.createCommitment({ scope: scopeA, title: "W5周度履约", content: {}, commitmentKind: "recurring", completionCriteria: "每周复盘推送成功", executorTaskId: "task_exec_1", idempotencyKey: "w5-cmt", actor: "user:a" });
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: await authz(scopeA, "um_w1_c", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_exec_1" } }), executorTaskId: "task_exec_1", actor: "user:a" });
  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-14T19:00:00+08:00", status: "satisfied", runId: "run_w1_1", actor: "system" });
  space.recordRunOutcome({ scope: scopeA, runId: "run_w1_1", kind: "delivery_failed", detail: { period: "2026-09-14" }, actor: "system", idempotencyKey: "w5-cmt-d1" });
  space.recordFulfillment({ scope: scopeA, commitmentId: commitment.commitmentId, dueAt: "2026-09-21T19:00:00+08:00", status: "satisfied", runId: "run_w1_2", actor: "system" });
  let commitmentRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(commitmentRow.status, "active", "recurring commitments stay active across periods");
  space.transitionCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, toStatus: "paused", reason: "w5", actor: "user:a" });
  commitmentRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(commitmentRow.status, "paused");
  space.activateCommitment({ scope: scopeA, commitmentId: commitment.commitmentId, authorizationRef: await authz(scopeA, "um_w1_c_resume", { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: commitment.commitmentId, versionId: null, extraBinding: { executorTaskId: "task_exec_1" } }), executorTaskId: "task_exec_1", actor: "user:a" });
  commitmentRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(commitmentRow.status, "active", "paused commitments resume via authorized activation");
  // 关闭学习不取消既有授权任务：停用 L1 后承诺仍 active
  space.transitionStateCandidate({ scope: scopeA, kind: "lesson", objectId: L1.objectId, toStatus: "disabled", reason: "lesson closed", actor: "user:a" });
  commitmentRow = db.sqlite.prepare("SELECT status FROM agent_space_commitments WHERE commitment_id=?").get(commitment.commitmentId) as { status: string };
  assert.equal(commitmentRow.status, "active", "closing a lesson never cancels authorized commitments");

  space.setAgentStatus(scopeA, w5Agent.agent_id, "disabled", "user:a");
});
