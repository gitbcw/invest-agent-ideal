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
  status: "installed" | "superseded" | "removed";
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
  const tx = sqlite.transaction(() => {
    // R9：核验+消耗与安装写入、审计同事务。
    const approval = verifyAuthorization(
      input.scope,
      { operation: "skill.install", objectType: "agent_space_agent_skill_installation", objectId: input.agentId, versionId: input.versionId, extraBinding: { skillId: input.skillId, source: input.source } },
      input.approvalRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回首次安装行本身（可能已被后续升级
    // superseded），不把当前安装降回旧版本、不新增安装/审计。
    if (approval.replayed) {
      return getInstallationRow(input.scope, (approval.replayResult as { installationId: string }).installationId);
    }
    // owner-decision 等无凭证行路径的业务回放：同一依据已为该 agent+skill
    // 产生过安装 → 返回既有行，不重复 supersede/插入/审计。
    const sameRef = sqlite
      .prepare(
        `SELECT * FROM agent_space_agent_skill_installations
         WHERE agent_id=? AND skill_id=? AND approval_ref=?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.agentId, input.skillId, input.approvalRef) as InstallationRow | undefined;
    if (sameRef) {
      if (sameRef.version_id !== input.versionId || sameRef.source !== input.source) {
        throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "approval ref is already bound to a different install target");
      }
      return sameRef;
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
         WHERE agent_id=? AND skill_id=? AND status='installed'`,
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
    .get(input.methodId) as { user_id: string; project_id: string; instance_id: string; current_version_id: string | null } | undefined;
  if (!method) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `method ${input.methodId}`);
  assertRowScope(method, input.scope);
  if (input.versionPolicy === "pinned") {
    if (!input.pinnedVersionId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "pinned policy requires pinnedVersionId");
    }
    resolveMethodVersion(input.scope, input.methodId, input.pinnedVersionId);
  }
  const now = nowIso();
  const bindingId = newId("mbind");
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
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "agent.method.bound",
    objectType: "agent_space_agent_method_binding",
    objectId: bindingId,
    toStatus: "active",
    detail: { agentId: input.agentId, methodId: input.methodId, versionPolicy: input.versionPolicy, pinnedVersionId: input.pinnedVersionId ?? null },
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
