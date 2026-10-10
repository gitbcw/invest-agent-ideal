#!/usr/bin/env node
/** 一次性清理：删除镜像导入产生的 restore 重复资产副本。判定：同 scope 同
 * checksum 的 active 资产组里同时存在 restore 与非 restore 来源时，删除
 * restore 副本（保留正常命名的原始资产）。存储副本独立于 workspace 原文件，
 * 删除不影响 workspace 的 reports/、deliveries/ 内容。幂等可重跑。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(REPO_ROOT, ".state", "production-mirror");
if (!path.resolve(process.env.MIRROR_ROOT ?? "") === root && process.env.MIRROR_ROOT) {
  throw new Error("本脚本只作用于默认镜像路径");
}
process.env.DB_PATH = path.join(root, "runtime.db");
// 镜像脚本必须钉住 projects 根：漏设会把新写文件落到仓库开发目录（2026-10-08 恢复脚本教训）。
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
const dbModule = await import("../../../src/db/index.ts");
const { sqlite } = dbModule.default ?? dbModule;
await (dbModule.default ?? dbModule).initDb();
const { deleteUserAsset } = await import("../../../src/services/user-assets.ts");

const groups = sqlite.prepare(`
  SELECT v.checksum AS checksum, a.user_id AS userId, a.project_id AS projectId, a.instance_id AS instanceId
  FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
  WHERE a.status='active'
  GROUP BY v.checksum, a.user_id, a.project_id, a.instance_id
  HAVING count(*) > 1`).all();
const results = [];
for (const group of groups) {
  const rows = sqlite.prepare(`
    SELECT a.asset_id AS assetId, a.name AS name, v.source AS source
    FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
    WHERE a.status='active' AND v.checksum=? AND a.user_id=? AND a.project_id=? AND a.instance_id=?`).all(
    group.checksum, group.userId, group.projectId, group.instanceId);
  const originals = rows.filter((r) => r.source !== "restore");
  const duplicates = rows.filter((r) => r.source === "restore");
  if (!originals.length || !duplicates.length) { results.push({ userId: group.userId, checksum: group.checksum.slice(0, 8), skipped: "no original to keep" }); continue; }
  for (const dup of duplicates) {
    await deleteUserAsset({ userId: group.userId, projectId: group.projectId, instanceId: group.instanceId, assetId: dup.assetId });
    results.push({ userId: group.userId, deleted: dup.name, kept: originals[0].name });
  }
}
console.log(JSON.stringify({ duplicateGroups: groups.length, results }, null, 1));
sqlite.close();
