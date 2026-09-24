#!/usr/bin/env node
/** 本地隔离环境（最终口径）：策略相关文件显性化到「我的文件·我的策略文件」文件夹。
 * 文件夹名「我的策略文件」为 owner 2026-09-24 裁决（原候选「我的方法」废弃）。
 *
 * owner 2026-09-24 两次裁决后的最终口径：
 * - 显性化 = 5 个文件：strategy-rules（用户自己的，无标签）+ 四件套分析方法（打「系统模板」标签）。
 * - 7 份系统协议、5 份策略配置均不给用户看（用户不会改；协议可靠性评估另立任务 T-544）。
 * - 标签是徽章语义（portal 文件列表渲染「系统模板」徽章），不写进文件名。
 *
 * 动作（全部幂等）：
 * 1. 既有 5 个「我的方法」资产改名为干净名称；
 * 2. 四件套打「系统模板」标签（strategy-rules 明确清空标签）。
 * 不导入任何新文件、不创建 agent_space_methods、不做采用、不改装配；不写 production-mirror。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const localDb = path.join(repo, "data", "mastra-portal-local", "runtime", "invest-agent.db");
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== localDb) {
  throw new Error("只允许写入本地运行库 data/mastra-portal-local/runtime/invest-agent.db");
}
process.env.DB_PATH = localDb;
process.env.RUNTIME_DATA_ROOT = path.join(repo, "data", "mastra-portal-local", "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(repo, "data", "mastra-portal-local", "runtime", "projects");
const scope = { userId: "primary", projectId: "invest-agent", instanceId: "invest-agent-primary" };

const RENAMES = [
  ["strategy-rules.md", "策略规则"],
  ["fundamental.md", "基本面分析方法"],
  ["technical.md", "技术面分析方法"],
  ["macro.md", "宏观分析方法"],
  ["risk.md", "风险控制方法"],
];

const { initDb, sqlite } = await import("../../../src/db/index.ts");
initDb();
const { createUserAssetFolder, renameUserAsset, renameUserAssetFolder, setUserAssetTags } = await import("../../../src/services/user-assets.ts");

const FOLDER_NAME = "我的策略文件";
let folder = sqlite.prepare(
  "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name=? LIMIT 1",
).get(scope.userId, scope.projectId, scope.instanceId, FOLDER_NAME);
if (!folder) {
  const legacy = sqlite.prepare(
    "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的方法' LIMIT 1",
  ).get(scope.userId, scope.projectId, scope.instanceId);
  folder = legacy
    ? await renameUserAssetFolder({ ...scope, folderId: legacy.folderId, name: FOLDER_NAME })
    : await createUserAssetFolder({ ...scope, name: FOLDER_NAME });
}

for (const [fileName, name] of RENAMES) {
  const row = sqlite.prepare(
    `SELECT a.asset_id AS assetId, a.name AS name FROM user_assets a
     JOIN user_asset_versions v ON v.version_id=a.current_version_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.folder_id=? AND a.status='active' AND v.file_name=? LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId, folder.folderId, fileName);
  if (!row) { console.log(`${fileName}: NOT FOUND, skip（首次执行需先跑 migrate-local-111-method-assets.mjs 的导入步骤）`); continue; }
  if (row.name !== name) { await renameUserAsset({ ...scope, assetId: row.assetId, name }); console.log(`${fileName}: renamed -> "${name}"`); }
  const tags = fileName === "strategy-rules.md" ? [] : ["系统模板"];
  await setUserAssetTags({ ...scope, assetId: row.assetId, tags });
  console.log(`${fileName}: tags=${JSON.stringify(tags)}`);
}
const n = sqlite.prepare("SELECT COUNT(*) n FROM user_assets WHERE folder_id=? AND status='active'").get(folder.folderId);
console.log(`primary 我的策略文件：${n.n} 项（最终口径应为 5）`);
sqlite.close();
