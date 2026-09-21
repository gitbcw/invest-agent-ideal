#!/usr/bin/env node
/**
 * W7 窗口日 smoke 采证（只读）：对指定 scope 输出三项证据的机器 JSON。
 *
 *   node --import tsx scripts/agent-space/w7-smoke.mjs --scope <userId> [--runs 5]
 *
 * 证据面（对应 W7 执行计划第 7 步）：
 *   1) basis：该 scope 最近 run-basis（entryKind、装配方法/技能、显式空集原因）；
 *   2) outcome/delivery 链：最近 runs 的分层 outcome 与 push_jobs 事实核对
 *      （execution_* ↔ run 终态；delivery_* ↔ origin_run_id 与 job 终态）；
 *   3) 隔离抽查：本 scope w6 导入资产存在、跨 scope 读取被拒。
 * 全程只读；exit 1 仅当采证本身失败，不判断业务好坏（采证数据供 owner 判读）。
 */
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const scopeUser = argOf("scope");
const runLimit = Number(argOf("runs") ?? 5);
if (!scopeUser) {
  console.error("usage: w7-smoke.mjs --scope <userId> [--runs 5]");
  process.exit(2);
}
if (!process.env.DB_PATH) {
  console.error("refusing to run: DB_PATH not set");
  process.exit(2);
}
process.env.NODE_ENV ??= "test";
process.env.WORKSPACE_BACKEND ??= "mastra";

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

const db = await importAppModule("db/index.js");
db.initDb();
const { listRunOutcomes } = await importAppModule("services/agent-space/index.js");
const userAssets = await importAppModule("services/user-assets.js");

const scopeRows = db.sqlite.prepare("SELECT DISTINCT user_id AS u, project_id AS p, instance_id AS i FROM user_assets WHERE user_id=?").all(scopeUser);
if (scopeRows.length === 0) {
  console.error(JSON.stringify({ scope: scopeUser, error: "no rows for scope (user not imported / wrong DB?)" }));
  process.exit(1);
}
const scope = { userId: scopeRows[0].u, projectId: scopeRows[0].p, instanceId: scopeRows[0].i };

const recentRuns = db.sqlite
  .prepare("SELECT run_id, task_id, status, finished_at, created_at FROM automation_task_runs WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?")
  .all(scope.userId, runLimit);
const recentBases = db.sqlite
  .prepare("SELECT basis_key, basis_json, created_at FROM agent_space_run_basis WHERE user_id=? ORDER BY rowid DESC LIMIT ?")
  .all(scope.userId, runLimit * 2);

const chain = [];
for (const run of recentRuns) {
  const outcomes = listRunOutcomes(scope, run.run_id);
  const deliveryFacts = [];
  for (const outcome of outcomes) {
    if (!String(outcome.kind).startsWith("delivery_")) continue;
    const pushJobId = (outcome.detail ?? null)?.pushJobId ?? null;
    const job = pushJobId
      ? db.sqlite.prepare("SELECT id, status, origin_run_id FROM push_jobs WHERE id=?").get(pushJobId) : undefined;
    deliveryFacts.push({ outcomeKind: outcome.kind, pushJob: job ?? null, factMatch: Boolean(job && job.origin_run_id === run.run_id) });
  }
  chain.push({
    runId: run.run_id, taskId: run.task_id, runStatus: run.status,
    finishedAt: run.finished_at,
    outcomes: outcomes.map((o) => ({ kind: o.kind, detail: o.detail, createdAt: o.createdAt })),
    deliveryFacts,
  });
}

const basisEvidence = recentBases.map((b) => {
  const parsed = JSON.parse(b.basis_json);
  return {
    basisKey: b.basis_key,
    entryKind: parsed.entryKind,
    methods: (parsed.methods ?? []).map((m) => ({ methodId: m.methodId, versionId: m.versionId, checksum: m.contentChecksum })),
    skills: (parsed.skills ?? []).map((sk) => ({ skillId: sk.skillId, versionId: sk.versionId })),
    skipped: parsed.skipped ?? [],
    createdAt: b.created_at,
  };
});

// 隔离抽查：本 scope 一个 w6 资产可读、跨 scope 读取被拒。
const w6AssetRow = db.sqlite
  .prepare("SELECT a.asset_id AS assetId, a.current_version_id AS versionId FROM user_assets a JOIN user_asset_versions v ON v.asset_id=a.asset_id AND v.version_id=a.current_version_id WHERE a.user_id=? AND v.idempotency_key LIKE 'w6:%' LIMIT 1")
  .get(scope.userId);
let isolationCheck = { imported: false };
if (w6AssetRow) {
  const sameScopeRead = await userAssets.readUserAssetVersion({ ...scope, assetId: w6AssetRow.assetId, versionId: w6AssetRow.versionId }).then(() => true, () => false);
  const crossScope = { userId: `w7-crosscheck-${scope.userId}`, projectId: scope.projectId, instanceId: `${scope.instanceId}-cross` };
  const crossScopeRead = await userAssets.readUserAssetVersion({ ...crossScope, assetId: w6AssetRow.assetId, versionId: w6AssetRow.versionId }).then(() => true, () => false);
  isolationCheck = { imported: true, assetId: w6AssetRow.assetId, sameScopeReadable: sameScopeRead, crossScopeRejected: !crossScopeRead };
}

console.log(JSON.stringify({
  scope,
  generatedAt: new Date().toISOString(),
  basisEvidence,
  runOutcomeChain: chain,
  isolationCheck,
  note: "只读采证；数据供 owner 判读，本脚本不判定业务好坏。",
}, null, 1));
process.exit(0);
