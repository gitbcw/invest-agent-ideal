#!/usr/bin/env node
/**
 * T-538: 在 111 隔离库构造工作空间对象（经服务层 API，不手写 agent_space 表行）。
 *
 * 产物形态（对应 GUI 验证需要）：
 *   - 1 个方法体系（≥2 版本：v1 采用后被替代、v2 当前采用、v3 待确认草稿），
 *     并绑定到 111 的 daily-review 自动化任务（pinned v2）；
 *   - 2 个私有 Skill（其一首个版本启用 + 安装到 111 Agent；其二留草稿展示待确认态）。
 *
 * 幂等：方法/Skill 按 name/slug 判存在即跳过；绑定按 taskId+kind+refId 唯一键 upsert。
 * 护栏：DB_PATH 必须指向 .state/agent-space-p0（拒绝任何其他库）。
 *
 * 用法（隔离环境数据面即可，无需起 runtime）：
 *   DB_PATH=.state/agent-space-p0/runtime.db MASTRA_PROJECTS_ROOT=.state/agent-space-p0/projects \
 *     WORKSPACE_ROOT=.state/agent-space-p0/workspaces RUNTIME_DATA_ROOT=.state/agent-space-p0/runtime \
 *     node --import tsx scripts/agent-space/p0/seed-workspace-objects.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const P0_ROOT = path.resolve(".state/agent-space-p0");
const CONTAINER = path.join(P0_ROOT, "projects", "10849b69cdfa1b7a8c581a7b");

// —— 护栏：只允许隔离库 ——
const dbPath = process.env.DB_PATH || "";
if (!dbPath.includes("agent-space-p0")) {
  console.error(`拒绝执行：DB_PATH=${dbPath} 不是 111 隔离库（.state/agent-space-p0）`);
  process.exit(1);
}

const { initDb } = await import("../../../src/db/index.js");
initDb();
const space = await import("../../../src/services/agent-space/index.js");

const SCOPE = { userId: "111", projectId: "invest-agent", instanceId: "invest-agent-111" };
const ACTOR = "p0-seed";
const METHOD_NAME = "111 隔离验证方法体系（自容器 strategy-rules 构造）";
const TASK_ID = "migrated_scheduled-daily-review_fa57baa2";

const strategyText = readFileSync(path.join(CONTAINER, "methods", "strategy-rules.md"), "utf8");
const skillTexts = ["fundamental-analysis", "technical-analysis"].map((slug) =>
  readFileSync(path.join(CONTAINER, "skills", slug, "SKILL.md"), "utf8"),
);

// ---------- 方法体系 ----------
const methods = space.listPortalMethods(SCOPE);
let methodCard = methods.find((m) => m.name === METHOD_NAME) || null;
if (!methodCard) {
  const created = await space.portalCreateMethod({
    scope: SCOPE,
    name: METHOD_NAME,
    description: "T-538 构造：验证列表卡片、版本时间线、采用/恢复、任务绑定与 Diff。",
    text: strategyText,
    idempotencyKey: "p0-seed:method-v1",
    actor: ACTOR,
  });
  // v2：修订正文并显式采用（v1 → superseded）
  const v2 = await space.portalAddMethodVersion({
    scope: SCOPE,
    methodId: created.method.method_id,
    text: strategyText + "\n\n## 修订（p0-seed v2）\n\n- 构造修订用于验证 Diff 与恢复采用路径。\n",
    idempotencyKey: "p0-seed:method-v2",
    actor: ACTOR,
  });
  await space.portalAdoptMethodVersion(
    { scope: SCOPE, actor: ACTOR, idempotencyKey: "p0-seed:adopt-v2" },
    created.method.method_id,
    v2.version.version_id,
  );
  // v3：待确认草稿（不采用，展示 pending 状态）
  await space.portalAddMethodVersion({
    scope: SCOPE,
    methodId: created.method.method_id,
    text: strategyText + "\n\n## 待确认修改（p0-seed v3 草稿）\n\n- 该版本保持草稿态，验证「保存≠生效」。\n",
    idempotencyKey: "p0-seed:method-v3",
    actor: ACTOR,
  });
  methodCard = space.getPortalMethodCard(SCOPE, created.method.method_id);
  console.log(`[method] 已创建 ${METHOD_NAME}（当前采用 v${methodCard.currentVersionNumber}，待确认草稿 ${methodCard.pendingDraft ? `v${methodCard.pendingDraft.versionNumber}` : "无"}）`);
} else {
  console.log(`[method] 已存在，跳过：${METHOD_NAME}`);
}

// 绑定到 daily-review 任务（pinned 当前采用版本）
space.upsertTaskDependency({
  scope: SCOPE,
  taskId: TASK_ID,
  kind: "method",
  refId: methodCard.methodId,
  versionPolicy: "pinned",
  pinnedVersionId: methodCard.currentVersionId,
  actor: ACTOR,
});
console.log(`[method] 已绑定任务 ${TASK_ID} → pinned v${methodCard.currentVersionNumber}`);

// ---------- 私有 Skills ----------
const skillSeeds = [
  { slug: "p0-fundamental-analysis", name: "基本面分析（p0 构造）", text: skillTexts[0], enableAndInstall: true },
  { slug: "p0-technical-analysis", name: "技术面分析（p0 构造）", text: skillTexts[1], enableAndInstall: false },
];
const agents = space.listPortalAgents(SCOPE);
if (agents.length === 0) throw new Error("111 scope 无 Agent，先运行 W7 建档或检查隔离库");
const agent = agents[0];

for (const seed of skillSeeds) {
  const existing = space.listPortalPrivateSkills(SCOPE).find((s) => s.slug === seed.slug);
  if (existing) {
    if (seed.enableAndInstall && !existing.installation) {
      // 之前运行在安装步失败（create/approve 已提交）——补装当前启用版本
      space.portalInstallSkill({
        ctx: { scope: SCOPE, actor: ACTOR, idempotencyKey: `p0-seed:install-retry:${seed.slug}` },
        agentId: agent.agentId,
        skillId: existing.skillId,
        source: "private",
        versionId: existing.currentVersionId,
        installedBy: ACTOR,
      });
      console.log(`[skill] 补装完成：${seed.slug}`);
    } else {
      console.log(`[skill] 已存在，跳过：${seed.slug}`);
    }
    continue;
  }
  const created = await space.portalCreateSkill({
    scope: SCOPE,
    slug: seed.slug,
    name: seed.name,
    description: "T-538 构造 Skill，验证私有列表、启用与安装链路。",
    text: seed.text,
    idempotencyKey: `p0-seed:skill:${seed.slug}`,
    actor: ACTOR,
  });
  if (seed.enableAndInstall) {
    await space.portalApproveSkillVersion({ scope: SCOPE, actor: ACTOR, idempotencyKey: `p0-seed:enable:${seed.slug}` }, created.skill.skill_id, created.version.version_id);
    space.portalInstallSkill({
      ctx: { scope: SCOPE, actor: ACTOR, idempotencyKey: `p0-seed:install:${seed.slug}` },
      agentId: agent.agentId,
      skillId: created.skill.skill_id,
      source: "private",
      versionId: created.version.version_id,
      installedBy: ACTOR,
    });
    console.log(`[skill] 已创建+启用+安装：${seed.slug}`);
  } else {
    console.log(`[skill] 已创建（草稿态）：${seed.slug}`);
  }
}

// ---------- 汇总 ----------
const finalMethods = space.listPortalMethods(SCOPE);
const finalSkills = space.listPortalPrivateSkills(SCOPE);
const finalInstalled = space.listPortalInstalledSkills(SCOPE);
console.log("\n构造结果：");
console.log(`  方法 ${finalMethods.length} 个：${finalMethods.map((m) => `${m.name}(v${m.currentVersionNumber ?? "-"}, tasks=${m.taskBindingCount}, draft=${m.pendingDraft ? 1 : 0})`).join("; ")}`);
console.log(`  私有 Skill ${finalSkills.length} 个：${finalSkills.map((s) => `${s.slug}(installed=${s.installation ? 1 : 0}, draft=${s.pendingDraft ? 1 : 0})`).join("; ")}`);
console.log(`  已安装 Skill ${finalInstalled.items.length} 个`);
console.log("完成。GUI 验证入口：start-isolated.mjs → http://127.0.0.1:3110/workspace");
