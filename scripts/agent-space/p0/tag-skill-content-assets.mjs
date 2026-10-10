#!/usr/bin/env node
/** 一次性迁移（2026-10-08 用户裁决：技能内容不在「我的文件」可见）：把被
 * agent_space 技能版本（content_ref_type=user_asset_version）引用的资产版本
 * source 改为 skill_content。方法域引用的资产保持 upload 不变。幂等可重跑。 */
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

const rows = sqlite.prepare(`
  SELECT DISTINCT v.asset_id AS assetId, sk.slug AS slug, sk.user_id AS userId
  FROM agent_space_skill_versions v
  JOIN agent_space_skills sk ON sk.skill_id = v.skill_id
  JOIN user_asset_versions av ON av.version_id = v.asset_version_id
  LEFT JOIN agent_space_method_versions mv ON mv.asset_version_id = v.asset_version_id
  WHERE v.content_ref_type='user_asset_version' AND mv.version_id IS NULL`).all();
const results = [];
for (const row of rows) {
  const updated = sqlite.prepare(`
    UPDATE user_asset_versions SET source='skill_content'
    WHERE asset_id=? AND source != 'skill_content'`).run(row.assetId);
  results.push({ userId: row.userId, slug: row.slug, changedVersions: updated.changes });
}
console.log(JSON.stringify({ skills: rows.length, results }, null, 1));
sqlite.close();
