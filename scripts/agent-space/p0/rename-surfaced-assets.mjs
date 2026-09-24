#!/usr/bin/env node
/** 一次性：dyk/mg 可见资产改干净名称（显性化口径，与 111 一致）。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const [p0Root, userId] = process.argv.slice(2);
const instanceId = `invest-agent-${userId}`;
process.env.DB_PATH = path.join(repo, p0Root, "runtime.db");
process.env.RUNTIME_DATA_ROOT = path.join(repo, p0Root);
process.env.MASTRA_PROJECTS_ROOT = path.join(repo, p0Root, "projects");
const { sqlite } = await import("../../../src/db/index.ts");
const { renameUserAsset } = await import("../../../src/services/user-assets.ts");
const scope = { userId, projectId: "invest-agent", instanceId };

for (const [from, to] of [["methods/strategy-rules.md", "策略规则"], ["methods/控盘度综合评分.md", "控盘度综合评分"]]) {
  const row = sqlite.prepare(
    `SELECT a.asset_id AS assetId FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.status='active' AND a.name=? LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId, from);
  if (row) { await renameUserAsset({ ...scope, assetId: row.assetId, name: to }); console.log(`${userId}: "${from}" -> "${to}"`); }
}
sqlite.close();
