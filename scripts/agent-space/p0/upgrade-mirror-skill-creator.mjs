#!/usr/bin/env node
/** 一次性升级：把 skill-creator 系统技能更新到「create 后同轮 install 启用」
 * 口径（2026-10-08 镜像定性修复配套），替换旧「到技能管理页批准」指导。
 * 模式照 upgrade-mirror-simulation.mjs：新版本 → 批准 → 默认发布 → 逐用户升级安装。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve('.state/production-mirror');
if (!fs.existsSync(path.join(root, 'mirror-manifest.json'))) throw new Error('镜像不存在');
process.env.DB_PATH = path.join(root, 'runtime.db');
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, 'runtime');
process.env.SYSTEM_SKILLS_TEMPLATE_ROOT = path.resolve('templates/skills');
const dbModule = await import('../../../src/db/index.ts');
const { sqlite } = dbModule.default ?? dbModule;
const spaceModule = await import('../../../src/services/agent-space/index.ts');
const space = spaceModule.default ?? spaceModule;
const ownerToken = sqlite.prepare('SELECT value FROM settings WHERE key=?').get('agent_space.owner_admin_token')?.value;
if (!ownerToken) throw new Error('镜像 owner 配置缺失');
await sqlite.backup(path.join(root, `before-skill-creator-upgrade-${Date.now()}.db`));

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'mirror-manifest.json'), 'utf8'));
const skillId = sqlite.prepare('SELECT skill_id FROM agent_space_skills WHERE domain=? AND slug=?').get('system', 'skill-creator').skill_id;
const bytes = fs.readFileSync('templates/skills/skill-creator/SKILL.md');
const checksum = createHash('sha256').update(bytes).digest('hex');
const currentDefault = sqlite.prepare('SELECT v.content_checksum AS checksum FROM agent_space_skill_releases r JOIN agent_space_skill_versions v ON v.version_id=r.version_id WHERE r.skill_id=? AND r.is_default=1').get(skillId);
if (currentDefault?.checksum === checksum) {
  console.log('模板未变化，无需升级');
  sqlite.close();
  process.exit(0);
}
const version = await space.addSkillVersion({ domain: 'system', scope: null, skillId, contentRef: { contentRefType: 'system_template', systemTemplatePath: 'skill-creator/SKILL.md', contentChecksum: checksum }, origin: 'system_seed', ownerToken, actor: 'skill-creator-same-turn-install' });
space.approveSkillVersion({ domain: 'system', scope: null, skillId, versionId: version.version_id, approvedBy: 'skill-creator-same-turn-install', approvalRef: `owner-decision:skill-creator-same-turn-install-${checksum}`, ownerToken, actor: 'skill-creator-same-turn-install' });
const release = space.publishSkillRelease({ domain: 'system', scope: null, skillId, versionId: version.version_id, releaseVersion: `1.1.0-${checksum.slice(0, 8)}`, visibility: 'public', publishedBy: 'skill-creator-same-turn-install', isDefault: true, ownerToken, actor: 'skill-creator-same-turn-install' });
const results = [];
for (const user of manifest.users) {
  const scope = { userId: user.userId, projectId: user.projectId, instanceId: user.instanceId };
  const agent = sqlite.prepare('SELECT agent_id FROM agent_space_agents WHERE user_id=? AND instance_id=? AND status=?').get(user.userId, user.instanceId, 'active');
  if (!agent) { results.push({ user: user.userId, skipped: 'no active agent' }); continue; }
  space.installSkill({ scope, agentId: agent.agent_id, skillId, source: 'release', releaseId: release.releaseId, versionId: version.version_id, installedBy: 'skill-creator-same-turn-install', approvalRef: `owner-decision:skill-creator-${user.userId}-${checksum}`, ownerToken, actor: 'skill-creator-same-turn-install' });
  results.push({ user: user.userId, versionId: version.version_id });
}
console.log(JSON.stringify({ releaseVersion: `1.1.0-${checksum.slice(0, 8)}`, checksum, users: results }, null, 1));
sqlite.close();
