#!/usr/bin/env node
/** 一次性迁移（2026-10-08 owner 裁决「我的策略」）：
 * 1)「我的策略文件」文件夹中的方法文件（restore 来源）迁入策略域：
 *    「策略规则」→ 绑定为主策略；四件套（基本面/技术面/宏观/风控）→ 非主策略；
 *    内容沿用原资产版本（引用同一 user_asset_version，不复制字节）。
 * 2) 资产版本 source 改 method_content：从「我的文件」隐藏（管理面=我的策略页）。
 * 3)「均线+放量突破策略」技能（若存在）转为非主策略，技能卸载并墓碑删除。
 * 4) 空的「我的策略文件」文件夹删除。
 * 幂等可重跑。 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(REPO_ROOT, ".state", "production-mirror");
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
const dbModule = await import("../../../src/db/index.ts");
(dbModule.default ?? dbModule).initDb();
const { sqlite } = dbModule.default ?? dbModule;
const space = (await import("../../../src/services/agent-space/index.ts")).default ?? await import("../../../src/services/agent-space/index.ts");
const { bindMethod } = await import("../../../src/services/agent-space/agents.ts");
const { resolvePortalAgent, registerPortalActionAuthorization } = await import("../../../src/services/agent-space/portal-actions.ts");
const ownerToken = sqlite.prepare("SELECT value FROM settings WHERE key=?").get("agent_space.owner_admin_token")?.value;

// 直接内联 addMethodVersion + approve（避免顶层 await 复杂化）：
async function migrateOne(scope, name, fileName, isPrimary) {
  const existing = sqlite.prepare(
    `SELECT method_id AS methodId FROM agent_space_methods
     WHERE user_id=? AND project_id=? AND instance_id=? AND name=? AND status != 'retired'`,
  ).get(scope.userId, scope.projectId, scope.instanceId, name);
  if (existing) return { name, skipped: "already-exists" };
  const asset = sqlite.prepare(
    `SELECT a.asset_id AS assetId, v.version_id AS versionId, v.checksum AS checksum
     FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     JOIN user_asset_folders f ON f.folder_id=a.folder_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.status='active' AND f.name='我的策略文件' AND v.file_name=?`,
  ).get(scope.userId, scope.projectId, scope.instanceId, fileName);
  if (!asset) return { name, skipped: `source ${fileName} not-found` };
  const method = space.createMethod({ scope, name, actor: "strategy-migration", idempotencyKey: `strategy-migration:${scope.userId}:${name}` });
  const version = await space.addMethodVersion({
    scope, methodId: method.method_id,
    contentRef: { contentRefType: "user_asset_version", assetId: asset.assetId, assetVersionId: asset.versionId, contentChecksum: asset.checksum },
    origin: "migration", actor: "strategy-migration",
    idempotencyKey: `strategy-migration:${scope.userId}:${name}:version`,
  });
  const approvalRef = `owner-decision:strategy-migration-${createHash("sha256").update(`${scope.userId}:${name}`).digest("hex").slice(0, 8)}`;
  space.approveMethodVersion({
    scope, methodId: method.method_id, versionId: version.version_id,
    approvedBy: "strategy-migration", approvalRef, ownerToken, adopt: true, actor: "strategy-migration",
  });
  // 内容资产版本标 method_content（我的文件隐藏）
  sqlite.prepare("UPDATE user_asset_versions SET source='method_content' WHERE asset_id=?").run(asset.assetId);
  if (isPrimary) {
    const agent = resolvePortalAgent(scope);
    bindMethod({ scope, agentId: agent.agentId, methodId: method.method_id, versionPolicy: "current", actor: "strategy-migration" });
  }
  return { name, methodId: method.method_id, primary: isPrimary };
}

const results = [];
const scopes = sqlite.prepare("SELECT DISTINCT a.user_id AS userId, a.project_id AS projectId, a.instance_id AS instanceId FROM user_assets a JOIN user_asset_folders f ON f.folder_id=a.folder_id WHERE f.name='我的策略文件'").all();
const FILES = [
  ["策略规则", "strategy-rules.md", true],
  ["基本面分析", "fundamental.md", false],
  ["技术面分析", "technical.md", false],
  ["宏观分析", "macro.md", false],
  ["风险控制", "risk.md", false],
  // mg 特有（9-24 显性化文档 D1/D3）：控盘度综合评分为已采用方法。
  ["控盘度综合评分", "控盘度综合评分.md", false],
  ["控盘度指标V1.0（历史定位）", "控盘度指标V1.0.md", false],
];
for (const scope of scopes) {
  for (const [name, file, isPrimary] of FILES) {
    results.push(await migrateOne(scope, name, file, isPrimary));
  }
}

// 突破策略技能 → 策略（内容为技能正文）
{
  const skill = sqlite.prepare("SELECT skill_id AS skillId, name, slug FROM agent_space_skills WHERE slug='ma-volume-breakout-strategy' AND status='active'").get();
  if (skill) {
    const versionRow = sqlite.prepare(
      `SELECT v.version_id AS versionId, v.asset_id AS assetId, v.asset_version_id AS assetVersionId, v.content_checksum AS checksum
       FROM agent_space_skill_versions v WHERE v.skill_id=? ORDER BY v.created_at DESC LIMIT 1`,
    ).get(skill.skillId);
    if (versionRow?.asset_version_id) {
      for (const scope of scopes) {
        if (scope.userId !== "111") continue;
        const existing = sqlite.prepare("SELECT method_id AS methodId FROM agent_space_methods WHERE user_id=? AND name=? AND status!='retired'").get("111", skill.name);
        if (!existing) {
          const method = space.createMethod({ scope, name: skill.name, actor: "strategy-migration", idempotencyKey: `strategy-migration:111:${skill.slug}` });
          const version = await space.addMethodVersion({
            scope, methodId: method.method_id,
            contentRef: { contentRefType: "user_asset_version", assetId: versionRow.assetId, assetVersionId: versionRow.assetVersionId, contentChecksum: versionRow.checksum },
            origin: "migration", actor: "strategy-migration", idempotencyKey: `strategy-migration:111:${skill.slug}:version`,
          });
          space.approveMethodVersion({ scope, methodId: method.method_id, versionId: version.version_id, approvedBy: "strategy-migration", approvalRef: "owner-decision:strategy-migration-breakout", ownerToken, adopt: true, actor: "strategy-migration" });
          sqlite.prepare("UPDATE user_asset_versions SET source='method_content' WHERE asset_id=?").run(versionRow.assetId);
          results.push({ name: skill.name, methodId: method.method_id, from: "skill" });
        }
      }
    }
    // 技能侧卸载 + 墓碑（对话 Agent 创建的私有技能，slug 可复用）
    const installs = sqlite.prepare("SELECT installation_id AS installationId, agent_id AS agentId FROM agent_space_agent_skill_installations WHERE skill_id=? AND status IN ('installed','disabled')").all(skill.skillId);
    for (const install of installs) {
      try {
        space.portalRemoveInstalledSkill({ scope: { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" }, actor: "strategy-migration", idempotencyKey: `strategy-migration:skill-remove:${install.installationId}` }, install.agentId, skill.skillId);
      } catch (error) {
        results.push({ name: skill.name, removeError: String(error?.message ?? error) });
      }
    }
    sqlite.prepare("UPDATE agent_space_skills SET status='deleted', updated_at=? WHERE skill_id=?").run(new Date().toISOString(), skill.skillId);
    results.push({ name: skill.name, skillTombstoned: true });
  }
}

// 清理空的「我的策略文件」文件夹
for (const scope of scopes) {
  const folder = sqlite.prepare("SELECT folder_id AS folderId FROM user_asset_folders WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的策略文件'").get(scope.userId, scope.projectId, scope.instanceId);
  if (!folder) continue;
  const remaining = sqlite.prepare(
    `SELECT count(*) AS n FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     WHERE a.folder_id=? AND a.status='active' AND v.source NOT IN ('method_content','skill_content')`,
  ).get(folder.folderId).n;
  if (remaining === 0) {
    sqlite.prepare("UPDATE user_assets SET folder_id=NULL WHERE folder_id=?").run(folder.folderId);
    sqlite.prepare("DELETE FROM user_asset_folders WHERE folder_id=?").run(folder.folderId);
    results.push({ userId: scope.userId, folderRemoved: true });
  } else {
    results.push({ userId: scope.userId, folderKept: `still has ${remaining} visible assets` });
  }
}
console.log(JSON.stringify({ results }, null, 1));
sqlite.close();
