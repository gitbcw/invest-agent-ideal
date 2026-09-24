#!/usr/bin/env node
/** 一次性修复：撤销 surface-111-method-files.mjs 对 production-mirror 的误写（红线：镜像只读）。
 * 恢复 5 个改回「历史候选」名称；硬删除 12 个误导入资产。 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(repo, ".state", "production-mirror");
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
const scope = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };

const { initDb, sqlite } = await import("../../../src/db/index.ts");
initDb();
const { renameUserAsset, deleteUserAsset } = await import("../../../src/services/user-assets.ts");
const folder = sqlite.prepare(
  "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的方法' LIMIT 1",
).get(scope.userId, scope.projectId, scope.instanceId);

const back = [
  ["strategy-rules.md", "策略规则（历史候选）"],
  ["fundamental.md", "基本面分析方法（历史候选）"],
  ["technical.md", "技术面分析方法（历史候选）"],
  ["macro.md", "宏观分析方法（历史候选）"],
  ["risk.md", "风险控制方法（历史候选）"],
];
for (const [fn, name] of back) {
  const row = sqlite.prepare(
    "SELECT a.asset_id AS assetId, a.name AS name FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id WHERE a.folder_id=? AND v.file_name=? AND a.status='active'",
  ).get(folder.folderId, fn);
  if (row && row.name !== name) { await renameUserAsset({ ...scope, assetId: row.assetId, name }); console.log("reverted:", fn); }
  else console.log("ok:", fn, "=", row?.name);
}
const created = sqlite.prepare(
  `SELECT a.asset_id AS assetId, v.file_name AS fn FROM user_assets a
   JOIN user_asset_versions v ON v.version_id=a.current_version_id
   WHERE a.folder_id=? AND v.file_name IN ('decision_protocol.md','source_audit.md','watch_protocol.md','privacy_and_tenant_isolation.md','capability_extension_protocol.md','selection_protocol.md','product_metrics_protocol.md','observation_pool.yaml','selection.yaml','risk_taxonomy.yaml','decision_policy.yaml','style_packs.yaml')`,
).all(folder.folderId);
for (const r of created) { await deleteUserAsset({ ...scope, assetId: r.assetId }); console.log("deleted:", r.fn); }
const n = sqlite.prepare("SELECT COUNT(*) n FROM user_assets WHERE folder_id=?").get(folder.folderId);
console.log("production-mirror 111 我的方法 剩余:", n.n, "项（应为 5）");
sqlite.close();
