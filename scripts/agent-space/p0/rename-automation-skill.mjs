#!/usr/bin/env node
/** 2026-10-09 术语改名（owner 裁决：定时任务 → 定时任务）：
 * 系统播种技能的存量 DB 行跟进模板更新——模板文件已全局替换，本脚本对
 * 清单内技能逐个执行：
 *   1) skill 行名称/描述更新（描述取模板 frontmatter，与新模板一致）
 *   2) 以当前模板发新版本（system_template 引用 + 新校验和 + 字节保全）
 *   3) 发布新 release 设默认，旧默认退位
 *   4) 存量安装重指向新版本（已装用户立即看到新文案）
 * 幂等：按 release_version 存在即跳过。生产部署时对生产库同样执行。
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(repoRoot, ".state", "production-mirror");
// 镜像运维脚本必须钉住数据根，否则会写错位到仓库 data/（2026-10-09 事故）。
process.env.MASTRA_PROJECTS_ROOT = path.join(mirrorRoot, "projects");
process.env.DB_PATH = process.env.DB_PATH || path.join(mirrorRoot, "runtime.db");
process.env.RUNTIME_DATA_ROOT = path.join(mirrorRoot, "runtime");

const { sqlite } = await import(path.join(repoRoot, "src", "db", "index.ts"));
const skills = await import(path.join(repoRoot, "src", "services", "agent-space", "skills.ts"));

const ACTOR = "ops:rename-automation-20261009";
const RELEASE_TAG = "2026.10.09-rename-dingshi";

// slug → 新名称（缺省不改名）。描述一律取当前模板 frontmatter。
const PLAN = [
  { slug: "automation-task-designer", name: "定时任务设计" },
  { slug: "strategy-simulation", name: null },
];

const ownerRow = sqlite.prepare("SELECT value FROM settings WHERE key=?").get("agent_space.owner_admin_token");
if (!ownerRow?.value) throw new Error("镜像 settings 缺 owner 令牌，无法执行系统域写入");
const ownerToken = String(ownerRow.value).trim();

for (const item of PLAN) {
  const [skill] = sqlite.prepare(
    "SELECT skill_id AS id, name, description FROM agent_space_skills WHERE slug=? AND domain='system' AND status='active'",
  ).all(item.slug) ?? [];
  if (!skill) {
    console.log(`[${item.slug}] 未找到系统技能（未播种？），跳过`);
    continue;
  }
  const templateRel = `${item.slug}/SKILL.md`;
  const releaseVersion = `${RELEASE_TAG}-${item.slug}`;
  const existing = sqlite.prepare(
    "SELECT release_id FROM agent_space_skill_releases WHERE skill_id=? AND release_version=?",
  ).get(skill.id, releaseVersion);
  if (existing) {
    console.log(`[${item.slug}] release 已存在，跳过`);
    continue;
  }
  const templateBytes = await readFile(path.join(repoRoot, "templates", "skills", templateRel));
  const newChecksum = createHash("sha256").update(templateBytes).digest("hex");
  const descMatch = templateBytes.toString("utf8").match(/^description:\s*(.+)$/m);
  const newDescription = descMatch?.[1]?.trim();

  const nextName = item.name ?? skill.name;
  sqlite.prepare("UPDATE agent_space_skills SET name=?, description=?, updated_at=? WHERE skill_id=?")
    .run(nextName, newDescription ?? skill.description, new Date().toISOString(), skill.id);

  const version = await skills.addSkillVersion({
    domain: "system",
    scope: null,
    skillId: skill.id,
    contentRef: { contentRefType: "system_template", systemTemplatePath: templateRel, contentChecksum: newChecksum },
    origin: "system_seed",
    ownerToken,
    actor: ACTOR,
  });
  skills.approveSkillVersion({
    domain: "system",
    scope: null,
    skillId: skill.id,
    versionId: version.version_id,
    approvedBy: ACTOR,
    approvalRef: `owner-decision:rename-automation-task-to-scheduled-task-20261009-${item.slug}`,
    ownerToken,
    actor: ACTOR,
  });
  const published = skills.publishSkillRelease({
    domain: "system",
    scope: null,
    skillId: skill.id,
    versionId: version.version_id,
    releaseVersion,
    visibility: "public",
    publishedBy: ACTOR,
    isDefault: true,
    ownerToken,
    actor: ACTOR,
  });
  sqlite.prepare("UPDATE agent_space_skill_releases SET is_default=0 WHERE skill_id=? AND release_id!=?")
    .run(skill.id, published.releaseId);
  const repointed = sqlite.prepare(
    "UPDATE agent_space_agent_skill_installations SET version_id=?, release_id=?, release_version=? WHERE skill_id=? AND status IN ('installed','disabled')",
  ).run(version.version_id, published.releaseId, releaseVersion, skill.id).changes;

  console.log(`[${item.slug}] 「${nextName}」 v=${version.version_id} release=${releaseVersion} 安装重指向 ${repointed} 个`);
}
console.log("done");
process.exit(0);
