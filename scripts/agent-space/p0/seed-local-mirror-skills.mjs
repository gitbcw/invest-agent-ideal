#!/usr/bin/env node
/** Publish and install the reviewed starter skills in the isolated local mirror only. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(repo, ".state", "production-mirror");
const dbPath = path.join(root, "runtime.db");
if (process.env.DB_PATH && path.resolve(process.env.DB_PATH) !== dbPath) throw new Error("只允许本地 production-mirror 数据库");
if (!fs.existsSync(path.join(root, "mirror-manifest.json")) || !fs.existsSync(dbPath)) throw new Error("本地镜像未准备好");
process.env.DB_PATH = dbPath;
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.join(repo, "templates", "skills");
const { sqlite, initDb } = await import("../../../src/db/index.ts");
initDb();
const ownerToken = sqlite.prepare("SELECT value FROM settings WHERE key='agent_space.owner_admin_token'").get()?.value;
if (!ownerToken) throw new Error("本地镜像没有 Agent Space owner 授权配置");
const space = await import("../../../src/services/agent-space/index.ts");
const mirror = JSON.parse(fs.readFileSync(path.join(root, "mirror-manifest.json"), "utf8"));
const definitions = [
  ["automation-task-designer", true],
  ["skill-creator", true],
  ["candidate-screening", false],
  ["fundamental-analysis", false],
  ["macro-analysis", false],
  ["risk-control", false],
  ["technical-analysis", false],
  // strategy-simulation 已于 2026-10-10 用户裁决从镜像移除（remove-mirror-strategy-simulation.mjs）。
];
const backupPath = path.join(root, "runtime-before-skills.db");
if (!fs.existsSync(backupPath)) await sqlite.backup(backupPath);

for (const [slug, isCore] of definitions) {
  const relative = `${slug}/SKILL.md`;
  const bytes = fs.readFileSync(path.join(repo, "templates", "skills", relative));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const name = bytes.toString("utf8").match(/^# (.+)$/m)?.[1] || slug;
  const description = bytes.toString("utf8").match(/^description:\s*(.+)$/m)?.[1] || "";
  const skill = space.upsertSkill({ domain: "system", scope: null, slug, name, description, isCore, ownerToken, actor: "local-mirror-seed" });
  const published = sqlite.prepare(
    `SELECT r.release_id, r.version_id, v.content_checksum FROM agent_space_skill_releases r
     JOIN agent_space_skill_versions v ON v.version_id=r.version_id
     WHERE r.skill_id=? AND r.release_version='1.0.0' AND r.status='published'`,
  ).get(skill.skill_id);
  let releaseId;
  let versionId;
  if (published) {
    if (published.content_checksum !== checksum) throw new Error(`${slug} 已发布版本与本地模板不一致；需显式发布新版本`);
    ({ release_id: releaseId, version_id: versionId } = published);
  } else {
    const version = await space.addSkillVersion({ domain: "system", scope: null, skillId: skill.skill_id,
      contentRef: { contentRefType: "system_template", systemTemplatePath: relative, contentChecksum: checksum },
      origin: "system_seed", ownerToken, actor: "local-mirror-seed" });
    space.approveSkillVersion({ domain: "system", scope: null, skillId: skill.skill_id, versionId: version.version_id,
      approvedBy: "local-mirror-seed", approvalRef: `owner-decision:local-mirror-skills-${slug}-approve`, ownerToken, actor: "local-mirror-seed" });
    const release = space.publishSkillRelease({ domain: "system", scope: null, skillId: skill.skill_id, versionId: version.version_id,
      releaseVersion: "1.0.0", visibility: "public", publishedBy: "local-mirror-seed", isDefault: true,
      ownerToken, actor: "local-mirror-seed" });
    releaseId = release.releaseId;
    versionId = version.version_id;
  }
  for (const user of mirror.users) {
    const scope = { userId: user.userId, projectId: "invest-agent", instanceId: user.instanceId };
    const agent = sqlite.prepare("SELECT agent_id FROM agent_space_agents WHERE user_id=? AND project_id=? AND instance_id=? AND status='active'").get(scope.userId, scope.projectId, scope.instanceId);
    if (!agent) {
      console.log(`${slug}: skip ${user.userId} (mirror has no active Agent)`);
      continue;
    }
    const existing = sqlite.prepare(
      "SELECT status FROM agent_space_agent_skill_installations WHERE agent_id=? AND skill_id=? LIMIT 1",
    ).get(agent.agent_id, skill.skill_id);
    if (existing) continue; // Do not undo an existing user's disable/remove decision.
    space.installSkill({ scope, agentId: agent.agent_id, skillId: skill.skill_id, source: "release", releaseId, versionId,
      installedBy: "local-mirror-seed", approvalRef: `owner-decision:local-mirror-skills-${user.userId}-${slug}-install`,
      ownerToken, actor: "local-mirror-seed" });
  }
  console.log(`${slug}: ${isCore ? "core" : "manageable"} published and mirrored`);
}
sqlite.close();
console.log(`本地镜像安装完成；原库快照：${backupPath}`);
