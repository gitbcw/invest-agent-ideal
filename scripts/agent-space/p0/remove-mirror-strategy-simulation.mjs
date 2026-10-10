#!/usr/bin/env node
/**
 * 2026-10-10 用户裁决：从本地 production-mirror 移除「量化策略模拟」(strategy-simulation)。
 * - 对所有有 installed 记录的镜像用户走服务层 removeInstalledSkill（审计保留）；
 * - 将 system 域技能行打墓碑 status='deleted'（沿用库内既有约定），使技能目录与
 *   冷启动播种（agent-space-context.ts 只装 status='active' 的系统技能）都不再出现；
 * - 历史版本/发布/安装记录保留，可审计、可回溯。
 * 后续（同日用户裁决「都清理掉」）：模板目录已删除，库内全部痕迹由
 * purge-mirror-strategy-simulation.mjs 清除（含本脚本产生的 removed 状态与审计行）。
 */
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
const { sqlite, initDb } = await import("../../../src/db/index.ts");
initDb();
const ownerToken = sqlite.prepare("SELECT value FROM settings WHERE key='agent_space.owner_admin_token'").get()?.value;
if (!ownerToken) throw new Error("本地镜像没有 Agent Space owner 授权配置");

const SLUG = "strategy-simulation";
const skill = sqlite.prepare("SELECT skill_id, name, status FROM agent_space_skills WHERE domain='system' AND slug=?").get(SLUG);
if (!skill) throw new Error(`system skill ${SLUG} 不存在`);
const { removeInstalledSkill } = await import("../../../src/services/agent-space/agents.ts");
const mirror = JSON.parse(fs.readFileSync(path.join(root, "mirror-manifest.json"), "utf8"));

const tx = sqlite.transaction(() => {
  let removed = 0;
  for (const user of mirror.users) {
    const scope = { userId: user.userId, projectId: "invest-agent", instanceId: user.instanceId };
    const agent = sqlite.prepare("SELECT agent_id FROM agent_space_agents WHERE user_id=? AND project_id=? AND instance_id=? AND status='active'").get(scope.userId, scope.projectId, scope.instanceId);
    if (!agent) continue;
    const installed = sqlite.prepare(
      "SELECT installation_id FROM agent_space_agent_skill_installations WHERE agent_id=? AND skill_id=? AND status IN ('installed','disabled')",
    ).get(agent.agent_id, skill.skill_id);
    if (!installed) continue;
    removeInstalledSkill({
      scope,
      agentId: agent.agent_id,
      skillId: skill.skill_id,
      approvalRef: `owner-decision:local-mirror-remove-${SLUG}-${user.userId}`,
      ownerToken,
      actor: "local-mirror-simulation-removal",
    });
    removed += 1;
    console.log(`${user.userId}: removed ${SLUG}`);
  }
  const tombstone = sqlite.prepare("UPDATE agent_space_skills SET status='deleted', updated_at=? WHERE skill_id=? AND status!='deleted'").run(new Date().toISOString(), skill.skill_id);
  console.log(`system skill ${SLUG} tombstoned: ${tombstone.changes ? "yes" : "already"}`);
  return removed;
});
const removed = tx();
sqlite.close();
console.log(`完成：${removed} 个镜像用户卸载，系统技能已打墓碑`);
