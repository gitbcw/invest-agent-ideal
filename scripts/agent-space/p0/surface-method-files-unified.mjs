#!/usr/bin/env node
/** 三用户统一显性化（本地隔离环境，owner 2026-09-24 裁决「统一做显性化」）。
 *
 * 依据 docs/agent-space-execution/method-files-visibility-2026-09-24.md §1.1/§1.2/§4：
 * - 第一档用户内容进「我的策略文件」文件夹：strategy-rules 打「策略」标（mg 的
 *   控盘度综合评分同样打「策略」；控盘度指标V1.0 打「技术面」+「历史定位」）。
 * - 第二档系统模板四件套（assets/migrated/knowledge/methods/）导入并打「系统模板」标。
 * - 导入前按 sha256 对该用户全部可见版本去重；全部动作幂等、走服务层留审计。
 *
 * 只写本地隔离库（111 运行库 / dyk / mg 副本），不碰生产。
 * 注意：db 模块是进程级单例，一次只能对一个 scope 执行；跑全部请用 shell 循环。
 *
 * 用法：node --import tsx scripts/agent-space/p0/surface-method-files-unified.mjs <dyk|mg|111>
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const only = process.argv[2];
const SCOPES = ["dyk", "mg", "111", "mdyk", "mmg", "m111"];
if (!only || !SCOPES.includes(only)) throw new Error(`必须指定 scope: ${SCOPES.join(" | ")}`);

const FOLDER_NAME = "我的策略文件";
const METHOD_NAMES = {
  "strategy-rules.md": "策略规则",
  "fundamental.md": "基本面分析方法",
  "technical.md": "技术面分析方法",
  "macro.md": "宏观分析方法",
  "risk.md": "风险控制方法",
};
const FOUR_SET = ["fundamental.md", "technical.md", "macro.md", "risk.md"];

const p0Dyk = path.join(repo, ".state", "agent-space-p0-dyk");
const p0Mg = path.join(repo, ".state", "agent-space-p0");
const local111 = path.join(repo, "data", "mastra-portal-local", "runtime");
const mirror = path.join(repo, ".state", "production-mirror");

const PLANS = [
  {
    key: "111",
    db: path.join(local111, "invest-agent.db"),
    runtimeRoot: local111,
    projectsRoot: path.join(local111, "projects"),
    scope: { userId: "primary", projectId: "invest-agent", instanceId: "invest-agent-primary" },
    projectRoot: null, // 111 的显性化 9-24 已完成，只需补「策略」标
    tagExisting: [{ fileName: "strategy-rules.md", tags: ["策略"] }],
    imports: [],
  },
  {
    key: "dyk",
    db: path.join(p0Dyk, "runtime.db"),
    runtimeRoot: p0Dyk,
    projectsRoot: path.join(p0Dyk, "projects"),
    scope: { userId: "dyk", projectId: "invest-agent", instanceId: "invest-agent-dyk" },
    projectRoot: path.join(p0Dyk, "projects", "2df51712666a03657bce7a6e"),
    tagExisting: [{ fileName: "strategy-rules.md", tags: ["策略"], move: true }],
    imports: FOUR_SET.map((fileName) => ({
      fileName, sourceRelative: path.join("assets", "migrated", "knowledge", "methods", fileName), tags: ["系统模板"],
    })),
  },
  {
    key: "mg",
    db: path.join(p0Mg, "runtime.db"),
    runtimeRoot: p0Mg,
    projectsRoot: path.join(p0Mg, "projects"),
    scope: { userId: "mg", projectId: "invest-agent", instanceId: "invest-agent-mg" },
    projectRoot: path.join(p0Mg, "projects", "0561c9d25755c148ce216525"),
    tagExisting: [{ fileName: "控盘度综合评分.md", tags: ["策略"], move: true }],
    imports: [
      { fileName: "strategy-rules.md", sourceRelative: path.join("methods", "strategy-rules.md"), tags: ["策略"] },
      { fileName: "控盘度指标V1.0.md", sourceRelative: path.join("methods", "控盘度指标V1.0.md"), tags: ["技术面", "历史定位"] },
      ...FOUR_SET.map((fileName) => ({
        fileName, sourceRelative: path.join("assets", "migrated", "knowledge", "methods", fileName), tags: ["系统模板"],
      })),
    ],
  },
  // 生产镜像（.state/production-mirror）：同一裁决的镜像彩排，只写快照不写生产。
  {
    key: "m111",
    db: path.join(mirror, "runtime.db"),
    runtimeRoot: path.join(mirror, "runtime"),
    projectsRoot: path.join(mirror, "projects"),
    scope: { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" },
    projectRoot: path.join(mirror, "projects", "2e94a6a7c5b82c33cfb8beac"),
    // 镜像 111 已有 5 个「（历史候选）」资产在旧「我的方法」文件夹：改名干净名称 + 打标。
    tagExisting: [
      ...Object.entries(METHOD_NAMES).map(([fileName, name]) => ({
        fileName, renameTo: name, tags: fileName === "strategy-rules.md" ? ["策略"] : ["系统模板"],
      })),
    ],
    imports: [],
  },
  {
    key: "mdyk",
    db: path.join(mirror, "runtime.db"),
    runtimeRoot: path.join(mirror, "runtime"),
    projectsRoot: path.join(mirror, "projects"),
    scope: { userId: "dyk", projectId: "invest-agent", instanceId: "invest-agent-dyk" },
    projectRoot: path.join(mirror, "projects", "2df51712666a03657bce7a6e"),
    tagExisting: [{ fileName: "strategy-rules.md", tags: ["策略"], move: true, renameTo: "策略规则" }],
    imports: FOUR_SET.map((fileName) => ({
      fileName, sourceRelative: path.join("assets", "migrated", "knowledge", "methods", fileName), tags: ["系统模板"],
    })),
  },
  {
    key: "mmg",
    db: path.join(mirror, "runtime.db"),
    runtimeRoot: path.join(mirror, "runtime"),
    projectsRoot: path.join(mirror, "projects"),
    scope: { userId: "mg", projectId: "invest-agent", instanceId: "invest-agent-mg" },
    projectRoot: path.join(mirror, "projects", "0561c9d25755c148ce216525"),
    tagExisting: [{ fileName: "控盘度综合评分.md", tags: ["策略"], move: true, renameTo: "控盘度综合评分" }],
    imports: [
      { fileName: "strategy-rules.md", sourceRelative: path.join("methods", "strategy-rules.md"), tags: ["策略"] },
      { fileName: "控盘度指标V1.0.md", sourceRelative: path.join("methods", "控盘度指标V1.0.md"), tags: ["技术面", "历史定位"] },
      ...FOUR_SET.map((fileName) => ({
        fileName, sourceRelative: path.join("assets", "migrated", "knowledge", "methods", fileName), tags: ["系统模板"],
      })),
    ],
  },
];

const ALLOWED_DBS = new Set(PLANS.map((plan) => path.resolve(plan.db)));
const plan = PLANS.find((candidate) => candidate.key === only);
if (!plan) throw new Error(`未知 scope: ${only}`);
if (!ALLOWED_DBS.has(path.resolve(plan.db))) throw new Error(`非法目标库: ${plan.db}`);
const resolvedDb = path.resolve(plan.db);
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== resolvedDb) {
  throw new Error(`DB_PATH 与计划目标不一致: ${process.env.DB_PATH} != ${resolvedDb}`);
}
// 必须在导入 db 模块之前设置环境变量：sqlite 连接在模块加载时按 config 建立（单例）。
process.env.DB_PATH = resolvedDb;
process.env.RUNTIME_DATA_ROOT = plan.runtimeRoot;
process.env.MASTRA_PROJECTS_ROOT = plan.projectsRoot;
const { initDb, sqlite } = await import("../../../src/db/index.ts");
const userAssets = await import("../../../src/services/user-assets.ts");

{
  initDb();
  const { scope } = plan;
  console.log(`\n===== ${plan.key} (${scope.userId}) =====`);

  let folder = sqlite.prepare(
    "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name=? LIMIT 1",
  ).get(scope.userId, scope.projectId, scope.instanceId, FOLDER_NAME);
  if (!folder) {
    const legacy = sqlite.prepare(
      "SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的方法' LIMIT 1",
    ).get(scope.userId, scope.projectId, scope.instanceId);
    folder = legacy
      ? await userAssets.renameUserAssetFolder({ ...scope, folderId: legacy.folderId, name: FOLDER_NAME })
      : await userAssets.createUserAssetFolder({ ...scope, name: FOLDER_NAME });
  }
  console.log(`文件夹: ${FOLDER_NAME} (${folder.folderId})`);

  const findVisibleByFileName = (fileName) => sqlite.prepare(
    `SELECT a.asset_id AS assetId, a.name AS name, a.folder_id AS folderId, a.tags AS tags
     FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.status='active' AND v.file_name=? LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId, fileName);

  for (const action of plan.tagExisting) {
    const row = findVisibleByFileName(action.fileName);
    if (!row) { console.log(`${action.fileName}: NOT FOUND（可见资产中不存在），skip`); continue; }
    if (action.move && row.folderId !== folder.folderId) {
      await userAssets.moveUserAsset({ ...scope, assetId: row.assetId, folderId: folder.folderId });
      console.log(`${action.fileName}: moved -> ${FOLDER_NAME}`);
    }
    if (action.renameTo && row.name !== action.renameTo) {
      await userAssets.renameUserAsset({ ...scope, assetId: row.assetId, name: action.renameTo });
      console.log(`${action.fileName}: renamed -> "${action.renameTo}"`);
    }
    await userAssets.setUserAssetTags({ ...scope, assetId: row.assetId, tags: action.tags });
    console.log(`${action.fileName}: tags=${JSON.stringify(action.tags)}`);
  }

  for (const item of plan.imports) {
    const existing = findVisibleByFileName(item.fileName);
    if (existing) {
      await userAssets.setUserAssetTags({ ...scope, assetId: existing.assetId, tags: item.tags });
      const cleanName = METHOD_NAMES[item.fileName] ?? item.fileName.replace(/\.md$/, "");
      if (existing.name !== cleanName) {
        await userAssets.renameUserAsset({ ...scope, assetId: existing.assetId, name: cleanName });
        console.log(`${item.fileName}: 已可见，改名 "${cleanName}" + tags=${JSON.stringify(item.tags)}`);
      } else if (existing.folderId !== folder.folderId) {
        await userAssets.moveUserAsset({ ...scope, assetId: existing.assetId, folderId: folder.folderId });
        console.log(`${item.fileName}: 已可见，挪入 ${FOLDER_NAME} + tags=${JSON.stringify(item.tags)}`);
      } else {
        console.log(`${item.fileName}: 已可见，补 tags=${JSON.stringify(item.tags)}`);
      }
      continue;
    }
    const bytes = await readFile(path.join(plan.projectRoot, item.sourceRelative));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const dup = sqlite.prepare(
      `SELECT a.name AS name FROM user_asset_versions v JOIN user_assets a ON a.asset_id=v.asset_id
       WHERE v.user_id=? AND v.project_id=? AND v.instance_id=? AND v.checksum=? AND a.status='active' LIMIT 1`,
    ).get(scope.userId, scope.projectId, scope.instanceId, checksum);
    if (dup) { console.log(`${item.fileName}: sha256 与可见资产「${dup.name}」重复，跳过导入`); continue; }
    const name = METHOD_NAMES[item.fileName] ?? item.fileName.replace(/\.md$/, "");
    const asset = await userAssets.createUserAsset({
      ...scope, folderId: folder.folderId, name, fileName: item.fileName,
      mimeType: "text/markdown", bytes, tags: item.tags,
      idempotencyKey: `surface-method:${scope.userId}:${item.fileName}`,
    });
    console.log(`${item.fileName}: imported -> ${asset.assetId} (${name}) tags=${JSON.stringify(item.tags)}`);
  }

  const rows = sqlite.prepare(
    `SELECT a.name AS name, a.tags AS tags FROM user_assets a
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.folder_id=? AND a.status='active' ORDER BY a.name`,
  ).all(scope.userId, scope.projectId, scope.instanceId, folder.folderId);
  console.log(`${FOLDER_NAME} 现有 ${rows.length} 项: ${rows.map((row) => `${row.name}${row.tags ? `[${row.tags}]` : ""}`).join(", ")}`);
}
sqlite.close();
