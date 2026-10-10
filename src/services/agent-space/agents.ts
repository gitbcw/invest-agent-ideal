/**
 * Agent 控制面对象（W1/W4 底座）：Agent 身份、技能安装、方法绑定、资产授权。
 *
 * 语义（v3 §2）：Agent 持有安装清单而非 Skill 正文副本；安装固定版本，升级
 * 由用户批准；方法绑定明确版本策略；资产按授权引用，不复制正文。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertIdempotencyConsistent,
  assertRowScope,
  assertScopeValid,
  findByIdempotencyKey,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  recordAuthorizationOutcome,
  verifyAuthorization,
  type UserScope,
} from "./core.js";
import {
  assertReleaseInstallableBy,
  getReleaseRow as getSkillReleaseRow,
  getVersionRow as getSkillVersionRow,
  listDefaultReleases,
  readSkillVersionContentBytes,
} from "./skills.js";
import { resolveMethodVersion } from "./methods.js";

export interface CreateAgentInput {
  scope: UserScope;
  name: string;
  description?: string;
  idempotencyKey?: string;
  actor: string;
}

type AgentRow = {
  agent_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "disabled";
  created_at: string;
  updated_at: string;
};

type InstallationRow = {
  installation_id: string;
  agent_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  skill_id: string;
  source: "release" | "private";
  release_id: string | null;
  release_version: string | null;
  version_id: string;
  status: "installed" | "disabled" | "superseded" | "removed";
  installed_by: string | null;
  installed_at: string;
  approval_ref: string | null;
  created_at: string;
};

function getInstallationRow(scope: UserScope, installationId: string): InstallationRow {
  const row = sqlite
    .prepare("SELECT * FROM agent_space_agent_skill_installations WHERE installation_id=?")
    .get(installationId) as InstallationRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `installation ${installationId}`);
  assertRowScope(row, scope);
  return row;
}

export function getAgent(scope: UserScope, agentId: string): AgentRow {
  assertScopeValid(scope);
  const row = sqlite.prepare("SELECT * FROM agent_space_agents WHERE agent_id=?").get(agentId) as AgentRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `agent ${agentId}`);
  assertRowScope(row, scope);
  return row;
}

export function createAgent(input: CreateAgentInput): AgentRow {
  assertScopeValid(input.scope);
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_agents", input.scope, input.idempotencyKey);
    assertIdempotencyConsistent(existing, (row) => String(row.name), input.name, "createAgent");
    if (existing) return existing as unknown as AgentRow;
  }
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    const agentId = newId("agent");
    sqlite
      .prepare(
        `INSERT INTO agent_space_agents (agent_id, user_id, project_id, instance_id, name, description, status, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.name, input.description ?? null, input.idempotencyKey ?? null, now, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "agent.created",
      objectType: "agent_space_agent",
      objectId: agentId,
      toStatus: "draft",
    });
    return agentId;
  });
  return getAgent(input.scope, tx());
}

export function setAgentStatus(scope: UserScope, agentId: string, status: "active" | "disabled", actor: string): AgentRow {
  assertScopeValid(scope);
  const agent = getAgent(scope, agentId);
  const allowed: Record<string, string[]> = { draft: ["active", "disabled"], active: ["disabled"], disabled: ["active"] };
  if (!allowed[agent.status]?.includes(status)) {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `${agent.status} -> ${status} is not allowed`);
  }
  sqlite.prepare("UPDATE agent_space_agents SET status=?, updated_at=? WHERE agent_id=?").run(status, nowIso(), agentId);
  recordAgentSpaceAudit({
    scope,
    actor,
    action: "agent.status_changed",
    objectType: "agent_space_agent",
    objectId: agentId,
    fromStatus: agent.status,
    toStatus: status,
  });
  return getAgent(scope, agentId);
}

/**
 * 安装技能：固定到具体 release（发布版本）或本 scope 已批准的私有版本。
 * draft 版本不可安装；升级 = 新安装行（带批准依据），旧行标 superseded。
 */
export function installSkill(input: {
  scope: UserScope;
  agentId: string;
  skillId: string;
  source: "release" | "private";
  releaseId?: string;
  versionId: string;
  installedBy: string;
  /** 升级（同技能已有安装）时必须提供；首次安装也记录用户动作依据。 */
  approvalRef: string;
  ownerToken?: string;
  actor: string;
}): InstallationRow {
  assertScopeValid(input.scope);
  const agent = getAgent(input.scope, input.agentId);
  if (agent.status === "disabled") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "disabled agent cannot install skills");
  }
  // 版本身份校验（解析安装目标，供授权绑定使用）。
  const version = getSkillVersionRow(input.versionId);
  if (version.skill_id !== input.skillId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to skill");
  }
  // 2026-10-08 裁决「删除就消失」：墓碑技能不可再安装（含其历史发布）。
  const skillRow = sqlite.prepare("SELECT status FROM agent_space_skills WHERE skill_id=?").get(input.skillId) as { status: string } | undefined;
  if (skillRow?.status === "deleted") {
    throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${input.skillId} has been deleted`);
  }
  const tx = sqlite.transaction(() => {
    // R9：核验+消耗与安装写入、审计同事务。releaseId 影响安装结果（发布来源
    // 与发布版本号），release 安装纳入完整操作绑定（验收 R9 第五轮）。
    const installExtra: Record<string, string> = { skillId: input.skillId, source: input.source };
    if (input.source === "release") installExtra.releaseId = input.releaseId ?? "";
    const approval = verifyAuthorization(
      input.scope,
      { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: input.agentId, versionId: input.versionId, extraBinding: installExtra },
      input.approvalRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回首次安装行本身（可能已被后续升级
    // superseded），不把当前安装降回旧版本、不新增安装/审计。授权凭证与
    // owner 决策记录都携带稳定结果，回放不依赖可变业务行。
    if (approval.replayed) {
      return getInstallationRow(input.scope, (approval.replayResult as { installationId: string }).installationId);
    }
    // 业务校验在消费之后、写入之前执行：失败随事务回滚，凭证不失耗。
    const currentVersion = getSkillVersionRow(input.versionId);
    if (input.source === "private") {
      if (currentVersion.domain !== "user") {
        throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "private install requires a user-domain skill version");
      }
      assertRowScope(currentVersion, input.scope);
      if (currentVersion.status !== "approved") {
        throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "draft skill versions cannot be installed");
      }
    } else {
      if (!input.releaseId) {
        throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "release install requires releaseId");
      }
      const release = getSkillReleaseRow(input.releaseId);
      if (release.version_id !== input.versionId) {
        throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "release does not pin this version");
      }
      // R2：可见性/发布状态/属主判定在服务层强制（public 跨用户、private 属主、shared fail-closed）。
      assertReleaseInstallableBy(release, input.scope);
    }
    const previous = sqlite
      .prepare(
        `SELECT * FROM agent_space_agent_skill_installations
         WHERE agent_id=? AND skill_id=? AND status IN ('installed','disabled')`,
      )
      .get(input.agentId, input.skillId) as InstallationRow | undefined;
    const isUpgrade = Boolean(previous);
    if (previous) {
      sqlite
        .prepare("UPDATE agent_space_agent_skill_installations SET status='superseded' WHERE installation_id=?")
        .run(previous.installation_id);
    }
    const installationId = newId("skinst");
    const now = nowIso();
    sqlite
      .prepare(
        `INSERT INTO agent_space_agent_skill_installations (
           installation_id, agent_id, user_id, project_id, instance_id, skill_id,
           source, release_id, release_version, version_id, status, installed_by, installed_at, approval_ref, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'installed', ?, ?, ?, ?)`,
      )
      .run(installationId, input.agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.skillId, input.source, input.releaseId ?? null, input.source === "release" ? (sqlite.prepare("SELECT release_version FROM agent_space_skill_releases WHERE release_id=?").get(input.releaseId ?? "") as { release_version: string } | undefined)?.release_version ?? null : null,
           input.versionId, input.installedBy, now, input.approvalRef, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: isUpgrade ? "agent.skill.upgraded" : "agent.skill.installed",
      objectType: "agent_space_agent_skill_installation",
      objectId: installationId,
      toStatus: "installed",
      detail: {
        agentId: input.agentId,
        skillId: input.skillId,
        versionId: input.versionId,
        source: input.source,
        supersededInstallationId: previous?.installation_id ?? null,
        approvalRef: input.approvalRef,
      },
    });
    recordAuthorizationOutcome(approval.authorizationId, { installationId });
    return getInstallationRow(input.scope, installationId);
  });
  return tx();
}

/** 当前有效安装清单：每技能一行固定版本。 */
export function listInstalledSkills(scope: UserScope, agentId: string): InstallationRow[] {
  assertScopeValid(scope);
  getAgent(scope, agentId);
  const rows = sqlite
    .prepare(
      `SELECT * FROM agent_space_agent_skill_installations
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='installed'`,
    )
    .all(agentId, scope.userId, scope.projectId, scope.instanceId) as InstallationRow[];
  const bySkill = new Map<string, InstallationRow>();
  for (const row of rows) if (!bySkill.has(row.skill_id)) bySkill.set(row.skill_id, row);
  return [...bySkill.values()];
}

// ---------- W3：默认清单、移除与运行时固定版本解析 ----------

/**
 * 默认技能清单（W3，返工 W3-R2）：**一次性的 Agent 初始化事件**。首次执行
 * 冻结当时的默认清单（空清单也记录完成），此后平台新增/升级默认发布都不会
 * 再给该 Agent 自动扩容——后续增删只能走显式授权安装/移除。默认目录是 owner
 * 治理的系统策略（系统域发布须 owner 令牌，is_default 仅系统域可携带），因此
 * 本入口是受信服务入口，不走用户授权凭证；approval_ref='default-manifest'
 * 是来源标记而非凭证。初始化整体单事务：失败回滚（标记不落、安装不落），
 * 重试从头执行得到一致结果；已初始化 Agent 重跑为纯 no-op（零写入零审计）。
 */
export function applyDefaultSkillManifest(input: {
  scope: UserScope;
  agentId: string;
  actor: string;
}): { appliedInstallationIds: string[]; skippedSkillIds: string[]; alreadyInitialized: boolean } {
  assertScopeValid(input.scope);
  const agent = getAgent(input.scope, input.agentId);
  if (agent.status === "disabled") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "disabled agent cannot receive the default manifest");
  }
  const defaults = listDefaultReleases();
  const tx = sqlite.transaction(() => {
    const agentRow = sqlite
      .prepare("SELECT default_manifest_applied_at FROM agent_space_agents WHERE agent_id=?")
      .get(input.agentId) as { default_manifest_applied_at: string | null };
    if (agentRow.default_manifest_applied_at) {
      return { appliedInstallationIds: [] as string[], skippedSkillIds: [] as string[], alreadyInitialized: true };
    }
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const release of defaults) {
      const existing = sqlite
        .prepare(
          `SELECT installation_id FROM agent_space_agent_skill_installations
           WHERE agent_id=? AND skill_id=? AND user_id=? AND project_id=? AND instance_id=? LIMIT 1`,
        )
        .get(input.agentId, release.skill_id, input.scope.userId, input.scope.projectId, input.scope.instanceId) as
        | { installation_id: string }
        | undefined;
      if (existing) {
        skipped.push(release.skill_id);
        continue;
      }
      const installationId = newId("skinst");
      const now = nowIso();
      sqlite
        .prepare(
          `INSERT INTO agent_space_agent_skill_installations (
             installation_id, agent_id, user_id, project_id, instance_id, skill_id,
             source, release_id, release_version, version_id, status, installed_by, installed_at, approval_ref, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'release', ?, ?, ?, 'installed', 'system-default', ?, 'default-manifest', ?)`,
        )
        .run(installationId, input.agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
             release.skill_id, release.release_id, release.release_version, release.version_id, now, now);
      recordAgentSpaceAudit({
        scope: input.scope,
        actor: input.actor,
        action: "agent.skill.default_applied",
        objectType: "agent_space_agent_skill_installation",
        objectId: installationId,
        toStatus: "installed",
        detail: { agentId: input.agentId, skillId: release.skill_id, releaseId: release.release_id, versionId: release.version_id, origin: "default-manifest" },
      });
      applied.push(installationId);
    }
    // 冻结清单：初始化完成标记 + 汇总审计（含当时默认集、实际安装与跳过）。
    const now = nowIso();
    sqlite
      .prepare("UPDATE agent_space_agents SET default_manifest_applied_at=?, updated_at=? WHERE agent_id=?")
      .run(now, now, input.agentId);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "agent.default_manifest_applied",
      objectType: "agent_space_agent",
      objectId: input.agentId,
      toStatus: "initialized",
      detail: {
        defaultReleaseIds: defaults.map((r) => r.release_id),
        appliedInstallationIds: applied,
        skippedSkillIds: skipped,
        emptyManifest: defaults.length === 0,
      },
    });
    return { appliedInstallationIds: applied, skippedSkillIds: skipped, alreadyInitialized: false };
  });
  return tx();
}

/**
 * 显式移除安装（W3）：用户决定，走授权凭证（operation=skill.remove，绑定
 * agentId+skillId）；R9 契约同安装——核验+消耗+状态转换+审计+结果记录同事务，
 * 重放返回原结果。安装行保留（status=removed）供追溯，运行解析随即拒绝。
 * 2026-10-08 裁决「删除就消失」：卸载 user 域技能时同事务给技能行打墓碑
 * （status='deleted'，slug 让位 `-deleted-<时间戳>`，避开 (domain,scope,slug)
 * 唯一约束），此后私有列表/目录/找回面都不再出现；系统域行为不变（卸载后仍可
 * 从目录找回）。
 */
export function removeInstalledSkill(input: {
  scope: UserScope;
  agentId: string;
  skillId: string;
  approvalRef: string;
  ownerToken?: string;
  actor: string;
}): { installationId: string; status: "removed" } {
  assertScopeValid(input.scope);
  getAgent(input.scope, input.agentId);
  const tx = sqlite.transaction(() => {
    const approval = verifyAuthorization(
      input.scope,
      { operation: "skill.remove", objectType: "agent_space_agent_skill_installation", objectId: input.agentId, versionId: null, extraBinding: { skillId: input.skillId } },
      input.approvalRef,
      input.ownerToken,
    );
    if (approval.replayed) {
      const stored = approval.replayResult as { installationId: string };
      const row = getInstallationRow(input.scope, stored.installationId);
      return { installationId: row.installation_id, status: row.status };
    }
    const installed = sqlite
      .prepare(
        `SELECT * FROM agent_space_agent_skill_installations
         WHERE agent_id=? AND skill_id=? AND user_id=? AND project_id=? AND instance_id=? AND status IN ('installed','disabled')`,
      )
      .get(input.agentId, input.skillId, input.scope.userId, input.scope.projectId, input.scope.instanceId) as InstallationRow | undefined;
    if (!installed) {
      throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "skill is not installed for this agent");
    }
    const skill = sqlite.prepare("SELECT is_core, domain, slug, status FROM agent_space_skills WHERE skill_id=?").get(input.skillId) as { is_core: number; domain: string; slug: string; status: string } | undefined;
    if (skill?.is_core === 1) throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "core skill cannot be removed by a user");
    const dependencies = sqlite.prepare(
      `SELECT COUNT(*) AS n FROM agent_space_task_dependencies
       WHERE user_id=? AND project_id=? AND instance_id=? AND kind='skill' AND ref_id=?`,
    ).get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.skillId) as { n: number };
    if (dependencies.n > 0) {
      throw new AgentSpaceError("AGENT_SPACE_ADOPTION_CONSTRAINT", "先调整引用此 Skill 的任务，再卸载");
    }
    sqlite
      .prepare("UPDATE agent_space_agent_skill_installations SET status='removed' WHERE installation_id=?")
      .run(installed.installation_id);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "agent.skill.removed",
      objectType: "agent_space_agent_skill_installation",
      objectId: installed.installation_id,
      fromStatus: installed.status,
      toStatus: "removed",
      detail: { agentId: input.agentId, skillId: input.skillId, versionId: installed.version_id, approvalRef: input.approvalRef },
    });
    // 2026-10-08 裁决「删除就消失」：user 域技能在移除安装的同一事务打墓碑；
    // slug 改名让出 (domain,scope,slug) 唯一约束，之后同 slug 可重新创建。
    // 系统域（含预置发布）不打墓碑，卸载后仍可从目录找回。
    if (skill && skill.domain === "user" && skill.status !== "deleted") {
      const tombstoneSlug = `${skill.slug}-deleted-${Date.now()}`;
      sqlite
        .prepare("UPDATE agent_space_skills SET status='deleted', slug=?, updated_at=? WHERE skill_id=?")
        .run(tombstoneSlug, nowIso(), input.skillId);
      recordAgentSpaceAudit({
        scope: input.scope,
        actor: input.actor,
        action: "skill.tombstoned",
        objectType: "agent_space_skill",
        objectId: input.skillId,
        fromStatus: skill.status,
        toStatus: "deleted",
        detail: { agentId: input.agentId, slug: skill.slug, tombstoneSlug, approvalRef: input.approvalRef },
      });
    }
    recordAuthorizationOutcome(approval.authorizationId, { installationId: installed.installation_id });
    return { installationId: installed.installation_id, status: "removed" as const };
  });
  return tx();
}

/** Keep the installation/version fixed while changing availability for future runs. */
export function setInstalledSkillEnabled(input: {
  scope: UserScope; agentId: string; skillId: string; enabled: boolean;
  approvalRef: string; ownerToken?: string; actor: string;
}): { installationId: string; status: "installed" | "disabled" } {
  assertScopeValid(input.scope);
  getAgent(input.scope, input.agentId);
  const status = input.enabled ? "installed" : "disabled";
  const tx = sqlite.transaction(() => {
    const approval = verifyAuthorization(input.scope, {
      operation: "skill.installation.set_enabled", objectType: "agent_space_agent_skill_installation",
      objectId: input.agentId, versionId: null,
      extraBinding: { skillId: input.skillId, enabled: String(input.enabled) },
    }, input.approvalRef, input.ownerToken);
    if (approval.replayed) return approval.replayResult as { installationId: string; status: "installed" | "disabled" };
    const row = sqlite.prepare(
      `SELECT i.*, s.is_core FROM agent_space_agent_skill_installations i
       JOIN agent_space_skills s ON s.skill_id=i.skill_id
       WHERE i.agent_id=? AND i.skill_id=? AND i.user_id=? AND i.project_id=? AND i.instance_id=?
         AND i.status IN ('installed','disabled')`,
    ).get(input.agentId, input.skillId, input.scope.userId, input.scope.projectId, input.scope.instanceId) as (InstallationRow & { is_core: number }) | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", "skill is not installed for this agent");
    if (row.is_core === 1) throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "core skill cannot be disabled by a user");
    if (row.status === status) throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `skill is already ${status}`);
    if (!input.enabled) {
      const deps = sqlite.prepare(
        `SELECT COUNT(*) AS n FROM agent_space_task_dependencies
         WHERE user_id=? AND project_id=? AND instance_id=? AND kind='skill' AND ref_id=?`,
      ).get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.skillId) as { n: number };
      if (deps.n > 0) throw new AgentSpaceError("AGENT_SPACE_ADOPTION_CONSTRAINT", "先调整引用此 Skill 的任务，再停用");
    }
    sqlite.prepare("UPDATE agent_space_agent_skill_installations SET status=? WHERE installation_id=?").run(status, row.installation_id);
    recordAgentSpaceAudit({ scope: input.scope, actor: input.actor,
      action: input.enabled ? "agent.skill.enabled" : "agent.skill.disabled",
      objectType: "agent_space_agent_skill_installation", objectId: row.installation_id,
      fromStatus: row.status, toStatus: status,
      detail: { agentId: input.agentId, skillId: input.skillId, versionId: row.version_id },
    });
    const result = { installationId: row.installation_id, status };
    recordAuthorizationOutcome(approval.authorizationId, result);
    return result;
  });
  return tx();
}

export interface InstalledSkillManifestEntry {
  skillId: string;
  slug: string;
  name: string;
  installationId: string;
  source: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  contentRefType: string;
  contentChecksum: string;
  systemTemplatePath: string | null;
  skillDerivedFromReleaseId: string | null;
  versionDerivedFromVersionId: string | null;
  installedAt: string;
}

/** Agent 安装清单读模型（W3）：每技能一行——已安装的固定版本 + 内容定位元数据。 */
export function getInstalledSkillManifest(scope: UserScope, agentId: string): InstalledSkillManifestEntry[] {
  assertScopeValid(scope);
  getAgent(scope, agentId);
  return (
    sqlite
      .prepare(
        `SELECT i.skill_id, s.slug, s.name, i.installation_id, i.source, i.release_id, i.release_version,
                i.version_id, v.content_ref_type, v.content_checksum, v.system_template_path,
                s.derived_from_release_id, v.derived_from_version_id, i.installed_at
         FROM agent_space_agent_skill_installations i
         JOIN agent_space_skills s ON s.skill_id = i.skill_id
         JOIN agent_space_skill_versions v ON v.version_id = i.version_id
         WHERE i.agent_id=? AND i.user_id=? AND i.project_id=? AND i.instance_id=? AND i.status='installed'`,
      )
      .all(agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{
        skill_id: string; slug: string; name: string; installation_id: string; source: "release" | "private";
        release_id: string | null; release_version: string | null; version_id: string; content_ref_type: string;
        content_checksum: string; system_template_path: string | null; derived_from_release_id: string | null;
        derived_from_version_id: string | null; installed_at: string;
      }>
  ).map((r) => ({
      skillId: r.skill_id,
      slug: r.slug,
      name: r.name,
      installationId: r.installation_id,
      source: r.source,
      releaseId: r.release_id,
      releaseVersion: r.release_version,
      versionId: r.version_id,
      contentRefType: r.content_ref_type,
      contentChecksum: r.content_checksum,
      systemTemplatePath: r.system_template_path,
      skillDerivedFromReleaseId: r.derived_from_release_id,
      versionDerivedFromVersionId: r.derived_from_version_id,
      installedAt: r.installed_at,
    }));
}

/**
 * 运行时固定版本解析（W3）：只认该 Agent 当前安装行钉住的版本——私有后续
 * 升级/发布变化不影响已安装 Agent；未安装/已移除/已 superseded 的技能一律
 * 拒绝；越权（跨 scope Agent）拒绝。返回固定版本元数据与校验后的字节。
 */
export async function resolveInstalledSkillContent(
  scope: UserScope,
  agentId: string,
  skillId: string,
): Promise<{ versionId: string; checksum: string; bytes: Buffer }> {
  assertScopeValid(scope);
  getAgent(scope, agentId);
  const installed = sqlite
    .prepare(
      `SELECT * FROM agent_space_agent_skill_installations
       WHERE agent_id=? AND skill_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='installed'`,
    )
    .get(agentId, skillId, scope.userId, scope.projectId, scope.instanceId) as InstallationRow | undefined;
  if (!installed) {
    throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${skillId} is not installed for agent ${agentId}`);
  }
  const version = getSkillVersionRow(installed.version_id);
  if (version.status === "draft") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "installed version must be formal; draft skills never resolve at runtime");
  }
  const bytes = await readSkillVersionContentBytes(version);
  return { versionId: version.version_id, checksum: version.content_checksum, bytes };
}

/** 方法绑定：pinned 必须指向已批准正式版本；current 跟随 methods.current_version_id。 */
export function bindMethod(input: {
  scope: UserScope;
  agentId: string;
  methodId: string;
  versionPolicy: "pinned" | "current";
  pinnedVersionId?: string;
  actor: string;
}): { bindingId: string } {
  assertScopeValid(input.scope);
  getAgent(input.scope, input.agentId);
  const method = sqlite
    .prepare("SELECT * FROM agent_space_methods WHERE method_id=?")
    .get(input.methodId) as { user_id: string; project_id: string; instance_id: string; current_version_id: string | null; kind?: string } | undefined;
  if (!method) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `method ${input.methodId}`);
  assertRowScope(method, input.scope);
  // 2026-10-08 两层裁决：主策略绑定只作用于 strategy；framework 整体常驻，
  // 不参与「设为主策略」。
  if (method.kind === "framework") {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `framework ${input.methodId} 不参与主策略绑定（投资框架整体常驻）`);
  }
  if (input.versionPolicy === "pinned") {
    if (!input.pinnedVersionId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "pinned policy requires pinnedVersionId");
    }
    resolveMethodVersion(input.scope, input.methodId, input.pinnedVersionId);
  }
  const now = nowIso();
  const bindingId = newId("mbind");
  // 2026-10-08 owner 裁决「我的策略」：策略可多份，但主策略唯一——agent 的
  // 方法绑定即主策略，绑定为换绑语义（同一 agent 只保留一条 active 绑定，
  // 旧主策略自动让位）。被任务固定引用的版本不受影响（任务走依赖路径）。
  const supersede = sqlite.transaction(() => {
    sqlite.prepare(
      `UPDATE agent_space_agent_method_bindings
       SET status='superseded', updated_at=?
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active' AND method_id != ?`,
    ).run(now, input.agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.methodId);
    sqlite
      .prepare(
        `INSERT INTO agent_space_agent_method_bindings (
           binding_id, agent_id, user_id, project_id, instance_id, method_id, version_policy, pinned_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(agent_id, method_id) DO UPDATE SET
           version_policy=excluded.version_policy, pinned_version_id=excluded.pinned_version_id,
           status='active', updated_at=excluded.updated_at`,
      )
      .run(bindingId, input.agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.methodId, input.versionPolicy, input.pinnedVersionId ?? null, now, now);
  });
  supersede();
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "agent.method.bound",
    objectType: "agent_space_agent_method_binding",
    objectId: bindingId,
    toStatus: "active",
    detail: { agentId: input.agentId, methodId: input.methodId, versionPolicy: input.versionPolicy, pinnedVersionId: input.pinnedVersionId ?? null, primaryOnly: true },
  });
  return { bindingId };
}

/** 资产授权：引用既有 user_assets；字节读取仍走 scoped user-assets 服务。 */
export function grantAsset(input: {
  scope: UserScope;
  agentId: string;
  assetId: string;
  grantedBy: string;
  expiresAt?: string;
  actor: string;
}): { grantId: string } {
  assertScopeValid(input.scope);
  getAgent(input.scope, input.agentId);
  const asset = sqlite
    .prepare("SELECT user_id, project_id, instance_id FROM user_assets WHERE asset_id=?")
    .get(input.assetId) as { user_id: string; project_id: string; instance_id: string } | undefined;
  if (!asset) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `user asset ${input.assetId}`);
  assertRowScope(asset, input.scope);
  const now = nowIso();
  const grantId = newId("agrant");
  sqlite
    .prepare(
      `INSERT INTO agent_space_agent_asset_grants (
         grant_id, agent_id, user_id, project_id, instance_id, asset_id, permission, granted_by, granted_at, expires_at, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'read', ?, ?, ?, 'active', ?)
       ON CONFLICT(agent_id, asset_id) DO UPDATE SET
         expires_at=excluded.expires_at, status='active', granted_by=excluded.granted_by, granted_at=excluded.granted_at`,
    )
    .run(grantId, input.agentId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
         input.assetId, input.grantedBy, now, input.expiresAt ?? null, now);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "agent.asset.granted",
    objectType: "agent_space_agent_asset_grant",
    objectId: grantId,
    toStatus: "active",
    detail: { agentId: input.agentId, assetId: input.assetId, expiresAt: input.expiresAt ?? null },
  });
  return { grantId };
}

export function listAssetGrants(scope: UserScope, agentId: string): Array<{ assetId: string; status: string; expiresAt: string | null }> {
  assertScopeValid(scope);
  getAgent(scope, agentId);
  return sqlite
    .prepare(
      `SELECT asset_id AS assetId, status, expires_at AS expiresAt FROM agent_space_agent_asset_grants
       WHERE agent_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='active'`,
    )
    .all(agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{ assetId: string; status: string; expiresAt: string | null }>;
}
