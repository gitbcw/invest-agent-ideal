#!/usr/bin/env node
/**
 * W6 隔离迁移演练（rehearsal）驱动脚本。
 *
 * 用法：
 *   node --import tsx scripts/agent-space/w6-rehearsal.mjs \
 *     --w0-root .state/agent-space-w0 \
 *     --backup-root <灾备快照根> \
 *     --out-root .state/agent-space-w6/<runTs> \
 *     [--phase all|import|rollback-verify] [--snapshot <db快照>] [--selftest]
 *
 * 环境必须由调用方指向隔离目录（DB_PATH/WORKSPACE_ROOT/RUNTIME_DATA_ROOT/
 * MASTRA_PROJECTS_ROOT）；脚本不复用任何生产路径。两阶段进程模型：
 * import 阶段产出副本/导入结果/run-basis 证据并落导入前快照；
 * rollback-verify 阶段（独立进程）恢复快照并核验导入对象清零。
 *
 * 产物目录（源/副本/导入结果/回滚分目录，逐项带 hash）：
 *   00-source/ 01-isolated-copy/ 02-import-result/ 03-run-basis/ 04-rollback/ report.json
 * 报告明确为隔离演练证据，不是生产切换。
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const phase = argOf("phase") ?? "all";
const w0Root = argOf("w0-root");
const backupRoot = argOf("backup-root");
const outRoot = argOf("out-root");
const snapshotPath = argOf("snapshot");
const selftest = args.includes("--selftest");

if (!w0Root || !outRoot || (phase === "rollback-verify" && !snapshotPath) || (phase !== "rollback-verify" && !backupRoot)) {
  console.error("usage: w6-rehearsal.mjs --w0-root <dir> --backup-root <dir> --out-root <dir> [--phase all|import|rollback-verify] [--snapshot <file>] [--selftest]");
  process.exit(2);
}
for (const [name, value] of Object.entries({ DB_PATH: process.env.DB_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT, RUNTIME_DATA_ROOT: process.env.RUNTIME_DATA_ROOT, MASTRA_PROJECTS_ROOT: process.env.MASTRA_PROJECTS_ROOT })) {
  if (!value) {
    console.error(`refusing to run: env ${name} not set (rehearsal must point at isolated dirs)`);
    process.exit(2);
  }
}

process.env.NODE_ENV ??= "test";
process.env.WORKSPACE_BACKEND ??= "mastra";

// 本地仓库有 src/（tsx 直跑），服务器部署只有 dist/——按存在性回退。
async function importAppModule(relative) {
  for (const base of ["../../src", "../../dist"]) {
    try {
      return await import(new URL(`${base}/${relative}`, import.meta.url).href);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`cannot resolve app module: ${relative}`);
}

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nowIso = () => new Date().toISOString();
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null });
  if (!pass) console.error(`FAIL ${name}: ${detail ?? ""}`);
};

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
}

// ---------- rollback-verify 阶段（独立进程） ----------
if (phase === "rollback-verify") {
  const dbPath = process.env.DB_PATH;
  const db = await importAppModule("db/index.js");
  db.initDb();
  db.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  db.sqlite.close?.();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
  copyFileSync(snapshotPath, dbPath);
  const { default: Database } = await import("better-sqlite3");
  const verifyDb = new Database(dbPath, { readonly: true });
  const counts = {};
  for (const table of ["user_assets", "user_asset_versions", "agent_space_methods", "agent_space_method_versions", "agent_space_agents", "agent_space_run_basis", "agent_space_run_outcomes", "conversation_sessions", "automation_tasks"]) {
    counts[table] = verifyDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    check(`rollback-clean ${table}`, counts[table] === 0, `rows=${counts[table]}`);
  }
  verifyDb.close();
  writeJson(path.join(outRoot, "04-rollback", "rollback-verification.json"), {
    phase: "rollback-verify",
    snapshotPath,
    restoredDb: dbPath,
    counts,
    checkedAt: nowIso(),
    note: "快照恢复后隔离库回到导入前状态；本验证在独立进程执行。",
  });
  const failed = checks.some((c) => !c.pass);
  writeJson(path.join(outRoot, "report-rollback.json"), { phase: "rollback-verify", checks, pass: !failed, selftest, generatedAt: nowIso() });
  console.log(`rollback-verify: ${failed ? "FAILED" : "OK"} (${checks.filter((c) => c.pass).length}/${checks.length} checks)`);
  process.exit(failed ? 1 : 0);
}

// ---------- import 阶段 ----------
const db = await importAppModule("db/index.js");
db.initDb();
const { sqlite } = db;
const ownerToken = process.env.W6_OWNER_TOKEN ?? `w6-${randomUUID()}`;
sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(ownerToken);

const space = await importAppModule("services/agent-space/index.js");
const {
  loadW0MigrationInputs, stageMigrationCopies, importStagedMigration,
  verifyMigrationImport, listMigrationMethods, getMigrationMethodVersion,
} = space;

// 各用户 scope 注册隔离项目存储根（createUserAsset 落字节需要）。
const { mastraWorkspaceRegistry } = await importAppModule("mastra/workspace-registry.js");

const dir = {
  source: path.join(outRoot, "00-source"),
  copy: path.join(outRoot, "01-isolated-copy"),
  importResult: path.join(outRoot, "02-import-result"),
  runBasis: path.join(outRoot, "03-run-basis"),
  rollback: path.join(outRoot, "04-rollback"),
};
for (const d of Object.values(dir)) mkdirSync(d, { recursive: true });

// 0) 导入前快照（旧 Workspace default-load 关闭 = 隔离 WORKSPACE_ROOT 为空且未注册旧内容）。
sqlite.pragma("wal_checkpoint(TRUNCATE)");
const snapshot = path.join(dir.rollback, "pre-snapshot.db");
copyFileSync(process.env.DB_PATH, snapshot);
const workspaceEntries = existsSync(process.env.WORKSPACE_ROOT) ? readdirSync(process.env.WORKSPACE_ROOT) : [];
check("isolated-workspace-root-empty (旧 default-load 关闭)", workspaceEntries.length === 0, `entries=${workspaceEntries.join(",")}`);

// 1) 门禁消费 + 服务层重验。各 scope 先注册隔离项目存储根（资产字节落盘用）。
const inputs = loadW0MigrationInputs(w0Root);
for (const scope of new Map(inputs.autoItems.map((i) => [i.scope.instanceId, i.scope])).values()) {
  await mastraWorkspaceRegistry.bootstrap(scope);
}
writeJson(path.join(dir.source, "source-manifest.json"), {
  w0Root,
  backupRoot,
  gateGeneratedAt: inputs.gateGeneratedAt,
  importGateSha256: sha256Of(readFileSync(path.join(w0Root, "import-gate.json"))),
  autoItemIds: inputs.autoItems.map((i) => i.itemId),
  skippedByService: inputs.skipped,
  ownerReviewCount: inputs.ownerReviewQueue.length,
  collectedAt: nowIso(),
});
check("gate-recheck no unexpected skips", inputs.skipped.length === 0 || selftest, `skipped=${JSON.stringify(inputs.skipped)}`);
check("auto-items non-empty", inputs.autoItems.length > 0, `n=${inputs.autoItems.length}`);
const ownerReviewIds = new Set(inputs.ownerReviewQueue.map((e) => e.itemId));
for (const item of inputs.autoItems) {
  check(`owner-review not auto-imported ${item.itemId}`, !ownerReviewIds.has(item.itemId));
}

// 2) staging：备份字节实读 + hash 双核对。
const staged = stageMigrationCopies(inputs.autoItems, backupRoot, dir.copy);
writeJson(path.join(dir.copy, "stage-outcomes.json"), { outcomes: staged.outcomes, generatedAt: nowIso() });
const stagedIds = new Set(staged.outcomes.filter((o) => o.status === "staged").map((o) => o.itemId));
const expectedDrift = new Set(inputs.autoItems.filter((i) => i.path.includes("漂移")).map((i) => i.itemId));
const expectedMissing = new Set(inputs.autoItems.filter((i) => i.path.includes("缺失")).map((i) => i.itemId));
check("staging staged count matches clean items", stagedIds.size === inputs.autoItems.length - expectedDrift.size - expectedMissing.size,
  `staged=${stagedIds.size} auto=${inputs.autoItems.length} drift=${expectedDrift.size} missing=${expectedMissing.size}`);
for (const outcome of staged.outcomes) {
  if (expectedDrift.has(outcome.itemId)) check(`drift intercepted ${outcome.itemId}`, outcome.status === "skipped" && /hash-drift/.test(outcome.reason ?? ""));
  else if (expectedMissing.has(outcome.itemId)) check(`missing-backup intercepted ${outcome.itemId}`, outcome.status === "skipped" && outcome.reason === "backup-unreadable");
  else check(`staged ${outcome.itemId}`, outcome.status === "staged" && outcome.copyHash != null);
}

// 3) 导入（幂等）+ 二跑重放核对。
const importable = inputs.autoItems.filter((i) => stagedIds.has(i.itemId));
const first = await importStagedMigration(importable, staged.staged, dir.copy);
const second = await importStagedMigration(importable, staged.staged, dir.copy);
check("import no failures", first.failures.length === 0, JSON.stringify(first.failures));
check("import count covers staged items minus service-boundary skips",
  first.outcomes.length + first.skipped.length === importable.length,
  `${first.outcomes.length}+${first.skipped.length}/${importable.length} skipped=${JSON.stringify(first.skipped)}`);
check("replay zero-new", second.outcomes.length === first.outcomes.length && second.outcomes.every((o) => o.idempotentReplay),
  second.outcomes.filter((o) => !o.idempotentReplay).map((o) => o.itemId).join(",") || "all replayed");
const idStable = first.outcomes.every((o, i) => o.assetId === second.outcomes[i]?.assetId && o.assetVersionId === second.outcomes[i]?.assetVersionId);
check("replay same object ids", idStable);

const outcomes = first.outcomes;
writeJson(path.join(dir.importResult, "import-outcomes.json"), { outcomes, failures: first.failures, skipped: first.skipped, replay: { idempotentAll: second.outcomes.every((o) => o.idempotentReplay) }, generatedAt: nowIso() });
writeJson(path.join(dir.importResult, "owner-review-queue.json"), { queue: inputs.ownerReviewQueue, note: "owner-review 项不导入；此处仅可发现性清单（含约束/目标/备份位置）。", generatedAt: nowIso() });

// 4) 逐项核对：scope/hash/可见性/归档态。
const outsiderScope = { userId: "w6-outsider", projectId: "invest-agent", instanceId: "invest-agent-w6-outsider" };
const verifyOutcomes = await verifyMigrationImport(outcomes, outsiderScope);
writeJson(path.join(dir.importResult, "verify-outcomes.json"), { verifyOutcomes, generatedAt: nowIso() });
for (const v of verifyOutcomes) {
  check(`verify ${v.itemId}`, v.scopeOk && v.storedHashMatchesSource && v.sameScopeReadable && v.crossScopeRejected && (v.archivedMethodState === null || v.archivedMethodState === true),
    JSON.stringify(v));
}

// 5) 必测三场景。
const byUser = (user) => outcomes.filter((o) => o.scope.userId === user);
const mgMethods = listMigrationMethods(sc("mg"));
const methodOutcomeOf = (user) => byUser(user).find((o) => o.objectType === "method");

// S1 mg：四因子与 KP 独立；缺账本不推断空仓。
const mgMethod = methodOutcomeOf("mg");
check("S1 mg four-factor imported as method", Boolean(mgMethod));
if (mgMethod) {
  const version = getMigrationMethodVersion(mgMethod.scope, mgMethod.methodVersionId);
  check("S1 four-factor archived draft, origin migration", version.status === "draft" && version.origin === "migration");
  check("S1 four-factor has no adoption constraints", version.adoptionConstraints.length === 0);
}
const kpEntry = inputs.ownerReviewQueue.find((e) => e.itemId.includes("控盘度指标V1.0"));
check("S1 old KP stays owner-review (not imported)", Boolean(kpEntry) && !outcomes.some((o) => o.itemId === kpEntry.itemId));
check("S1 old KP constraint recorded", kpEntry?.adoptionConstraints.some((c) => c.startsWith("historical-not-default")), JSON.stringify(kpEntry?.adoptionConstraints));
check("S1 mg methods exactly the four-factor one", mgMethods.length === 1, JSON.stringify(mgMethods.map((m) => m.name)));

// S2 111：模板/策略分离；一次性回测不长久化。
const u111Methods = listMigrationMethods(sc("111"));
check("S2 111 imports no method (回测/日报保持资产)", u111Methods.length === 0, JSON.stringify(u111Methods.map((m) => m.name)));
const strategy111 = inputs.ownerReviewQueue.find((e) => e.itemId === "111:liveProjectRoot:methods/strategy-rules.md");
check("S2 111 strategy stays owner-review with split targets", Boolean(strategy111)
  && strategy111.reconciliationTargets.includes("methods/strategy-rules.md")
  && strategy111.reconciliationTargets.includes("workflows/daily-review.md"), JSON.stringify(strategy111?.reconciliationTargets));
const backtest = byUser("111").find((o) => o.itemId.includes("T-337"));
check("S2 one-off backtest imported as asset only", backtest?.objectType === "asset" && !backtest.methodId, backtest?.itemId);

// S3 dyk：撤回旧策略只归档；采用可阻塞；核心模型可发现。
const dykMethod = methodOutcomeOf("dyk");
check("S3 dyk old strategy imported as archived method", Boolean(dykMethod));
let draftPinRejected = false;
let draftPinError = "";
if (dykMethod) {
  const dykScope = dykMethod.scope;
  const now = nowIso();
  sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('w6_task_dyk',?,?,?,'active',1,?,?)`)
    .run(dykScope.userId, dykScope.projectId, dykScope.instanceId, now, now);
  try {
    space.upsertTaskDependency({ scope: dykScope, taskId: "w6_task_dyk", kind: "method", refId: dykMethod.methodId, versionPolicy: "pinned", pinnedVersionId: dykMethod.methodVersionId, actor: "w6-rehearsal" });
  } catch (error) {
    draftPinRejected = true;
    draftPinError = (error).message;
  }
  check("S3 archived draft cannot pin as task dependency", draftPinRejected && /only formal versions resolve|VERSION_INVALID/.test(draftPinError), draftPinError);
}
const dykCore = inputs.ownerReviewQueue.find((e) => e.itemId === "dyk:liveProjectRoot:assets/migrated/knowledge/methods/fundamental.md");
check("S3 dyk core model discoverable in owner-review queue", Boolean(dykCore)
  && dykCore.adoptionConstraints.some((c) => c.startsWith("restore-candidate"))
  && dykCore.reconciliationTargets.includes("methods/core-company-qualification.md")
  && Boolean(dykCore.backupPath) && Boolean(dykCore.sha256), JSON.stringify(dykCore ?? null));
check("S3 dyk core not imported", !outcomes.some((o) => o.itemId === dykCore?.itemId));

// 6) run-basis：旧 default-load 关闭后，新对象经授权采用提供依赖。
const runBasisEvidence = { conversation: null, task: null, missingLedger: null };
if (mgMethod) {
  const mgScope = mgMethod.scope;
  const { approved, agent, bound } = await adoptFourFactor(mgScope, mgMethod);
  check("run-basis four-factor approved via owner path in isolated db", approved);
  const now = nowIso();
  sqlite.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at)
                  VALUES ('w6_conv',?,?,?,'invest-agent-mg','weixin','W6演练','',1,'active',?,?)`)
    .run(mgScope.userId, mgScope.projectId, mgScope.instanceId, now, now);
  const convBasis = space.assembleAndRecordRunBasis({ scope: mgScope, agentId: agent.agent_id, entryKind: "conversation", basisKey: "conversation:w6_conv:message:w6_msg", conversationId: "w6_conv", actor: "w6-rehearsal" });
  runBasisEvidence.conversation = {
    basisKey: convBasis.basisKey,
    methods: convBasis.resolution.methods.map((m) => ({ methodId: m.methodId, versionId: m.versionId, checksum: m.contentChecksum })),
    basisJsonHasNoLegacyPath: !JSON.stringify(convBasis).includes(backupRoot) && !JSON.stringify(convBasis).includes(w0Root),
  };
  check("run-basis conversation resolves four-factor", convBasis.resolution.methods.some((m) => m.methodId === mgMethod.methodId));
  check("run-basis basis carries no legacy workspace path", runBasisEvidence.conversation.basisJsonHasNoLegacyPath);

  sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('w6_task_ff',?,?,?,'active',1,?,?)`)
    .run(mgScope.userId, mgScope.projectId, mgScope.instanceId, now, now);
  sqlite.prepare(`INSERT INTO automation_task_revisions (revision_id,task_id,user_id,project_id,instance_id,revision,name,schedule_json,inputs_json,output_json,delivery_json,created_at)
                  VALUES ('w6_rev_ff','w6_task_ff',?,?,?,1,'W6四因子任务','{}','[]','{"mode":"agent"}','{}',?)`)
    .run(mgScope.userId, mgScope.projectId, mgScope.instanceId, now);
  sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                  VALUES ('w6_run_ff','w6_task_ff','w6_rev_ff',?,?,?,'manual','w6-idem',1,'succeeded',?,?,?,?)`)
    .run(mgScope.userId, mgScope.projectId, mgScope.instanceId, now, now, now, now);
  space.upsertTaskDependency({ scope: mgScope, taskId: "w6_task_ff", kind: "method", refId: mgMethod.methodId, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId, actor: "w6-rehearsal" });
  const taskBasis = space.assembleAndRecordRunBasis({ scope: mgScope, agentId: agent.agent_id, entryKind: "scheduled", basisKey: "run:w6_run_ff:basis", taskId: "w6_task_ff", runId: "w6_run_ff", actor: "w6-rehearsal" });
  runBasisEvidence.task = {
    basisKey: taskBasis.basisKey,
    methods: taskBasis.resolution.methods.map((m) => ({ methodId: m.methodId, versionId: m.versionId })),
  };
  check("run-basis task assembly closed to declared deps", taskBasis.resolution.methods.length === 1 && taskBasis.resolution.methods[0].methodId === mgMethod.methodId,
    JSON.stringify(taskBasis.resolution.methods.map((m) => m.methodId)));

  sqlite.prepare(`INSERT INTO automation_tasks (task_id,user_id,project_id,instance_id,status,current_revision,created_at,updated_at) VALUES ('w6_task_kp',?,?,?,'active',1,?,?)`)
    .run(mgScope.userId, mgScope.projectId, mgScope.instanceId, now, now);
  try {
    space.upsertTaskDependency({ scope: mgScope, taskId: "w6_task_kp", kind: "asset_input", refId: "asset_w6_missing_paper_ledger", versionPolicy: "pinned", pinnedVersionId: "version_w6_missing", actor: "w6-rehearsal" });
    check("S1 missing ledger must fail loudly", false, "dependency registration unexpectedly succeeded");
  } catch (error) {
    runBasisEvidence.missingLedger = { rejected: true, error: (error).message };
    check("S1 missing ledger fails loudly (no empty-position inference)", /not found/.test((error).message), (error).message);
  }
  const kpBasisRows = sqlite.prepare("SELECT COUNT(*) AS n FROM agent_space_run_basis WHERE basis_key LIKE '%w6_task_kp%' OR basis_key LIKE '%w6_run_kp%'").get().n;
  check("S1 KP task leaves no run basis", kpBasisRows === 0, `rows=${kpBasisRows}`);
  void bound;
}
writeJson(path.join(dir.runBasis, "run-basis-evidence.json"), { ...runBasisEvidence, note: "旧 default-load 关闭（隔离 workspace 根为空）；装配依赖全部来自导入对象经授权采用的版本。采用发生在隔离 DB，不代表生产采用。", generatedAt: nowIso() });

// 7) 汇总报告。
const failed = checks.filter((c) => !c.pass);
writeJson(path.join(outRoot, "report.json"), {
  phase: "import",
  selftest,
  isolated: true,
  note: "本报告为隔离迁移演练证据：隔离 DB/隔离项目/受控真实内容副本；未触碰生产 DB、真实 Workspace、微信或调度；不是生产切换。",
  environment: {
    DB_PATH: process.env.DB_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
    RUNTIME_DATA_ROOT: process.env.RUNTIME_DATA_ROOT, MASTRA_PROJECTS_ROOT: process.env.MASTRA_PROJECTS_ROOT,
  },
  counts: {
    autoItems: inputs.autoItems.length, staged: stagedIds.size,
    imported: outcomes.length, verifyChecked: verifyOutcomes.length,
    ownerReviewQueue: inputs.ownerReviewQueue.length,
  },
  snapshot: { path: snapshot, sha256: sha256Of(readFileSync(snapshot)) },
  checks,
  pass: failed.length === 0,
  generatedAt: nowIso(),
});
console.log(`w6-rehearsal import: ${failed.length === 0 ? "OK" : "FAILED"} (${checks.length - failed.length}/${checks.length} checks, imported=${outcomes.length})`);
process.exit(failed.length === 0 ? 0 : 1);

function sc(user) {
  const item = inputs.autoItems.find((i) => i.scope.userId === user) ?? outcomes.find((o) => o.scope.userId === user)?.scope;
  if (!item) return { userId: user, projectId: "invest-agent", instanceId: `invest-agent-${user}` };
  return "scope" in item ? item.scope : item;
}

/** 隔离 DB 内的授权采用演示：owner 路径 approve + adopt，再建 Agent 绑定。 */
async function adoptFourFactor(mgScope, mgMethod) {
  const { createAgent, bindMethod, approveMethodVersion } = space;
  await mastraWorkspaceRegistry.bootstrap(mgScope);
  let approved = false;
  try {
    approveMethodVersion({
      scope: mgScope, methodId: mgMethod.methodId, versionId: mgMethod.methodVersionId,
      approvedBy: "w6-rehearsal-owner", approvalRef: "owner-decision:w6-rehearsal-four-factor",
      ownerToken, adopt: true, actor: "w6-rehearsal",
    });
    approved = true;
  } catch (error) {
    check("adoptFourFactor approve", false, (error).message);
  }
  const agent = createAgent({ scope: mgScope, name: "W6 演练 Agent", actor: "w6-rehearsal" });
  space.setAgentStatus(mgScope, agent.agent_id, "active", "w6-rehearsal");
  let bound = null;
  if (approved) {
    bound = bindMethod({ scope: mgScope, agentId: agent.agent_id, methodId: mgMethod.methodId, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId, actor: "w6-rehearsal" });
  }
  return { approved, agent, bound };
}
