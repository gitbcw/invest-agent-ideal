#!/usr/bin/env node
/**
 * T-537 P0: 从生产只读导出 111 scope 隔离副本。
 *
 * 源零写入保证：生产侧仅以 readonly 连接打开 runtime.db，用 SQLite backup
 * API 生成一致性快照到 /tmp（backup 只写目标文件）；容器用 tar 打包。
 * 筛选（prune）全部发生在本地副本上，源库与生产容器不受影响。
 *
 * 用法:
 *   node scripts/agent-space/p0/pull-111-copy.mjs [--keep-incoming]
 *
 * 产物（.state/agent-space-p0/）:
 *   runtime.db          仅含 111 scope 行 + 全局表的隔离 DB
 *   projects/<digest>/  111 用户容器（资产字节所在）
 *   pull-manifest.json  来源时间、校验和、逐表行数对照、字节校验结果
 */
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.join(REPO_ROOT, ".state", "agent-space-p0");
const INCOMING = path.join(P0_ROOT, "incoming");

const REMOTE = process.env.P0_REMOTE || "claude@118.145.115.197";
const SSH_PORT = process.env.P0_SSH_PORT || "22";
const REMOTE_DIR = process.env.P0_REMOTE_DIR || "/home/claude/invest-agent-mastra";
const REMOTE_DB = process.env.P0_REMOTE_DB || `${REMOTE_DIR}/data/runtime.db`;
const CONTAINER_REL = "projects/10849b69cdfa1b7a8c581a7b"; // scopeDigest("111\0invest-agent\0invest-agent-111")
const KEEP_INCOMING = process.argv.includes("--keep-incoming");

const SCOPE = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };

function runSsh(script, { capture = false } = {}) {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  // 远程脚本落在项目目录下执行（CJS 依赖解析基于脚本位置而非 cwd），执行后即删
  const full = `printf %s ${b64} | base64 -d > ${REMOTE_DIR}/.p0-remote.cjs && node ${REMOTE_DIR}/.p0-remote.cjs; rc=$?; rm -f ${REMOTE_DIR}/.p0-remote.cjs; exit $rc`;
  const r = spawnSync("ssh", ["-p", SSH_PORT, REMOTE, full], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ssh 远程脚本失败 (exit=${r.status})`);
  return r.stdout;
}
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    const hash = createHash("sha256");
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ---------- 远程侧：只读快照 + 容器打包 + 源计数 ----------
const remoteScript = `
const Database = require("better-sqlite3"); // 模块导出即构造函数（非命名导出）
const { execSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

const ts = ${JSON.stringify("__TS__")};
const db = new Database(${JSON.stringify(REMOTE_DB)}, { readonly: true, fileMustExist: true });

const snap = "/tmp/p0-111-snapshot-" + ts + ".db";
const tgz = "/tmp/p0-111-container-" + ts + ".tgz";

const backupPromise = db.backup(snap);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

backupPromise.then(() => {
  try {
    // 计数基准 = 快照文件本身（backup 时刻的一致性状态），消除 live 库继续写入造成的时间差
    const snapDb = new Database(snap, { readonly: true });
    const counts = {};
    for (const t of snapDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)) {
      const cols = snapDb.prepare("PRAGMA table_info(" + JSON.stringify(t) + ")").all().map((c) => c.name);
      if (cols.includes("user_id")) {
        counts[t] = { scoped: true, total: snapDb.prepare("SELECT COUNT(*) c FROM " + JSON.stringify(t)).get().c,
          s111: snapDb.prepare("SELECT COUNT(*) c FROM " + JSON.stringify(t) + " WHERE user_id = ?").get("111").c };
      } else if (t === "ai_instances") {
        counts[t] = { scopedByOwner: true, total: snapDb.prepare("SELECT COUNT(*) c FROM ai_instances").get().c,
          s111: snapDb.prepare("SELECT COUNT(*) c FROM ai_instances WHERE owner_user_id = ?").get("111").c };
      } else if (cols.includes("instance_id")) {
        counts[t] = { scopedByInstance: true, total: snapDb.prepare("SELECT COUNT(*) c FROM " + JSON.stringify(t)).get().c,
          s111: snapDb.prepare("SELECT COUNT(*) c FROM " + JSON.stringify(t) + " WHERE instance_id = ?").get(${JSON.stringify(SCOPE.instanceId)}).c };
      } else {
        counts[t] = { global: true, total: snapDb.prepare("SELECT COUNT(*) c FROM " + JSON.stringify(t)).get().c };
      }
    }
    snapDb.close();

    execSync("tar czf " + tgz + " -C ${REMOTE_DIR}/data " + ${JSON.stringify(CONTAINER_REL)});
    const out = {
      pulledAt: new Date().toISOString(),
      sourceDb: ${JSON.stringify(REMOTE_DB)},
      snapshot: { path: snap, size: fs.statSync(snap).size, sha256: sha(snap) },
      container: { path: tgz, size: fs.statSync(tgz).size, sha256: sha(tgz), rel: ${JSON.stringify(CONTAINER_REL)} },
      counts,
    };
    db.close();
    console.log(JSON.stringify(out));
  } catch (e) { console.error(e); process.exit(1); }
}).catch((e) => { console.error(e); process.exit(1); });
`;

// ---------- 本地 prune ----------
async function main() {
  fs.rmSync(INCOMING, { recursive: true, force: true }); // 幂等重跑：清掉上次运行的中间文件
  fs.mkdirSync(INCOMING, { recursive: true });
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

  console.log(`[1/6] 生产侧只读快照与容器打包（readonly 连接，源零写入）...`);
  const metaRaw = runSsh(remoteScript.replace("__TS__", ts), { capture: true });
  const meta = JSON.parse(metaRaw.trim().split("\n").pop());
  console.log(`  快照 ${(meta.snapshot.size / 1e6).toFixed(1)}MB  容器 ${(meta.container.size / 1e6).toFixed(1)}MB`);

  console.log(`[2/6] 拉回本地 incoming/ ...`);
  const snapLocal = path.join(INCOMING, `snapshot-${ts}.db`);
  const tgzLocal = path.join(INCOMING, `container-${ts}.tgz`);
  execSync(`scp -P ${SSH_PORT} ${REMOTE}:${meta.snapshot.path} ${snapLocal}`, { stdio: "inherit" });
  execSync(`scp -P ${SSH_PORT} ${REMOTE}:${meta.container.path} ${tgzLocal}`, { stdio: "inherit" });

  console.log(`[3/6] 删除远端 /tmp 中间文件 ...`);
  try {
    runSsh(`require("node:child_process").execSync("find /tmp -maxdepth 1 -name 'p0-111-*' -delete")`);
  } catch (e) {
    // 幂等清理，失败不阻断主流程（同 ts 重跑会覆盖；远端 /tmp 随重启清理）
    console.warn(`  !! 远端临时文件清理失败（${e.message}）；继续执行。残留: ${meta.snapshot.path}, ${meta.container.path}`);
  }

  const snapSha = await sha256File(snapLocal);
  const tgzSha = await sha256File(tgzLocal);
  if (snapSha !== meta.snapshot.sha256 || tgzSha !== meta.container.sha256) {
    throw new Error("传输校验失败：本地 sha256 与源侧不一致");
  }
  console.log(`  传输 sha256 校验通过`);

  console.log(`[4/6] 本地筛选（prune 至仅 111 scope）...`);
  const mod = await import("better-sqlite3");
  const Database = mod.default ?? mod.Database ?? mod; // 兼容 default / 命名 / 直接构造函数三种导出形态
  const targetDbPath = path.join(P0_ROOT, "runtime.db");
  fs.rmSync(targetDbPath, { force: true });
  fs.rmSync(targetDbPath + "-wal", { force: true });
  fs.rmSync(targetDbPath + "-shm", { force: true });
  fs.copyFileSync(snapLocal, targetDbPath);
  const db = new Database(targetDbPath);
  // 表间外键会让逐表 DELETE 的中间态违约；关闭外键后删除，删完用 foreign_key_check 复核剩余 111 行
  db.pragma("foreign_keys = OFF");
  // Portal 展示态用 portal_users.id（usr_*）而非 runtime users.id（111）归属。
  // 先锁定 111 实例的 Portal 用户，避免通用 user_id 裁剪误删标签、归档、
  // 置顶、排序和重命名元数据。
  const portalUserIds = db
    .prepare("SELECT id FROM portal_users WHERE instance_id = ?")
    .all(SCOPE.instanceId)
    .map((row) => row.id);
  if (portalUserIds.length === 0) {
    throw new Error(`111 scope 缺少 Portal 用户映射: ${SCOPE.instanceId}`);
  }
  const portalPresentationTables = new Set([
    "conversation_labels",
    "portal_conversation_meta",
    "portal_conversation_reconciliation",
  ]);
  const portalUserPlaceholders = portalUserIds.map(() => "?").join(", ");
  const pruneLog = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of tables) {
    if (t.startsWith("sqlite_")) continue;
    const cols = db.pragma(`table_info(${JSON.stringify(t)})`).map((c) => c.name);
    let predicate = null;
    if (t === "ai_instances") predicate = `owner_user_id IS NOT NULL AND owner_user_id != '111'`;
    else if (portalPresentationTables.has(t)) predicate = `user_id IS NOT NULL AND user_id NOT IN (${portalUserPlaceholders})`;
    else if (cols.includes("user_id")) predicate = `user_id IS NOT NULL AND user_id != '111'`;
    else if (cols.includes("instance_id")) predicate = `instance_id IS NOT NULL AND instance_id != '${SCOPE.instanceId}'`;
    if (!predicate) continue;
    const before = db.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)}`).get().c;
    db.prepare(`DELETE FROM ${JSON.stringify(t)} WHERE ${predicate}`).run(...(portalPresentationTables.has(t) ? portalUserIds : []));
    const after = db.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)}`).get().c;
    if (before !== after) pruneLog.push({ table: t, before, after });
  }
  // 隔离约定：冻结 111 任务未来调度（历史 runs 全保留，GUI 验证不受影响）
  db.prepare(`UPDATE automation_tasks SET next_run_at = NULL WHERE user_id = '111'`).run();
  const fkViolations = db.pragma("foreign_key_check");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.close();
  if (fkViolations.length > 0) {
    console.error(`  !! foreign_key_check 发现 ${fkViolations.length} 处剩余行引用违例`, JSON.stringify(fkViolations.slice(0, 5)));
    throw new Error("筛选后外键完整性校验失败");
  }
  console.log(`  筛选完成，清理了 ${pruneLog.length} 张表的非 111 行；剩余行外键完整性通过`);

  console.log(`[5/6] 解包容器与逐表行数/字节校验 ...`);
  const projectsRoot = path.join(P0_ROOT, "projects");
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  // tar 成员带 projects/ 前缀，strip 后直接解出 <digest>/ 目录
  execSync(`tar xzf ${tgzLocal} --strip-components=1 -C ${projectsRoot}`);

  const vdb = new Database(targetDbPath);
  const countCheck = [];
  let mismatch = 0;
  for (const [t, info] of Object.entries(meta.counts)) {
    if (!info.scoped && !info.scopedByInstance && !info.scopedByOwner) continue;
    // 与源侧同口径：数 111 行（prune 保留的 user_id/instance_id 为 NULL 的行不计入，但记录数量供审计）
    let local;
    let nullRows = 0;
    if (info.scopedByOwner) local = vdb.prepare(`SELECT COUNT(*) c FROM ai_instances WHERE owner_user_id = '111'`).get().c;
    else if (info.scoped) {
      local = vdb.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)} WHERE user_id = '111'`).get().c;
      nullRows = vdb.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)} WHERE user_id IS NULL`).get().c;
    } else local = vdb.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t)} WHERE instance_id = '${SCOPE.instanceId}'`).get().c;
    const ok = local === info.s111;
    if (!ok) mismatch++;
    countCheck.push({ table: t, source111: info.s111, local, nullRowsRetained: nullRows, ok });
  }

  const versions = vdb.prepare(
    `SELECT version_id, asset_id, file_name, size_bytes, checksum, storage_path FROM user_asset_versions WHERE user_id = '111'`
  ).all();
  const containerRoot = path.join(projectsRoot, path.basename(CONTAINER_REL));
  let byteOk = 0;
  const byteFail = [];
  for (const v of versions) {
    const expected = `assets/${v.asset_id}/versions/${v.version_id}/${v.file_name}`;
    if (v.storage_path !== expected) { byteFail.push({ versionId: v.version_id, reason: "storage_path 形态异常" }); continue; }
    const file = path.join(containerRoot, v.storage_path);
    try {
      const bytes = fs.readFileSync(file);
      const sha = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length === v.size_bytes && sha === v.checksum) byteOk++;
      else byteFail.push({ versionId: v.version_id, reason: "大小或 sha256 与 DB 不符" });
    } catch {
      byteFail.push({ versionId: v.version_id, reason: "容器内文件缺失" });
    }
  }
  vdb.close();

  console.log(`  行数对照 ${countCheck.filter((c) => c.ok).length}/${countCheck.length} 张表一致；字节校验 ${byteOk}/${versions.length} 通过`);
  if (mismatch > 0 || byteFail.length > 0) console.error("  !! 存在校验失败项（详见 pull-manifest.json）");

  console.log(`[6/6] 写入 pull-manifest.json ...`);
  const manifest = {
    task: "T-537",
    pulledAt: meta.pulledAt,
    source: { remote: REMOTE, sshPort: SSH_PORT, db: meta.sourceDb, readonlyOpen: true, sourceWrites: 0 },
    scope: SCOPE,
    snapshot: { sha256: snapSha, sizeBytes: meta.snapshot.size, containerSha256: tgzSha },
    container: { rel: CONTAINER_REL, root: containerRoot, assetVersionsChecked: versions.length, byteOk, byteFail },
    prune: { strategy: "copy-then-prune（本地副本筛选，源零写入）", tablesPruned: pruneLog.length, scheduleFrozen: "automation_tasks.next_run_at -> NULL（仅 111 行）" },
    countCheck,
    allChecksPassed: mismatch === 0 && byteFail.length === 0,
  };
  fs.writeFileSync(path.join(P0_ROOT, "pull-manifest.json"), JSON.stringify(manifest, null, 2));

  if (!KEEP_INCOMING && mismatch === 0 && byteFail.length === 0) {
    fs.rmSync(INCOMING, { recursive: true, force: true });
    console.log("  incoming/ 全量快照已删除（仅保留 111 筛选副本）");
  }
  console.log(`完成：${P0_ROOT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
