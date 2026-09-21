#!/usr/bin/env node
/**
 * W7 批次导入驱动（窗口日步骤 1b 核对 + 步骤 3-5；B1=mg）。
 *
 *   核对模式（默认，无写入目标库；步骤 1b staging 重核对）：
 *     node --import tsx scripts/agent-space/w7-import-batch.mjs \
 *       --w0-root .state/agent-space-w0-r2 --backup-root <灾备快照根> \
 *       --out-dir <报告目录> --scope-user mg
 *
 *   执行模式（步骤 3-5：导入/建 Agent/D 授权采用）：
 *     同上 + --confirm --target isolated|production --batch B1 \
 *          --manifest-sha256 <import-gate sha256> \
 *          [--adopt-item <method itemId>] [--owner-token-file <0600 文件>]
 *
 * 语义（W7 手册步骤 3-5）：
 *   - 门禁消费只处理该批次用户 autoImportable 份额（B1=mg 46 项）；
 *   - staging 实读快照字节、sha256 与 manifest 双核对，任何漂移/缺失=中止；
 *   - 导入幂等键 w6:<itemId>，全部 draft 归档态，不改既有行；
 *   - createAgent 幂等键 w7:<userId>:agent（active）+ applyDefaultSkillManifest；
 *   - --adopt-item 仅对已冻结 decided 的方法走 approve+adopt+bind（D1）。
 * 护栏：--target production 时拒绝 NODE_ENV=test；--scope-user 必须属于
 * --batch 用户集；manifest 指纹必须与 --w0-root 的 import-gate.json 一致；
 * owner token 只在 settings 缺失时写入，已存在且不同=中止。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const w0Root = argOf("w0-root");
const backupRoot = argOf("backup-root");
const outDir = argOf("out-dir");
const scopeUser = argOf("scope-user");
const confirm = args.includes("--confirm");
const target = argOf("target");
const batch = argOf("batch");
const manifestSha = argOf("manifest-sha256");
const adoptItem = argOf("adopt-item");
const ownerTokenFile = argOf("owner-token-file");
const BATCH_USERS = { B1: ["mg"], B2: ["dyk"], B3: ["111"] };
if (!w0Root || !backupRoot || !outDir || !scopeUser) {
  console.error("usage: w7-import-batch.mjs --w0-root <dir> --backup-root <snapshotRoot> --out-dir <dir> --scope-user <user> [--confirm --target isolated|production --batch B1|B2|B3 --manifest-sha256 <sha> [--adopt-item <itemId>] [--owner-token-file <file>]]");
  process.exit(2);
}
if (!process.env.DB_PATH) {
  console.error("refusing to run: DB_PATH not set (point at the target database explicitly)");
  process.exit(2);
}
if (confirm) {
  const missing = [];
  if (target !== "isolated" && target !== "production") missing.push("--target isolated|production");
  if (!BATCH_USERS[batch ?? ""]) missing.push("--batch B1|B2|B3");
  if (!manifestSha) missing.push("--manifest-sha256");
  if (missing.length) {
    console.error(`confirm requires target identity: missing ${missing.join(", ")}`);
    process.exit(2);
  }
  const actualSha = createHash("sha256").update(readFileSync(path.join(w0Root, "import-gate.json"))).digest("hex");
  if (actualSha !== manifestSha) {
    console.error(`manifest fingerprint mismatch: --manifest-sha256=${manifestSha} but ${w0Root}/import-gate.json is ${actualSha}`);
    process.exit(2);
  }
  if (!BATCH_USERS[batch].includes(scopeUser)) {
    console.error(`scope-user ${scopeUser} does not belong to batch ${batch} (${BATCH_USERS[batch].join(",")})`);
    process.exit(2);
  }
  if (target === "production" && process.env.NODE_ENV === "test") {
    console.error("refusing production write under NODE_ENV=test");
    process.exit(2);
  }
}
process.env.NODE_ENV ??= "test";
process.env.WORKSPACE_BACKEND ??= "mastra";

async function importAppModule(relative) {
  for (const base of ["../../src", "../../dist"]) {
    try {
      return await import(new URL(`${base}/${relative}`, import.meta.url).href);
    } catch { /* 尝试下一个基目录 */ }
  }
  throw new Error(`cannot resolve app module: ${relative}`);
}

mkdirSync(outDir, { recursive: true, mode: 0o700 });
const nowIso = () => new Date().toISOString();
const writeJson = (name, value) => writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 1), { mode: 0o600 });
const fail = (stage, detail) => {
  writeJson("batch-import-report.json", { stage, ok: false, detail, generatedAt: nowIso() });
  console.error(`ABORT at ${stage}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  process.exit(1);
};

const db = await importAppModule("db/index.js");
db.initDb();
const { sqlite } = db;
const space = await importAppModule("services/agent-space/index.js");

// ---------- 步骤 1b：门禁重验 + staging 字节核对（两种模式都做） ----------
const inputs = space.loadW0MigrationInputs(w0Root);
const userItems = inputs.autoItems.filter((i) => i.scope.userId === scopeUser);
if (userItems.length === 0) fail("gate", `no autoImportable items for ${scopeUser}`);
const unexpectedSkips = inputs.skipped.filter((s) => s.itemId?.startsWith(`${scopeUser}:`));
if (unexpectedSkips.length) fail("gate", `service-layer skips for ${scopeUser}: ${JSON.stringify(unexpectedSkips)}`);

const staged = space.stageMigrationCopies(userItems, backupRoot, path.join(outDir, "staging"));
const notStaged = staged.outcomes.filter((o) => o.status !== "staged");
if (notStaged.length) fail("staging", `hash drift / unreadable items (任何漂移=批次拦截): ${JSON.stringify(notStaged)}`);
writeJson("staging-check.json", { scopeUser, items: userItems.length, staged: staged.outcomes.length, outcomes: staged.outcomes, generatedAt: nowIso() });
console.log(`staging-check: ${staged.outcomes.length}/${userItems.length} staged (hash 双核对通过)`);

// ---------- 核对模式到此为止 ----------
if (!confirm) {
  writeJson("batch-import-report.json", { stage: "staging-check-only", ok: true, scopeUser, items: userItems.length, generatedAt: nowIso() });
  console.log("staging-check-only done (no target-db writes)");
  process.exit(0);
}

// ---------- 步骤 3：导入（draft 归档态，幂等） ----------
const scopeRow = userItems[0].scope;
// createUserAsset 落字节需要 scope 的注册项目根：生产由磁盘 manifest hydrate，
// 隔离库由 bootstrap 建骨架（既有目录时 bootstrap 只注册不覆写）。
const { mastraWorkspaceRegistry } = await importAppModule("mastra/workspace-registry.js");
const registeredRoot = await mastraWorkspaceRegistry.resolve(scopeRow).catch(() => undefined);
if (!registeredRoot) await mastraWorkspaceRegistry.bootstrap(scopeRow);

const imported = await space.importStagedMigration(userItems, staged.staged, path.join(outDir, "staging"));
if (imported.failures.length) fail("import", JSON.stringify(imported.failures));
const outcomes = imported.outcomes;
const preExisting = outcomes.filter((o) => o.idempotentReplay).length;
writeJson("import-outcomes.json", { outcomes, skipped: imported.skipped, idempotentReplayCount: preExisting, generatedAt: nowIso() });
console.log(`import: ${outcomes.length} items (${preExisting} replay), skipped=${imported.skipped.length}`);

// ---------- 步骤 4：Agent 与技能初始化（幂等） ----------
const existingAgent = sqlite
  .prepare("SELECT agent_id, status FROM agent_space_agents WHERE idempotency_key=?")
  .get(`w7:${scopeUser}:agent`);
const agent = existingAgent
  ? { agent_id: existingAgent.agent_id, reused: true }
  : space.createAgent({ scope: scopeRow, name: `W7 ${scopeUser} Agent`, idempotencyKey: `w7:${scopeUser}:agent`, actor: "w7-cutover" });
const agentStatusRow = sqlite.prepare("SELECT status FROM agent_space_agents WHERE agent_id=?").get(agent.agent_id);
if (agentStatusRow.status !== "active") space.setAgentStatus(scopeRow, agent.agent_id, "active", "w7-cutover");
const manifestApplied = space.applyDefaultSkillManifest({ scope: scopeRow, agentId: agent.agent_id, actor: "w7-cutover" });

// ---------- 步骤 5：授权采用（仅显式 --adopt-item，对应已冻结 decided 项；幂等） ----------
let adoption = { attempted: false };
if (adoptItem) {
  adoption.attempted = true;
  const methodOutcome = outcomes.find((o) => o.itemId === adoptItem && o.objectType === "method");
  if (!methodOutcome) fail("adopt", `adopt-item ${adoptItem} not an imported method outcome`);
  // owner token：settings 缺失才写入；已存在且不同=中止。
  let ownerToken = null;
  if (ownerTokenFile) {
    ownerToken = readFileSync(ownerTokenFile, "utf8").trim();
    const current = sqlite.prepare("SELECT value FROM settings WHERE key='agent_space.owner_admin_token'").get();
    if (!current) {
      sqlite.prepare("INSERT INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(ownerToken);
    } else if (current.value !== ownerToken) {
      fail("adopt", "settings 已存在不同的 agent_space.owner_admin_token（拒绝覆盖；核对窗口令牌来源）");
    }
  } else {
    ownerToken = sqlite.prepare("SELECT value FROM settings WHERE key='agent_space.owner_admin_token'").get()?.value ?? null;
    if (!ownerToken) fail("adopt", "settings 无 owner token 且未提供 --owner-token-file（首次采用必须显式提供）");
  }
  const versionRow = sqlite.prepare("SELECT status FROM agent_space_method_versions WHERE version_id=?").get(methodOutcome.methodVersionId);
  const methodRow = sqlite.prepare("SELECT current_version_id FROM agent_space_methods WHERE method_id=?").get(methodOutcome.methodId);
  const alreadyAdopted = versionRow?.status === "approved" && methodRow?.current_version_id === methodOutcome.methodVersionId;
  if (!alreadyAdopted) {
    space.approveMethodVersion({
      scope: scopeRow, methodId: methodOutcome.methodId, versionId: methodOutcome.methodVersionId,
      approvedBy: "w7-cutover-owner", approvalRef: `owner-decision:W7-${batch}-${adoptItem}`, ownerToken, adopt: true, actor: "w7-cutover",
    });
  }
  const adopted = sqlite.prepare("SELECT current_version_id FROM agent_space_methods WHERE method_id=?").get(methodOutcome.methodId);
  const existingBinding = sqlite
    .prepare("SELECT pinned_version_id FROM agent_space_agent_method_bindings WHERE agent_id=? AND method_id=?")
    .get(agent.agent_id, methodOutcome.methodId);
  if (!existingBinding || existingBinding.pinned_version_id !== adopted.current_version_id) {
    space.bindMethod({ scope: scopeRow, agentId: agent.agent_id, methodId: methodOutcome.methodId, versionPolicy: "pinned", pinnedVersionId: adopted.current_version_id, actor: "w7-cutover" });
  }
  adoption = { attempted: true, itemId: adoptItem, methodId: methodOutcome.methodId, adoptedVersionId: adopted.current_version_id, checksum: methodOutcome.sourceHash, approvalRef: `owner-decision:W7-${batch}-${adoptItem}`, alreadyAdopted };
}

// ---------- 逐项核对（只读；跨 scope 反例由 outsider scope 断言） ----------
// adopt-item 在步骤 5 已 approve+adopt，其方法版本合法脱离 draft 归档态
//（archivedMethodState=false 且为 current）；其余 method 必须仍为归档 draft。
const outsider = { userId: `w7b-outsider-${scopeUser}`, projectId: scopeRow.projectId, instanceId: `${scopeRow.instanceId}-out` };
const verify = await space.verifyMigrationImport(outcomes, outsider);
const badVerify = verify.filter((v) => {
  const baseOk = v.scopeOk && v.storedHashMatchesSource && v.sameScopeReadable && v.crossScopeRejected;
  const methodStateOk = adoptItem && v.itemId === adoptItem ? v.archivedMethodState === false : (v.archivedMethodState === null || v.archivedMethodState === true);
  return !(baseOk && methodStateOk);
});
if (badVerify.length) fail("verify", JSON.stringify(badVerify));
writeJson("verify-outcomes.json", { verify, generatedAt: nowIso() });

writeJson("batch-import-report.json", {
  stage: "complete", ok: true, target, batch, scopeUser,
  counts: { imported: outcomes.length, idempotentReplay: preExisting, verifyChecked: verify.length },
  agent: { agentId: agent.agent_id, reused: Boolean(agent.reused), defaultSkillManifest: { applied: manifestApplied.appliedInstallationIds.length, alreadyInitialized: manifestApplied.alreadyInitialized } },
  adoption,
  manifestSha256: manifestSha,
  generatedAt: nowIso(),
});
console.log(`batch-import complete: imported=${outcomes.length} agent=${agent.agent_id}${adoptItem ? ` adopted=${adoptItem}` : ""}`);
process.exit(0);
