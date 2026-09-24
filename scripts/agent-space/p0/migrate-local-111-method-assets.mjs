#!/usr/bin/env node
/** Reify 111's historical investment-method files as local user assets only. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(repo, ".state", "production-mirror");
const dbPath = path.join(root, "runtime.db");
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== dbPath) throw new Error("只允许写入 production-mirror 数据库");
process.env.DB_PATH = dbPath;
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
const scope = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };
const projectRoot = path.join(root, "projects", "10849b69cdfa1b7a8c581a7b");
const files = [
  ["策略规则（历史候选）", path.join(projectRoot, "methods", "strategy-rules.md")],
  ["基本面分析方法（历史候选）", path.join(projectRoot, "assets", "migrated", "knowledge", "methods", "fundamental.md")],
  ["技术面分析方法（历史候选）", path.join(projectRoot, "assets", "migrated", "knowledge", "methods", "technical.md")],
  ["宏观分析方法（历史候选）", path.join(projectRoot, "assets", "migrated", "knowledge", "methods", "macro.md")],
  ["风险控制方法（历史候选）", path.join(projectRoot, "assets", "migrated", "knowledge", "methods", "risk.md")],
];
const { initDb, sqlite } = await import("../../../src/db/index.ts");
initDb();
const { createUserAssetFolder, createUserAsset } = await import("../../../src/services/user-assets.ts");
let folder = sqlite.prepare(
  "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的策略文件' LIMIT 1",
).get(scope.userId, scope.projectId, scope.instanceId);
if (!folder) folder = await createUserAssetFolder({ ...scope, name: "我的策略文件" });
for (const [name, filePath] of files) {
  const bytes = await fs.readFile(filePath);
  const existing = sqlite.prepare(
    `SELECT a.asset_id FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.folder_id=? AND v.file_name=? LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId, folder.folderId, path.basename(filePath));
  if (existing) {
    console.log(`${name}: retained ${existing.asset_id}`);
    continue;
  }
  const asset = await createUserAsset({
    ...scope, folderId: folder.folderId, name, fileName: path.basename(filePath), mimeType: "text/markdown", bytes,
    source: "restore", idempotencyKey: `local-111-method-candidate:${path.basename(filePath)}`,
  });
  console.log(`${name}: created ${asset.assetId}`);
}
sqlite.close();
console.log("111 本地历史方法文件已进入‘我的策略文件’文件夹；未创建 agent_space_methods，未采用任何文件。");
