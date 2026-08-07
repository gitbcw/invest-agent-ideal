/** Read-only storage accounting audit. It never mutates user assets or reports. */
import "dotenv/config";
import { initDb, sqlite } from "../db/index.js";
import { getStorageUsage } from "../services/user-storage-quota.js";

initDb();

const scopes = sqlite.prepare(`
  SELECT user_id AS userId, project_id AS projectId, instance_id AS instanceId FROM user_asset_versions
  UNION
  SELECT user_id AS userId, project_id AS projectId, instance_id AS instanceId FROM report_asset_mappings
  ORDER BY userId, projectId, instanceId
`).all() as Array<{ userId: string; projectId: string; instanceId: string }>;

const report = scopes.map((scope) => ({
  scope,
  usage: getStorageUsage(scope),
  assetVersionCount: Number((sqlite.prepare("SELECT COUNT(*) AS count FROM user_asset_versions WHERE user_id=? AND project_id=? AND instance_id=?").get(scope.userId, scope.projectId, scope.instanceId) as { count: number }).count),
  reportMappingCount: Number((sqlite.prepare("SELECT COUNT(*) AS count FROM report_asset_mappings WHERE user_id=? AND project_id=? AND instance_id=?").get(scope.userId, scope.projectId, scope.instanceId) as { count: number }).count),
}));

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), mode: "read_only", scopes: report }, null, 2));
