/**
 * Skill 域服务（W1/W3 底座）：系统/用户分域、私有版本、发布版本与安装。
 *
 * 语义（v3 §2）：技能有系统默认、市场发布、用户私有三种来源，默认私有，
 * 发布是显式动作；市场发布与私有后续修改各自形成版本，不自动联动；Agent
 * 持有安装清单，安装固定版本，升级需用户批准；私有内容不能被市场查询。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertDomainRowShape,
  assertRowScope,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  type AgentSpaceScopeDomain,
  type UserScope,
} from "./core.js";

export type SkillVersionStatus = "draft" | "approved" | "superseded";
export type ReleaseVisibility = "public" | "shared" | "private";

export interface SkillContentRef {
  contentRefType: "user_asset_version" | "system_template";
  assetId?: string;
  assetVersionId?: string;
  systemTemplatePath?: string;
  contentChecksum: string;
}

export interface UpsertSkillInput {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  slug: string;
  name: string;
  description?: string;
  actor: string;
}

export interface AddSkillVersionInput {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  contentRef: SkillContentRef;
  origin: "private_edit" | "system_seed" | "release_import";
  actor: string;
}

type SkillRow = {
  skill_id: string;
  domain: AgentSpaceScopeDomain;
  user_id: string | null;
  project_id: string | null;
  instance_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  current_private_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type SkillVersionRow = {
  version_id: string;
  skill_id: string;
  domain: AgentSpaceScopeDomain;
  user_id: string | null;
  project_id: string | null;
  instance_id: string | null;
  version_number: number;
  content_ref_type: string;
  asset_id: string | null;
  asset_version_id: string | null;
  system_template_path: string | null;
  content_checksum: string;
  origin: string;
  status: SkillVersionStatus;
  supersedes_version_id: string | null;
  created_at: string;
};

function getSkillRow(skillId: string): SkillRow {
  const row = sqlite.prepare("SELECT * FROM agent_space_skills WHERE skill_id=?").get(skillId) as SkillRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${skillId}`);
  return row;
}

function assertSkillScope(row: SkillRow, domain: AgentSpaceScopeDomain, scope: UserScope | null): void {
  if (row.domain !== domain) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", `skill belongs to ${row.domain} domain`);
  }
  if (domain === "user") {
    if (!scope) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user-domain access requires scope");
    assertRowScope(row, scope);
  }
}

export function getVersionRow(versionId: string): SkillVersionRow {
  const row = sqlite.prepare("SELECT * FROM agent_space_skill_versions WHERE version_id=?").get(versionId) as SkillVersionRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill version ${versionId}`);
  return row;
}

export function upsertSkill(input: UpsertSkillInput): SkillRow {
  assertDomainRowShape(input.domain, input.scope);
  if (input.domain === "user") assertScopeValid(input.scope as UserScope);
  const now = nowIso();
  const existing = sqlite
    .prepare(
      `SELECT * FROM agent_space_skills WHERE domain=? AND COALESCE(user_id,'')=? AND COALESCE(project_id,'')=? AND COALESCE(instance_id,'')=? AND slug=?`,
    )
    .get(input.domain, input.scope?.userId ?? "", input.scope?.projectId ?? "", input.scope?.instanceId ?? "", input.slug) as SkillRow | undefined;
  if (existing) return existing;
  const skillId = newId("skill");
  sqlite
    .prepare(
      `INSERT INTO agent_space_skills (
         skill_id, domain, user_id, project_id, instance_id, slug, name, description, status, current_private_version_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`,
    )
    .run(skillId, input.domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
         input.slug, input.name, input.description ?? null, now, now);
  recordAgentSpaceAudit({
    domain: input.domain,
    scope: input.scope,
    actor: input.actor,
    action: "skill.created",
    objectType: "agent_space_skill",
    objectId: skillId,
    toStatus: "draft",
  });
  return getSkillRow(skillId);
}

export function addSkillVersion(input: AddSkillVersionInput): SkillVersionRow {
  assertDomainRowShape(input.domain, input.scope);
  const skill = getSkillRow(input.skillId);
  assertSkillScope(skill, input.domain, input.scope);
  const tx = sqlite.transaction(() => {
    const maxRow = sqlite
      .prepare("SELECT MAX(version_number) AS n FROM agent_space_skill_versions WHERE skill_id=?")
      .get(input.skillId) as { n: number | null };
    const nextNumber = (maxRow.n ?? 0) + 1;
    const versionId = newId("sver");
    sqlite
      .prepare(
        `INSERT INTO agent_space_skill_versions (
           version_id, skill_id, domain, user_id, project_id, instance_id, version_number,
           content_ref_type, asset_id, asset_version_id, system_template_path, content_checksum,
           origin, status, supersedes_version_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(versionId, input.skillId, input.domain, input.scope?.userId ?? null, input.scope?.projectId ?? null,
           input.scope?.instanceId ?? null, nextNumber, input.contentRef.contentRefType, input.contentRef.assetId ?? null,
           input.contentRef.assetVersionId ?? null, input.contentRef.systemTemplatePath ?? null,
           input.contentRef.contentChecksum, input.origin, skill.current_private_version_id, nowIso());
    sqlite.prepare("UPDATE agent_space_skills SET updated_at=? WHERE skill_id=?").run(nowIso(), input.skillId);
    recordAgentSpaceAudit({
      domain: input.domain,
      scope: input.scope,
      actor: input.actor,
      action: "skill.version.drafted",
      objectType: "agent_space_skill_version",
      objectId: versionId,
      toStatus: "draft",
      detail: { skillId: input.skillId, versionNumber: nextNumber, origin: input.origin },
    });
    return getVersionRow(versionId);
  });
  return tx();
}

/** 私有版本批准（或系统种子版本批准为当前私有版本）。 */
export function approveSkillVersion(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  versionId: string;
  approvedBy: string;
  approvalRef: string;
  actor: string;
}): SkillVersionRow {
  assertDomainRowShape(input.domain, input.scope);
  const skill = getSkillRow(input.skillId);
  assertSkillScope(skill, input.domain, input.scope);
  const version = getVersionRow(input.versionId);
  if (version.skill_id !== input.skillId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to skill");
  }
  if (version.status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_IMMUTABLE", `version already ${version.status}`);
  }
  if (!input.approvalRef?.trim()) {
    throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "approvalRef is required");
  }
  const tx = sqlite.transaction(() => {
    const now = nowIso();
    sqlite
      .prepare("UPDATE agent_space_skill_versions SET status='approved', approved_by=?, approved_at=?, approval_ref=? WHERE version_id=? AND status='draft'")
      .run(input.approvedBy, now, input.approvalRef, input.versionId);
    if (skill.current_private_version_id && skill.current_private_version_id !== input.versionId) {
      sqlite
        .prepare("UPDATE agent_space_skill_versions SET status='superseded' WHERE version_id=? AND status='approved'")
        .run(skill.current_private_version_id);
    }
    sqlite
      .prepare("UPDATE agent_space_skills SET status='active', current_private_version_id=?, updated_at=? WHERE skill_id=?")
      .run(input.versionId, now, input.skillId);
    recordAgentSpaceAudit({
      domain: input.domain,
      scope: input.scope,
      actor: input.actor,
      action: "skill.version.approved",
      objectType: "agent_space_skill_version",
      objectId: input.versionId,
      fromStatus: "draft",
      toStatus: "approved",
      detail: { skillId: input.skillId, approvalRef: input.approvalRef },
    });
    return getVersionRow(input.versionId);
  });
  return tx();
}

/**
 * 发布：以冻结的（version_id, checksum）创建 release。发布后私有继续修改
 * 只会产生新的私有 draft 版本，release 永不联动。
 */
export function publishSkillRelease(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  versionId: string;
  releaseVersion: string;
  visibility: ReleaseVisibility;
  publishedBy: string;
  actor: string;
}): { releaseId: string; versionId: string; contentChecksum: string; visibility: ReleaseVisibility } {
  assertDomainRowShape(input.domain, input.scope);
  const skill = getSkillRow(input.skillId);
  assertSkillScope(skill, input.domain, input.scope);
  const version = getVersionRow(input.versionId);
  if (version.skill_id !== input.skillId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to skill");
  }
  if (version.status !== "approved") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "only approved versions can be published");
  }
  if (!["public", "shared", "private"].includes(input.visibility)) {
    throw new AgentSpaceError("AGENT_SPACE_VISIBILITY_INVALID", input.visibility);
  }
  const releaseId = newId("srel");
  sqlite
    .prepare(
      `INSERT INTO agent_space_skill_releases (
         release_id, skill_id, domain, user_id, project_id, instance_id,
         release_version, version_id, content_ref_type, content_checksum,
         visibility, status, published_by, published_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)`,
    )
    .run(releaseId, input.skillId, input.domain, input.scope?.userId ?? null, input.scope?.projectId ?? null,
         input.scope?.instanceId ?? null, input.releaseVersion, input.versionId, version.content_ref_type,
         version.content_checksum, input.visibility, input.publishedBy, nowIso(), nowIso());
  recordAgentSpaceAudit({
    domain: input.domain,
    scope: input.scope,
    actor: input.actor,
    action: "skill.release.published",
    objectType: "agent_space_skill_release",
    objectId: releaseId,
    toStatus: "published",
    detail: { skillId: input.skillId, versionId: input.versionId, releaseVersion: input.releaseVersion, visibility: input.visibility },
  });
  return { releaseId, versionId: input.versionId, contentChecksum: version.content_checksum, visibility: input.visibility };
}

/**
 * 市场查询：只返回 visibility='public' 且 status='published' 的 release。
 * 私有技能行、私有版本、shared 草稿都不会出现在市场结果里。
 */
export function listPublicSkillReleases(): Array<{
  releaseId: string;
  skillId: string;
  releaseVersion: string;
  versionId: string;
  contentChecksum: string;
  publishedAt: string;
}> {
  return sqlite
    .prepare(
      `SELECT release_id, skill_id, release_version, version_id, content_checksum, published_at
       FROM agent_space_skill_releases WHERE visibility='public' AND status='published' ORDER BY created_at DESC`,
    )
    .all()
    .map((r: { release_id: string; skill_id: string; release_version: string; version_id: string; content_checksum: string; published_at: string }) => ({
      releaseId: r.release_id,
      skillId: r.skill_id,
      releaseVersion: r.release_version,
      versionId: r.version_id,
      contentChecksum: r.content_checksum,
      publishedAt: r.published_at,
    }));
}

export function getSkill(domain: AgentSpaceScopeDomain, scope: UserScope | null, skillId: string): SkillRow {
  assertDomainRowShape(domain, scope);
  const row = getSkillRow(skillId);
  assertSkillScope(row, domain, scope);
  return row;
}

export function getSkillVersion(domain: AgentSpaceScopeDomain, scope: UserScope | null, versionId: string): SkillVersionRow {
  assertDomainRowShape(domain, scope);
  const row = getVersionRow(versionId);
  const skill = getSkillRow(row.skill_id);
  assertSkillScope(skill, domain, scope);
  return row;
}
