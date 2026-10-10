#!/usr/bin/env node
/** 一次性归档：把镜像存量报告类资产移入「报告」文件夹（2026-10-08 用户裁决）。
 * 判定：active 且无 folder 的资产中，名称以「每日复盘/周复盘/月复盘」开头或
 * 名称以 reports/ 开头（restore 残留）。幂等可重跑；只动 folder_id。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(REPO_ROOT, ".state", "production-mirror");
process.env.DB_PATH = path.join(root, "runtime.db");
// 镜像脚本必须钉住 projects 根：漏设会把新写文件落到仓库开发目录（2026-10-08 恢复脚本教训）。
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
const dbModule = await import("../../../src/db/index.ts");
const { sqlite } = dbModule.default ?? dbModule;
await (dbModule.default ?? dbModule).initDb();
const { ensureDefaultReportFolderId, moveUserAsset } = await import("../../../src/services/user-assets.ts");

const scopes = sqlite.prepare(`
  SELECT DISTINCT user_id AS userId, project_id AS projectId, instance_id AS instanceId FROM user_assets`).all();
const results = [];
for (const scope of scopes) {
  const candidates = sqlite.prepare(`
    SELECT a.asset_id AS assetId, a.name AS name
    FROM user_assets a
    WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.status='active' AND a.folder_id IS NULL
      AND (a.name LIKE '每日复盘 %' OR a.name LIKE '周复盘 %' OR a.name LIKE '月复盘 %' OR a.name LIKE 'reports/%')`).all(
    scope.userId, scope.projectId, scope.instanceId);
  if (!candidates.length) continue;
  const folderId = await ensureDefaultReportFolderId(scope);
  let moved = 0;
  for (const candidate of candidates) {
    await moveUserAsset({ ...scope, assetId: candidate.assetId, folderId });
    moved += 1;
  }
  results.push({ userId: scope.userId, folderId, moved });
}
console.log(JSON.stringify({ results }, null, 1));
sqlite.close();
