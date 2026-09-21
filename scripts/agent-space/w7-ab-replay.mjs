#!/usr/bin/env node
/**
 * T-530 / W7 前置：真实用户数据隔离回放与新旧装配 A/B 验证。
 *
 * 用法（环境必须全部指向隔离目录，脚本不复用任何生产路径）：
 *   RUN=.state/agent-space-w7-replay/<runTs> && mkdir -p $RUN/isolated/{workspaces,projects,templates,runtime}
 *   DB_PATH=$RUN/isolated/w7ab.db WORKSPACE_ROOT=$RUN/isolated/workspaces \
 *   RUNTIME_DATA_ROOT=$RUN/isolated/runtime MASTRA_PROJECTS_ROOT=$RUN/isolated/projects \
 *   SYSTEM_SKILLS_TEMPLATE_ROOT=$RUN/isolated/templates NODE_ENV=test WORKSPACE_BACKEND=mastra \
 *   node --import tsx scripts/agent-space/w7-ab-replay.mjs \
 *     --w0-root .state/agent-space-w0-r2 \
 *     --backup-root <灾备快照根> --out-root $RUN [--users mg,dyk,111]
 *
 * 纪律（任务契约）：
 * - 数据源=灾备快照（真实历史数据的受控副本）+ W0 r2 清单；快照 DB 以
 *   readonly 打开，只 SELECT；快照目录零写入。
 * - 全程隔离 DB/隔离项目根/隔离 workspace 根（保持为空）；模型经本地假网关，
 *   投递经注入的假 sender——不连接生产 DB、不发送真实消息、不改真实 Workspace。
 * - 报告只存路径/ID/hash/计数与标记位，不落用户正文（方法/报告正文只以
 *   checksum+字符数呈现）。
 * - 任何 Unknown 不写成通过；失败检查如实 FAIL。
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const w0Root = argOf("w0-root");
const backupRoot = argOf("backup-root");
const outRoot = argOf("out-root");
const users = (argOf("users") ?? "mg,dyk,111").split(",").map((s) => s.trim()).filter(Boolean);
if (!w0Root || !backupRoot || !outRoot) {
  console.error("usage: w7-ab-replay.mjs --w0-root <dir> --backup-root <snapshotRoot> --out-root <dir> [--users mg,dyk,111]");
  process.exit(2);
}
for (const [name, value] of Object.entries({ DB_PATH: process.env.DB_PATH, WORKSPACE_ROOT: process.env.WORKSPACE_ROOT, RUNTIME_DATA_ROOT: process.env.RUNTIME_DATA_ROOT, MASTRA_PROJECTS_ROOT: process.env.MASTRA_PROJECTS_ROOT })) {
  if (!value) {
    console.error(`refusing to run: env ${name} not set (replay must point at isolated dirs)`);
    process.exit(2);
  }
}
// 红线自检：装配开关不得由外部带入（脚本按 A/B 逐轮显式设置）。
if (process.env.AGENT_SPACE_ASSEMBLY_MODE) {
  console.error("refusing to run: AGENT_SPACE_ASSEMBLY_MODE is set externally; unset it (script controls A/B per turn)");
  process.exit(2);
}
process.env.NODE_ENV ??= "test";
process.env.WORKSPACE_BACKEND ??= "mastra";

const sha256Of = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nowIso = () => new Date().toISOString();
mkdirSync(outRoot, { recursive: true, mode: 0o700 });
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 1), { mode: 0o600 });
};
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null });
  if (!pass) console.error(`FAIL ${name}: ${detail ?? ""}`);
};
const blockers = [];
const blocker = (text) => blockers.push(text);

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

const snapshotDbPath = path.join(backupRoot, "databases", "runtime.db");
const snapshotProjectRoot = path.join(backupRoot, "runtime-data", "projects");
const manifest = JSON.parse(readFileSync(path.join(w0Root, "manifest.json"), "utf8"));
const importGateSha = sha256Of(readFileSync(path.join(w0Root, "import-gate.json")));
const gate = JSON.parse(readFileSync(path.join(w0Root, "import-gate.json"), "utf8"));

const userProjectDir = {};
for (const u of users) {
  const root = manifest.users[u]?.sources?.liveProjectRoot?.root;
  if (!root) { console.error(`manifest missing liveProjectRoot for ${u}`); process.exit(2); }
  userProjectDir[u] = path.basename(root);
}
writeJson(path.join(outRoot, "00-inputs", "input-facts.json"), {
  w0Root, backupRoot, importGateSha256: importGateSha,
  snapshotRuntimeDb: { path: snapshotDbPath, sha256: sha256Of(readFileSync(snapshotDbPath)) },
  snapshotProjectRoot,
  userProjectDir,
  generatedAt: nowIso(),
  note: "快照 DB 全程 readonly 打开；快照目录零写入。",
});

// ---------- 0) 快照 DB（readonly）事实提取 ----------
const { default: Database } = await import("better-sqlite3");
const snap = new Database(snapshotDbPath, { readonly: true });
snap.pragma("query_only = ON");
const realTasks = {};   // u -> rows(task+current revision)
const realAssets = {};  // u -> Set(assetId)
const revisionTexts = [];
const bindingsCols = snap.pragma("table_info(automation_task_asset_bindings)").map((c) => c.name);
const assetBindingRows = snap.prepare(
  `SELECT * FROM automation_task_asset_bindings WHERE user_id IN (${users.map(() => "?").join(",")})`,
).all(...users);
for (const u of users) {
  const rows = snap.prepare(
    `SELECT t.*, r.revision_id AS rev_revision_id, r.name AS rev_name, r.description AS rev_description,
            r.schedule_json, r.instruction, r.inputs_json, r.output_json, r.delivery_json,
            r.source_asset_id, r.working_asset_id
     FROM automation_tasks t JOIN automation_task_revisions r ON r.task_id=t.task_id AND r.revision=t.current_revision
     WHERE t.user_id=? AND t.status='active' ORDER BY t.task_id`,
  ).all(u);
  realTasks[u] = rows;
  const assetIds = new Set();
  for (const r of rows) {
    revisionTexts.push({ user: u, taskId: r.task_id, taskType: r.task_type, name: r.rev_name, description: r.rev_description, instruction: r.instruction, inputsJson: r.inputs_json, outputJson: r.output_json, deliveryJson: r.delivery_json });
    if (r.source_asset_id) assetIds.add(r.source_asset_id);
    if (r.working_asset_id) assetIds.add(r.working_asset_id);
    for (const field of [r.inputs_json, r.output_json]) {
      try {
        const parsed = JSON.parse(field ?? "null");
        const visit = (v) => {
          if (Array.isArray(v)) { v.forEach(visit); return; }
          if (v && typeof v === "object") {
            for (const [k, val] of Object.entries(v)) {
              if (/asset/i.test(k) && typeof val === "string" && val.startsWith("asset_")) assetIds.add(val);
              else visit(val);
            }
          }
        };
        visit(parsed);
      } catch { /* 非 JSON 文本按原样参与引用扫描 */ }
    }
  }
  for (const b of assetBindingRows.filter((b) => b.user_id === u)) {
    for (const c of bindingsCols) if (/asset/i.test(c) && typeof b[c] === "string" && b[c].startsWith("asset_")) assetIds.add(b[c]);
  }
  realAssets[u] = assetIds;
}
const snapCounts = {};
for (const u of users) {
  snapCounts[u] = { activeTasks: realTasks[u].length, referencedAssets: realAssets[u].size };
}
// 快照 DB 保持打开（readonly）：2b 行复制与资产核验继续 SELECT；结尾统一 close。

// ---------- 1) 旧侧（A）准备：真实 liveProjectRoot 树复制 + 装配面清点 ----------
const oldSide = {};
const skillMeta = {}; // u -> [{skillDir, name, descriptionChars}]
for (const u of users) {
  const srcDir = path.join(snapshotProjectRoot, userProjectDir[u]);
  check(`snapshot-project-dir-exists ${u}`, existsSync(srcDir), srcDir);
  const digestDir = path.join(process.env.MASTRA_PROJECTS_ROOT, userProjectDir[u]);
  cpSync(srcDir, digestDir, { recursive: true });
  // 清点：按顶层类别统计 + 全路径清单（相对路径）
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else files.push(relPath);
    }
  };
  walk(digestDir, "");
  const byTop = {};
  for (const f of files) {
    const top = f.includes("/") ? f.slice(0, f.indexOf("/")) : "(root)";
    byTop[top] = (byTop[top] ?? 0) + 1;
  }
  // default-load 元数据面：skills/*/SKILL.md frontmatter（W0 结论：旧模式每轮注入技能元数据）
  const skills = [];
  for (const f of files.filter((p) => /^skills\/[^/]+\/SKILL\.md$/.test(p))) {
    const text = readFileSync(path.join(digestDir, f), "utf8");
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    const field = (key) => fm?.[1].split("\n").find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? null;
    skills.push({ path: f, name: field("name"), descriptionChars: field("description")?.length ?? 0, fileSha256: sha256Of(readFileSync(path.join(digestDir, f))), chars: text.length });
  }
  skillMeta[u] = skills;
  const manifestCount = manifest.users[u].sources.liveProjectRoot.fileCount;
  const manifestPaths = new Set(manifest.users[u].items.filter((i) => i.source === "liveProjectRoot").map((i) => i.path));
  const missingFromCopy = [...manifestPaths].filter((p) => !files.includes(p));
  const knownUnbacked = missingFromCopy.filter((p) => /logs_2\.sqlite(-shm|-wal)?$/.test(p));
  const unexpectedMissing = missingFromCopy.filter((p) => !/logs_2\.sqlite(-shm|-wal)?$/.test(p));
  check(`oldside-copy-covers-manifest ${u}`, unexpectedMissing.length === 0,
    `copy=${files.length} manifest=${manifestCount} missing=${missingFromCopy.length} (known logs_2 WAL 无备份=${knownUnbacked.length}) unexpected=${JSON.stringify(unexpectedMissing)}`);
  const filesOnlyInCopy = files.filter((p) => !manifestPaths.has(p)).length;
  oldSide[u] = { projectDir: userProjectDir[u], fileCount: files.length, manifestFileCount: manifestCount, missingFromCopy: missingFromCopy.length, knownUnbackedLogs2: knownUnbacked.length, filesOnlyInCopy, byTop, skillMetadataCount: skills.length, filesSorted: [...files].sort() };
  writeJson(path.join(outRoot, "01-old-side", `inventory-${u}.json`), { ...oldSide[u], skills, generatedAt: nowIso() });
}

// ---------- 2) 新侧（B）准备：隔离 DB 初始化 + W6 导入 + 冻结决策 ----------
const db = await importAppModule("db/index.js");
db.initDb();
const { sqlite } = db;
const ownerToken = `w7ab-${randomUUID()}`;
sqlite.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('agent_space.owner_admin_token', ?)").run(ownerToken);
const { mastraWorkspaceRegistry } = await importAppModule("mastra/workspace-registry.js");
const space = await importAppModule("services/agent-space/index.js");
const automation = await importAppModule("services/automation-tasks.js");
const runner = await importAppModule("services/generic-automation-runner.js");
const userAssets = await importAppModule("services/user-assets.js");

const scopeOf = (u) => ({ userId: u, projectId: "invest-agent", instanceId: `invest-agent-${u}` });

// 2a) W6 导入（真实清单 → 隔离 DB，归档态）
const inputs = space.loadW0MigrationInputs(w0Root);
const scopedUsers = new Set(users);
const autoItems = inputs.autoItems.filter((i) => scopedUsers.has(i.scope.userId));
check("gate-recheck no unexpected skips (scoped users)", inputs.skipped.filter((s) => !s.itemId || scopedUsers.has(s.itemId.split(":")[0])).length === 0,
  JSON.stringify(inputs.skipped));
const staged = space.stageMigrationCopies(autoItems, backupRoot, path.join(outRoot, "02-new-side", "01-isolated-copy"));
const imported = await space.importStagedMigration(autoItems.filter((i) => staged.outcomes.some((o) => o.itemId === i.itemId && o.status === "staged")), staged.staged, path.join(outRoot, "02-new-side", "01-isolated-copy"));
check("import no failures", imported.failures.length === 0, JSON.stringify(imported.failures));
const importOutcomes = imported.outcomes;
writeJson(path.join(outRoot, "02-new-side", "02-import-result", "import-outcomes.json"), { outcomes: importOutcomes, skipped: imported.skipped, generatedAt: nowIso() });

// 2b) 复制真实任务/revision/绑定/资产行（真实历史数据进隔离 DB）
const copyRows = (table, where, params) => {
  const cols = snap.pragma(`table_info(${table})`).map((c) => c.name);
  const rows = snap.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM ${table} WHERE ${where}`).all(...params);
  const insert = sqlite.prepare(`INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  const tx = sqlite.transaction((rs) => { for (const r of rs) insert.run(...cols.map((c) => r[c])); });
  tx(rows);
  return rows.length;
};
for (const u of users) {
  const taskIds = realTasks[u].map((t) => t.task_id);
  const nTasks = copyRows("automation_tasks", `user_id=? AND task_id IN (${taskIds.map(() => "?").join(",")})`, [u, ...taskIds]);
  const nRevs = copyRows("automation_task_revisions", `user_id=? AND task_id IN (${taskIds.map(() => "?").join(",")})`, [u, ...taskIds]);
  const assetIds = [...realAssets[u]];
  const nAssets = assetIds.length ? copyRows("user_assets", `user_id=? AND asset_id IN (${assetIds.map(() => "?").join(",")})`, [u, ...assetIds]) : 0;
  const nVersions = assetIds.length ? copyRows("user_asset_versions", `user_id=? AND asset_id IN (${assetIds.map(() => "?").join(",")})`, [u, ...assetIds]) : 0;
  check(`real-rows-copied ${u}`, nTasks === realTasks[u].length && nRevs >= realTasks[u].length,
    `tasks=${nTasks}/${realTasks[u].length} revisions=${nRevs} assets=${nAssets} versions=${nVersions}`);
}
copyRows("automation_task_asset_bindings", `user_id IN (${users.map(() => "?").join(",")})`, [...users]);

// 2c) 冻结决策 D1–D7 落隔离库（只做 decided 项）
const decisions = { applied: [], assertions: [] };
const agents = {};
for (const u of users) {
  const scope = scopeOf(u);
  agents[u] = space.createAgent({ scope, name: `W7AB ${u} Agent`, idempotencyKey: `w7:${u}:agent`, actor: "w7-ab-replay" });
  space.setAgentStatus(scope, agents[u].agent_id, "active", "w7-ab-replay");
  const manifestApplied = space.applyDefaultSkillManifest({ scope, agentId: agents[u].agent_id, actor: "w7-ab-replay" });
  decisions.applied.push({ user: u, agentId: agents[u].agent_id, defaultSkillManifest: { applied: manifestApplied.appliedInstallationIds.length, alreadyInitialized: manifestApplied.alreadyInitialized } });
}
// D1：mg 四因子 approve+adopt + Agent 绑定 + 方法消费任务 pin（真实任务 at_d64649ad）
let mgMethod = null;
if (users.includes("mg")) {
  mgMethod = importOutcomes.find((o) => o.scope.userId === "mg" && o.objectType === "method") ?? null;
  check("D1 mg four-factor imported as method", Boolean(mgMethod));
  if (mgMethod) {
    const scope = scopeOf("mg");
    space.approveMethodVersion({ scope, methodId: mgMethod.methodId, versionId: mgMethod.methodVersionId, approvedBy: "w7-ab-replay-owner", approvalRef: "owner-decision:W7-D1", ownerToken, adopt: true, actor: "w7-ab-replay" });
    space.bindMethod({ scope, agentId: agents.mg.agent_id, methodId: mgMethod.methodId, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId, actor: "w7-ab-replay" });
    const consumerTask = realTasks.mg.find((t) => t.task_id === "at_d64649ad-d96f-447b-a462-91d89c01de5d");
    check("D1 consumer task present in real data", Boolean(consumerTask), "at_d64649ad missing from snapshot active tasks");
    if (consumerTask) {
      space.upsertTaskDependency({ scope, taskId: consumerTask.task_id, kind: "method", refId: mgMethod.methodId, versionPolicy: "pinned", pinnedVersionId: mgMethod.methodVersionId, actor: "w7-ab-replay" });
      decisions.applied.push({ user: "mg", decision: "D1", action: "approve+adopt+bind+pin-at_d64649ad", methodId: mgMethod.methodId, versionId: mgMethod.methodVersionId });
    }
  }
}
// D2/D3：mg strategy 与旧 KP 不得进入运行对象（owner-review 队列可发现）
if (users.includes("mg")) {
  const mgMethods = space.listMigrationMethods(scopeOf("mg")).map((m) => m.methodId);
  decisions.assertions.push({ decision: "D2/D3", mgMethodCount: mgMethods.length, onlyFourFactor: mgMethods.length === 1 });
  check("D2/D3 mg has exactly one method (four-factor)", mgMethods.length === 1 && Boolean(mgMethod) && mgMethods[0] === mgMethod.methodId);
  const strategy = inputs.ownerReviewQueue.find((e) => e.itemId.startsWith("mg:") && e.itemId.includes("strategy"));
  check("D2 mg strategy discoverable in owner-review queue", Boolean(strategy), "mg strategy not in queue");
}
// D4/D5：dyk 策略归档不采用；核心模型不导入但可发现
if (users.includes("dyk")) {
  const dykMethod = importOutcomes.find((o) => o.scope.userId === "dyk" && o.objectType === "method") ?? null;
  check("D4 dyk strategy imported as archived method", Boolean(dykMethod));
  if (dykMethod) {
    const v = space.getMigrationMethodVersion(scopeOf("dyk"), dykMethod.methodVersionId);
    check("D4 dyk strategy stays draft archived (not adopted)", v.status === "draft" && v.origin === "migration");
  }
  const core = inputs.ownerReviewQueue.find((e) => e.itemId.startsWith("dyk:") && e.itemId.includes("fundamental.md"));
  check("D5 dyk core model discoverable but not imported", Boolean(core) && !importOutcomes.some((o) => o.itemId === core.itemId));
}
// D6：111 无方法上下文（全部 data_asset）
if (users.includes("111")) {
  const u111Methods = space.listMigrationMethods(scopeOf("111"));
  check("D6 111 has no method (empty context is decided)", u111Methods.length === 0, JSON.stringify(u111Methods.map((m) => m.name)));
}
writeJson(path.join(outRoot, "02-new-side", "03-decisions", "decisions.json"), { ...decisions, source: "docs/agent-space-execution/W7-decisions.md (D1-D7 decided 2026-09-21)", generatedAt: nowIso() });

// ---------- 3) 会话装配 basis（服务层；真实 scope + 导入对象 + 冻结决策） ----------
const conversationBasis = {};
for (const u of users) {
  const scope = scopeOf(u);
  const now = nowIso();
  sqlite.prepare(`INSERT INTO conversation_sessions (conversation_id,user_id,project_id,instance_id,assistant_id,channel,title,last_message_preview,message_count,status,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`w7ab_conv_${u}`, scope.userId, scope.projectId, scope.instanceId, `invest-agent-${u}`, "weixin", "W7AB回放", "", 1, "active", now, now);
  const basis = space.assembleAndRecordRunBasis({ scope, agentId: agents[u].agent_id, entryKind: "conversation", basisKey: `conversation:w7ab_conv_${u}:message:w7ab_msg_${u}`, conversationId: `w7ab_conv_${u}`, actor: "w7-ab-replay" });
  const basisStr = JSON.stringify(basis);
  conversationBasis[u] = {
    basisKey: basis.basisKey,
    methods: basis.resolution.methods.map((m) => ({ methodId: m.methodId, versionId: m.versionId, checksum: m.contentChecksum, origin: m.origin })),
    skills: basis.resolution.skills.map((s) => ({ skillId: s.skillId, versionId: s.versionId })),
    statePacket: { included: basis.resolution.statePacket.entries.length, scanned: basis.resolution.statePacket.retrieval.scanned },
    skipped: basis.resolution.skipped,
    noLegacyPath: !basisStr.includes(backupRoot) && !basisStr.includes(w0Root),
  };
  check(`conversation-basis no legacy path ${u}`, conversationBasis[u].noLegacyPath);
}
check("conversation-basis mg resolves four-factor (D1)", !users.includes("mg") || (mgMethod && conversationBasis.mg.methods.some((m) => m.methodId === mgMethod.methodId && m.checksum === mgMethod.sourceHash)));
for (const u of users.filter((x) => x !== "mg")) {
  check(`conversation-basis ${u} methods empty (decided expectation)`, conversationBasis[u].methods.length === 0, JSON.stringify(conversationBasis[u].methods));
}

// ---------- 3b) mg 四因子真实消费任务（at_d64649ad）装配级回放（scheduled 入口） ----------
const consumerBasis = { attempted: false };
if (users.includes("mg") && mgMethod) {
  consumerBasis.attempted = true;
  const scope = scopeOf("mg");
  const now = nowIso();
  sqlite.prepare(`INSERT INTO automation_task_runs (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,attempt,status,claimed_at,started_at,created_at,updated_at)
                  VALUES ('w7ab_run_mg_ff','at_d64649ad-d96f-447b-a462-91d89c01de5d',(SELECT revision_id FROM automation_task_revisions WHERE task_id='at_d64649ad-d96f-447b-a462-91d89c01de5d' AND revision=(SELECT current_revision FROM automation_tasks WHERE task_id='at_d64649ad-d96f-447b-a462-91d89c01de5d')),'mg',?,?,'manual','w7ab-ff-idem',1,'succeeded',?,?,?,?)`)
    .run(scope.projectId, scope.instanceId, now, now, now, now);
  const basis = space.assembleAndRecordRunBasis({ scope, agentId: agents.mg.agent_id, entryKind: "scheduled", basisKey: "run:w7ab_run_mg_ff:basis", taskId: "at_d64649ad-d96f-447b-a462-91d89c01de5d", runId: "w7ab_run_mg_ff", actor: "w7-ab-replay" });
  consumerBasis.basisKey = basis.basisKey;
  consumerBasis.entryKind = "scheduled";
  consumerBasis.methods = basis.resolution.methods.map((m) => ({ methodId: m.methodId, versionId: m.versionId, checksum: m.contentChecksum, origin: m.origin }));
  consumerBasis.closedToDeclaredDeps = basis.resolution.methods.length === 1 && basis.resolution.methods[0].methodId === mgMethod.methodId;
  consumerBasis.noLegacyPath = !JSON.stringify(basis).includes(backupRoot) && !JSON.stringify(basis).includes(w0Root);
  check("consumer task basis closed to pinned four-factor", consumerBasis.closedToDeclaredDeps, JSON.stringify(consumerBasis.methods));
  check("consumer task basis no legacy path", consumerBasis.noLegacyPath);
}

// ---------- 4) A/B 真实任务运行回放（假网关；A=旧装配 off，B=装配 on） ----------
const captures = []; // {matchedTaskIds, systemChars, systemSha256, tools, markers}（system 全文不落盘）
const allSkillNames = new Set(Object.values(skillMeta).flat().map((s) => s.name).filter(Boolean));
const failMarkerTaskId = users.includes("mg") ? "migrated_scheduled-weekly-review_c023418f" : null;
// 失败反例用状态开关而非文本标记：提示上下文会携带任务目录（其他任务请求体里也
// 含 weekly-review 的 taskId），文本标记会误伤全部回放轮次。
let failureModeActive = false;
const server = http.createServer((request, response) => {
  let requestBody = "";
  request.on("data", (chunk) => { requestBody += chunk.toString(); });
  request.on("end", () => {
    let body;
    try { body = JSON.parse(requestBody); } catch { body = {}; }
    const text = JSON.stringify(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const tools = (Array.isArray(body.tools) ? body.tools : [])
      .map((t) => t?.function?.name ?? t?.name).filter(Boolean);
    const skillNameHits = {};
    for (const name of allSkillNames) {
      const n = system.split(name).length - 1;
      if (n > 0) skillNameHits[name] = n;
    }
    captures.push({
      at: nowIso(),
      matchedTaskIds: users.flatMap((u) => realTasks[u].map((t) => t.task_id)).filter((id) => text.includes(id)),
      systemChars: system.length,
      systemSha256: sha256Of(Buffer.from(system, "utf8")),
      toolNames: [...new Set(tools)],
      workspaceToolCount: tools.filter((n) => String(n).startsWith("mastra_workspace_")).length,
      markerAgentSpace: system.includes("Agent Space 装配"),
      markerFourFactor: system.includes("控盘度综合评分"),
      skillNameHits,
      skillMetadataHitCount: Object.values(skillNameHits).reduce((a, b) => a + b, 0),
    });
    if (failureModeActive) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "replay gateway outage (failure counterexample)" } }));
      return;
    }
    // 复盘类任务（scheduled-*-review）有产物发布不变量：必须真实调用 reviews.save
    // 且服务端回读到 artifact 后 run 才成功。假模型第一步回工具调用（真实工具在
    // 隔离 DB 执行），第二步收到工具结果后回最终 JSON。
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const hasToolResult = msgs.some((m) => m && m.role === "tool");
    const isDailyReview = text.includes("自动日复盘");
    if (isDailyReview && !hasToolResult) {
      const toolArgs = JSON.stringify({
        kind: "daily",
        content: "# W7AB 隔离回放日复盘\n\n- 隔离环境装配验证（非真实投研内容）\n- A/B 回放产物发布链验证\n",
        pushBrief: "**W7AB 回放**\n隔离环境验证简报。",
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: {"id":"w7ab","object":"chat.completion.chunk","created":1,"model":"w7ab-test","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"w7ab_call_review","type":"function","function":{"name":"reviews.save","arguments":${JSON.stringify(toolArgs)}}}]},"finish_reason":null}]}\n\n`);
      response.write('data: {"id":"w7ab","object":"chat.completion.chunk","created":1,"model":"w7ab-test","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }
    const payload = JSON.stringify({ summary: "W7AB 回放验证摘要", shouldNotify: true });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: {"id":"w7ab","object":"chat.completion.chunk","created":1,"model":"w7ab-test","choices":[{"index":0,"delta":{"content":${JSON.stringify(payload)}},"finish_reason":null}]}\n\n`);
    response.write('data: {"id":"w7ab","object":"chat.completion.chunk","created":1,"model":"w7ab-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n');
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const previousEnv = { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, OPENAI_API_KEY: process.env.OPENAI_API_KEY, MASTRA_DEFAULT_MODEL: process.env.MASTRA_DEFAULT_MODEL };
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
process.env.OPENAI_API_KEY = "w7ab-test-key";
process.env.MASTRA_DEFAULT_MODEL = "w7ab-test-model";

const runEvidence = { A: {}, B: {}, failure: null };
const outcomeKindsOf = (runId) =>
  (sqlite.prepare("SELECT kind FROM agent_space_run_outcomes WHERE run_id=? ORDER BY rowid").all(runId)).map((r) => r.kind);
const basisRowOf = (runId) => sqlite.prepare("SELECT basis_key, basis_json, injection_json FROM agent_space_run_basis WHERE basis_key LIKE ?").get(`%run:${runId}:basis`);

const dailyTaskOf = (u) => realTasks[u].find((t) => t.task_type === "scheduled-daily-review") ?? realTasks[u].find((t) => /^migrated_scheduled-daily-review/.test(t.task_id));

for (const u of users) {
  const task = dailyTaskOf(u);
  check(`daily-review-task-found ${u}`, Boolean(task), JSON.stringify(realTasks[u].map((t) => t.task_id)));
  if (!task) continue;
  const scope = scopeOf(u);

  // ---- A：旧装配（off）----
  delete process.env.AGENT_SPACE_ASSEMBLY_MODE;
  const before = captures.length;
  const runA = await runner.runGenericAutomationTaskNow({ scope, taskId: task.task_id, origin: "manual", idempotencyKey: `w7ab-${u}-a-${randomUUID().slice(0, 8)}` });
  const capA = captures[captures.length - 1];
  const basisA = runA.run.runId ? basisRowOf(runA.run.runId) : undefined;
  runEvidence.A[u] = {
    taskId: task.task_id, runId: runA.run.runId, status: runA.run.status,
    modelCalls: captures.length - before,
    systemChars: capA?.systemChars ?? null, systemSha256: capA?.systemSha256 ?? null,
    toolCount: capA?.toolNames.length ?? null, toolNames: capA?.toolNames ?? null,
    workspaceToolCount: capA?.workspaceToolCount ?? null,
    markerAgentSpace: capA?.markerAgentSpace ?? null, markerFourFactor: capA?.markerFourFactor ?? null,
    skillMetadataHitCount: capA?.skillMetadataHitCount ?? null, skillNameHits: capA?.skillNameHits ?? null,
    runBasisRecorded: Boolean(basisA),
    outcomes: outcomeKindsOf(runA.run.runId),
  };
  check(`A run succeeded ${u}`, runA.run.status === "succeeded", JSON.stringify({ status: runA.run.status }));
  check(`A run leaves no run basis ${u}`, !basisA, "旧装配模式下不应产生 agent-space run basis");

  // ---- B：新装配（scope:<u>）----
  process.env.AGENT_SPACE_ASSEMBLY_MODE = `scope:${u}`;
  const beforeB = captures.length;
  let runB;
  try {
    runB = await runner.runGenericAutomationTaskNow({ scope, taskId: task.task_id, origin: "manual", idempotencyKey: `w7ab-${u}-b-${randomUUID().slice(0, 8)}` });
  } finally {
    delete process.env.AGENT_SPACE_ASSEMBLY_MODE;
  }
  const capB = captures[captures.length - 1];
  const basisB = runB.run.runId ? basisRowOf(runB.run.runId) : undefined;
  const basisJson = basisB ? JSON.parse(basisB.basis_json) : null;
  const injection = basisB?.injection_json ? JSON.parse(basisB.injection_json) : null;
  const lastInjection = Array.isArray(injection) ? injection[injection.length - 1] : injection;
  runEvidence.B[u] = {
    taskId: task.task_id, runId: runB.run.runId, status: runB.run.status,
    modelCalls: captures.length - beforeB,
    systemChars: capB?.systemChars ?? null, systemSha256: capB?.systemSha256 ?? null,
    toolCount: capB?.toolNames.length ?? null, toolNames: capB?.toolNames ?? null,
    workspaceToolCount: capB?.workspaceToolCount ?? null,
    markerAgentSpace: capB?.markerAgentSpace ?? null, markerFourFactor: capB?.markerFourFactor ?? null,
    skillMetadataHitCount: capB?.skillMetadataHitCount ?? null, skillNameHits: capB?.skillNameHits ?? null,
    runBasisRecorded: Boolean(basisB),
    basisEntryKind: basisJson?.entryKind ?? null,
    basisMethods: (basisJson?.methods ?? []).map((m) => ({ methodId: m.methodId, versionId: m.versionId, checksum: m.contentChecksum })),
    basisSkills: (basisJson?.skills ?? []).map((s) => ({ skillId: s.skillId, versionId: s.versionId })),
    basisSkipped: basisJson?.skipped ?? [],
    injectionWorkspaceNull: lastInjection ? lastInjection.workspace === null : null,
    injectionTools: lastInjection?.tools ?? null,
    systemHasNoLegacyPath: capB ? !JSON.stringify(capB).includes(backupRoot) : null,
    outcomes: outcomeKindsOf(runB.run.runId),
  };
  check(`B run succeeded ${u}`, runB.run.status === "succeeded", JSON.stringify({ status: runB.run.status }));
  check(`B run basis recorded ${u}`, Boolean(basisB));
  check(`B marker Agent Space in system ${u}`, capB?.markerAgentSpace === true);
  check(`B no workspace tools ${u}`, (capB?.workspaceToolCount ?? 0) === 0, `count=${capB?.workspaceToolCount}`);
  check(`B no legacy path in system ${u}`, runEvidence.B[u].systemHasNoLegacyPath !== false);
  check(`B execution outcome auto-recorded ${u}`, runEvidence.B[u].outcomes.some((k) => k === "execution_succeeded" || k === "execution_failed"));
}
// 旧 default-load 命中：A/B 两侧技能元数据命中数已随捕获计算（skillNameHits），事实呈现不预判。

// ---- 失败反例（B 侧，mg weekly-review，网关 outage → execution_failed） ----
if (failMarkerTaskId) {
  process.env.AGENT_SPACE_ASSEMBLY_MODE = "scope:mg";
  failureModeActive = true;
  try {
    const runF = await runner.runGenericAutomationTaskNow({ scope: scopeOf("mg"), taskId: failMarkerTaskId, origin: "manual", idempotencyKey: `w7ab-mg-f-${randomUUID().slice(0, 8)}` });
    runEvidence.failure = { taskId: failMarkerTaskId, runId: runF.run.runId, status: runF.run.status, outcomes: outcomeKindsOf(runF.run.runId), basisRecorded: Boolean(runF.run.runId ? basisRowOf(runF.run.runId) : false) };
    check("failure replay: run failed", runF.run.status === "failed", JSON.stringify({ status: runF.run.status }));
    check("failure replay: execution_failed auto-recorded", outcomeKindsOf(runF.run.runId).includes("execution_failed"));
  } finally {
    failureModeActive = false;
    delete process.env.AGENT_SPACE_ASSEMBLY_MODE;
  }
}

// ---- 投递链（真实 wechat_summary 任务 → push job → 假 sender → delivery outcome） ----
const { processDuePushJobs } = await importAppModule("services/push-queue.js");
const deliveryBefore = sqlite.prepare("SELECT COUNT(*) AS n FROM push_jobs").get().n;
await processDuePushJobs(async () => ({ ok: true, reason: "replay-fake-sent" }), { limit: 50 });
const deliveryJobs = sqlite.prepare("SELECT id, status, origin_run_id FROM push_jobs ORDER BY rowid").all();
const sentJobs = deliveryJobs.filter((j) => j.status === "sent");
const deliveryEvidence = {
  jobsBefore: deliveryBefore, jobsTotal: deliveryJobs.length, sent: sentJobs.length,
  jobs: deliveryJobs.map((j) => ({ id: j.id, status: j.status, originRunId: j.origin_run_id, runKnown: j.origin_run_id ? Boolean(runEvidence.A.mg?.runId === j.origin_run_id || runEvidence.B.mg?.runId === j.origin_run_id || runEvidence.A.dyk?.runId === j.origin_run_id || runEvidence.B.dyk?.runId === j.origin_run_id || runEvidence.A["111"]?.runId === j.origin_run_id || runEvidence.B["111"]?.runId === j.origin_run_id || runEvidence.failure?.runId === j.origin_run_id) : null })),
};
for (const u of users) {
  const b = runEvidence.B[u];
  if (!b?.runId) continue;
  const kinds = outcomeKindsOf(b.runId);
  check(`delivery outcome chain ${u}`, kinds.includes("delivery_succeeded"), JSON.stringify({ kinds, jobs: deliveryEvidence.jobs.filter((j) => j.originRunId === b.runId) }));
}
writeJson(path.join(outRoot, "03-runs", "run-evidence.json"), { runEvidence, deliveryEvidence, conversationBasis, capturesMeta: { count: captures.length, note: "system 全文不落盘；仅 hash/字符数/标记位。" }, generatedAt: nowIso() });

// ---------- 5) 跨 scope 反例 + 真实资产链字节核验 ----------
const isolation = {};
for (const u of users) {
  const scope = scopeOf(u);
  const row = sqlite.prepare(`SELECT a.asset_id AS assetId, a.current_version_id AS versionId FROM user_assets a JOIN user_asset_versions v ON v.asset_id=a.asset_id AND v.version_id=a.current_version_id WHERE a.user_id=? AND v.idempotency_key LIKE 'w6:%' LIMIT 1`).get(u);
  // 真实资产链（keep-authoritative，非 w6 导入）：从快照复制的 user_assets 行 + 项目根字节
  const realAssetId = [...realAssets[u]][0] ?? null;
  let realAssetByteRead = null;
  if (realAssetId) {
    const realRow = sqlite.prepare("SELECT current_version_id AS v FROM user_assets WHERE asset_id=? AND user_id=?").get(realAssetId, u);
    realAssetByteRead = realRow ? await userAssets.readUserAssetVersion({ ...scope, assetId: realAssetId, versionId: realRow.v }).then(() => true, (e) => `read-failed: ${e.message}`).catch((e) => `read-failed: ${e.message}`) : "row-missing";
  }
  if (!row) { isolation[u] = { imported: false, realAssetByteRead }; continue; }
  const sameScopeReadable = await userAssets.readUserAssetVersion({ ...scope, assetId: row.assetId, versionId: row.versionId }).then(() => true, () => false);
  const outsider = { userId: `w7ab-outsider-${u}`, projectId: scope.projectId, instanceId: `${scope.instanceId}-cross` };
  const crossScopeReadOk = await userAssets.readUserAssetVersion({ ...outsider, assetId: row.assetId, versionId: row.versionId }).then(() => true, () => false);
  // 会话 basis 跨 scope 读取拒绝
  let crossBasisRejected = null;
  try {
    space.getRunBasis(outsider, `conversation:w7ab_conv_${u}:message:w7ab_msg_${u}`);
    crossBasisRejected = false;
  } catch { crossBasisRejected = true; }
  isolation[u] = { imported: true, assetId: row.assetId, sameScopeReadable, crossScopeRejected: !crossScopeReadOk, crossBasisRejected, realAssetByteRead, realAssetId };
  check(`cross-scope asset read rejected ${u}`, !crossScopeReadOk);
  check(`same-scope asset read ok ${u}`, sameScopeReadable);
  check(`cross-scope basis read rejected ${u}`, crossBasisRejected === true);
  if (realAssetByteRead !== null) check(`real asset chain byte-read ok ${u}`, realAssetByteRead === true, String(realAssetByteRead));
}

// ---------- 6) 未迁移引用扫描（快照 DB 只读 + 双侧可用性比对） ----------
const importedPathSet = new Set(importOutcomes.map((o) => o.itemId.split(":").slice(2).join(":")));
const importedBasenames = [...importedPathSet].map((p) => path.posix.basename(p).replace(/\.[^.]+$/, ""));
const oldPathListOf = (u) => oldSide[u].filesSorted;
const pathRefRegex = /(?:^|["'\s（(，,：:])(methods|skills|reports|deliveries|knowledge|workflows|assets|attachments|files|templates|docs|financials|indicators|memory|plans|schemas|src|tests|config|data|out|tools)\/[\w\-./\u4e00-\u9fff]+/g;
const titleRefRegex = /《([^》]{2,60})》/g;
const norm = (s) => String(s ?? "").replace(/\s+/g, "");
const referenceScan = {};
const dbAssetNamesOf = (u) => sqlite.prepare("SELECT name FROM user_assets WHERE user_id=?").all(u).map((r) => norm(r.name));
for (const u of users) {
  const dbAssetNames = dbAssetNamesOf(u);
  const refs = { pathRefs: [], titleRefs: [], assetRefs: [] };
  for (const rev of revisionTexts.filter((r) => r.user === u)) {
    const blob = [rev.name, rev.description, rev.instruction, rev.inputsJson, rev.outputJson, rev.deliveryJson].map((s) => String(s ?? "")).join("\n");
    for (const m of blob.matchAll(pathRefRegex)) {
      const ref = m[0].replace(/^["'\s（(，,：:]/, "");
      refs.pathRefs.push({ taskId: rev.taskId, ref, inOldTree: oldPathListOf(u).some((p) => p === ref || p.startsWith(ref + "/") || p.includes(ref)), imported: importedPathSet.has(ref) });
    }
    for (const m of blob.matchAll(titleRefRegex)) {
      const title = norm(m[1]);
      if (!title) continue;
      const oldMatch = oldPathListOf(u).find((p) => norm(path.posix.basename(p).replace(/\.[^.]+$/, "")).includes(title) || norm(p).includes(title));
      const importedMatch = importedBasenames.find((b) => norm(b).includes(title) || title.includes(norm(b)));
      const dbAssetMatch = dbAssetNames.find((n) => n.includes(title) || title.includes(n)) ?? null;
      refs.titleRefs.push({ taskId: rev.taskId, title: m[1], oldSideFile: oldMatch ?? null, importedObject: importedMatch ?? null, dbAssetName: dbAssetMatch });
    }
    try {
      const parsedInputs = JSON.parse(rev.inputsJson ?? "null");
      const collect = (v) => {
        if (Array.isArray(v)) { v.forEach(collect); return; }
        if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) {
          if (/asset/i.test(k) && typeof val === "string" && val.startsWith("asset_")) refs.assetRefs.push({ taskId: rev.taskId, assetId: val, resolvableInIsolatedDb: Boolean(sqlite.prepare("SELECT 1 FROM user_assets WHERE asset_id=? AND user_id=?").get(val, u)) });
          else collect(val);
        }
      };
      collect(parsedInputs);
    } catch { /* 非 JSON */ }
  }
  // 去重（同 ref 多任务保留任务列表）
  const dedup = (list, keyOf) => {
    const map = new Map();
    for (const item of list) {
      const k = keyOf(item);
      if (!map.has(k)) map.set(k, { ...item, taskIds: [item.taskId] });
      else map.get(k).taskIds.push(item.taskId);
    }
    for (const v of map.values()) delete v.taskId;
    return [...map.values()];
  };
  referenceScan[u] = {
    pathRefs: dedup(refs.pathRefs, (r) => r.ref),
    titleRefs: dedup(refs.titleRefs, (r) => r.title),
    assetRefs: dedup(refs.assetRefs, (r) => r.assetId),
  };
  // 高风险：旧侧存在文件、新侧未导入、且无决策覆盖的路径引用
  for (const pr of referenceScan[u].pathRefs) {
    if (pr.inOldTree && !pr.imported) blocker(`未迁移引用 ${u}: ${pr.ref}（任务 ${pr.taskIds.join(",")} 引用旧路径，切换后旧 Workspace 不再默认装配）`);
  }
  for (const tr of referenceScan[u].titleRefs) {
    if (tr.oldSideFile && !tr.importedObject && !tr.dbAssetName) blocker(`标题引用 ${u}: 《${tr.title}》旧侧文件 ${tr.oldSideFile} 未进入新侧对象（任务 ${tr.taskIds.join(",")}）`);
  }
  for (const ar of referenceScan[u].assetRefs) {
    if (!ar.resolvableInIsolatedDb) blocker(`资产引用 ${u}: ${ar.assetId} 在隔离库不可解析（任务 ${ar.taskIds.join(",")}）`);
  }
  writeJson(path.join(outRoot, "04-references", `scan-${u}.json`), { ...referenceScan[u], generatedAt: nowIso() });
}

// ---------- 7) 旧 default-load 命中统计（A 侧=事实计数；B 侧=必须为零） ----------
const defaultLoad = {};
for (const u of users) {
  const skillNames = skillMeta[u].map((s) => s.name).filter(Boolean);
  defaultLoad[u] = {
    oldSideSkillMetadataCount: skillMeta[u].length,
    oldSideSkillNames: skillNames,
    note: "A 侧 system 全文按纪律不落盘；技能元数据是否注入以捕获标记与 systemSha256 复核，B 侧以 workspace 工具=0 + 装配段标记为准。",
  };
  const b = runEvidence.B[u];
  if (b) check(`B side zero old default-load (no workspace tools / no legacy skill metadata path) ${u}`, b.workspaceToolCount === 0 && b.markerAgentSpace === true);
}

// ---------- 8) 汇总报告 ----------
const failed = checks.filter((c) => !c.pass);
const stillNeedsRealSmoke = [
  "会话入口全链路（Portal 真实消息 → basis → 回复）——本回放的会话 basis 为服务层驱动",
  "真实模型输出质量与格式（本回放为假网关固定 JSON 响应）",
  "真实微信投递终态（本回放 sender 为注入的假函数）",
  "调度器自然触发（本回放为 manual 触发 generic runner）",
  "mg at_d64649ad 全链路模型运行（本回放为装配级 basis 验证；output update 工作簿链需真实模型输出）",
  "生产 DB 资产绑定链与生产 liveProjectRoot 的物理一致性（本回放基于 2026-09-20T225642 快照副本）",
];
writeJson(path.join(outRoot, "report.json"), {
  phase: "ab-replay",
  isolated: true,
  task: "T-530",
  note: "真实用户数据隔离回放（快照副本 + 隔离 DB + 假网关/假投递）；未连接生产 DB、未发送真实消息、未修改真实 Workspace。不是生产切换证据。",
  inputs: { w0Root, backupRoot, importGateSha256: importGateSha, users, snapshotSha256: sha256Of(readFileSync(snapshotDbPath)) },
  counts: {
    importedObjects: importOutcomes.length,
    snapshotActiveTasks: snapCounts,
    realTasksCopied: Object.fromEntries(users.map((u) => [u, realTasks[u].length])),
    oldSideFiles: Object.fromEntries(users.map((u) => [u, oldSide[u].fileCount])),
  },
  abSummary: Object.fromEntries(users.map((u) => [u, {
    oldSide: { files: oldSide[u].fileCount, byTop: oldSide[u].byTop, skillMetadata: skillMeta[u].length, runA: runEvidence.A[u] ? { status: runEvidence.A[u].status, basisRecorded: runEvidence.A[u].runBasisRecorded, workspaceTools: runEvidence.A[u].workspaceToolCount, systemChars: runEvidence.A[u].systemChars } : null },
    newSide: { importedObjects: importOutcomes.filter((o) => o.scope.userId === u).length, conversationBasisMethods: conversationBasis[u]?.methods.length ?? null, runB: runEvidence.B[u] ? { status: runEvidence.B[u].status, basisMethods: runEvidence.B[u].basisMethods, basisSkipped: runEvidence.B[u].basisSkipped, workspaceTools: runEvidence.B[u].workspaceToolCount, outcomes: runEvidence.B[u].outcomes } : null },
    isolation: isolation[u],
    references: { pathRefs: referenceScan[u].pathRefs.length, titleRefs: referenceScan[u].titleRefs.length, assetRefs: referenceScan[u].assetRefs.length },
  }])),
  failureReplay: runEvidence.failure,
  consumerTaskBasis: consumerBasis,
  delivery: deliveryEvidence,
  defaultLoad,
  blockers,
  stillNeedsRealSmoke,
  checks,
  pass: failed.length === 0,
  generatedAt: nowIso(),
});
server.close();
snap.close();
console.log(`w7-ab-replay: ${failed.length === 0 ? "OK" : "FAILED"} (${checks.length - failed.length}/${checks.length} checks, blockers=${blockers.length})`);
process.exit(failed.length === 0 ? 0 : 1);
