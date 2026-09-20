/**
 * Skill 域服务（W1/W3 底座；返工 R2/R3/R5）。
 *
 * 语义：系统/用户分域——系统域写操作必须持 owner 授权令牌，不能凭调用方
 * 自报 domain/actor；私有发布（visibility=private）只属主可装；shared 在
 * 授权模型定义前拒绝跨用户；内容引用（user_asset 版本或系统模板）在服务
 * 层验证存在性与 checksum。全部写入与审计同事务。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertDomainRowShape,
  assertOnlyFields,
  assertRowScope,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  requireOwnerAuthorization,
  verifyAuthorization,
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
  /** domain=system 时必填（owner 授权令牌）。 */
  ownerToken?: string;
  actor: string;
}

export interface AddSkillVersionInput {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  contentRef: SkillContentRef;
  origin: "private_edit" | "system_seed" | "release_import";
  ownerToken?: string;
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

type ReleaseRow = {
  release_id: string;
  skill_id: string;
  domain: AgentSpaceScopeDomain;
  user_id: string | null;
  project_id: string | null;
  instance_id: string | null;
  release_version: string;
  version_id: string;
  content_ref_type: string;
  content_checksum: string;
  visibility: ReleaseVisibility;
  status: "published" | "retired";
  published_by: string | null;
  published_at: string;
  created_at: string;
};

const CONTENT_REF_FIELDS = ["contentRefType", "assetId", "assetVersionId", "systemTemplatePath", "contentChecksum"] as const;

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

export function getReleaseRow(releaseId: string): ReleaseRow {
  const row = sqlite.prepare("SELECT * FROM agent_space_skill_releases WHERE release_id=?").get(releaseId) as ReleaseRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill release ${releaseId}`);
  return row;
}

/** 系统域写操作授权：owner 令牌必须匹配服务侧配置。 */
function requireSystemWriteAuthorization(domain: AgentSpaceScopeDomain, ownerToken: string | undefined, what: string): void {
  if (domain === "system") requireOwnerAuthorization(ownerToken, what);
}

/** 内容引用真实性校验（验收 R3）。 */
async function verifySkillContentRef(
  domain: AgentSpaceScopeDomain,
  scope: UserScope | null,
  ref: SkillContentRef,
): Promise<SkillContentRef> {
  assertOnlyFields(ref as unknown as Record<string, unknown>, CONTENT_REF_FIELDS, "skill contentRef");
  if (ref.contentRefType === "user_asset_version") {
    if (domain !== "user" || !scope) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user_asset_version refs require user domain");
    }
    if (!ref.assetId || !ref.assetVersionId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user_asset_version ref requires assetId and assetVersionId");
    }
    const row = sqlite
      .prepare("SELECT asset_id, checksum, user_id, project_id, instance_id FROM user_asset_versions WHERE version_id=?")
      .get(ref.assetVersionId) as
      | { asset_id: string; checksum: string; user_id: string; project_id: string; instance_id: string }
      | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `user asset version ${ref.assetVersionId} not found`);
    assertRowScope(row, scope);
    if (row.asset_id !== ref.assetId) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "assetVersionId does not belong to assetId");
    }
    if (row.checksum !== ref.contentChecksum) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `content checksum mismatch (actual ${row.checksum})`);
    }
    return ref;
  }
  if (ref.contentRefType === "system_template") {
    if (domain !== "system") {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "system_template refs require system domain");
    }
    if (!ref.systemTemplatePath || path.isAbsolute(ref.systemTemplatePath) || ref.systemTemplatePath.includes("..")) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "systemTemplatePath must be a relative path inside the template root");
    }
    const root = path.resolve(process.env.SYSTEM_SKILLS_TEMPLATE_ROOT || path.join(process.cwd(), "templates", "skills"));
    const absolute = path.join(root, ref.systemTemplatePath);
    if (!absolute.startsWith(root + path.sep)) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "systemTemplatePath escapes template root");
    }
    if (!existsSync(absolute)) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `system template ${ref.systemTemplatePath} not found`);
    }
    const bytes = await readFile(absolute);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== ref.contentChecksum) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `system template checksum mismatch (actual ${actual})`);
    }
    return ref;
  }
  throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `unknown contentRefType ${ref.contentRefType}`);
}

export function upsertSkill(input: UpsertSkillInput): SkillRow {
  assertDomainRowShape(input.domain, input.scope);
  if (input.domain === "user") assertScopeValid(input.scope as UserScope);
  requireSystemWriteAuthorization(input.domain, input.ownerToken, "system skill upsert");
  const existing = sqlite
    .prepare(
      `SELECT * FROM agent_space_skills WHERE domain=? AND COALESCE(user_id,'')=? AND COALESCE(project_id,'')=? AND COALESCE(instance_id,'')=? AND slug=?`,
    )
    .get(input.domain, input.scope?.userId ?? "", input.scope?.projectId ?? "", input.scope?.instanceId ?? "", input.slug) as SkillRow | undefined;
  if (existing) return existing;
  const now = nowIso();
  const tx = sqlite.transaction(() => {
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
    return skillId;
  });
  return getSkillRow(tx());
}

export async function addSkillVersion(input: AddSkillVersionInput): Promise<SkillVersionRow> {
  assertDomainRowShape(input.domain, input.scope);
  requireSystemWriteAuthorization(input.domain, input.ownerToken, "system skill version write");
  const skill = getSkillRow(input.skillId);
  assertSkillScope(skill, input.domain, input.scope);
  const verified = await verifySkillContentRef(input.domain, input.scope, input.contentRef);
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
           input.scope?.instanceId ?? null, nextNumber, verified.contentRefType, verified.assetId ?? null,
           verified.assetVersionId ?? null, verified.systemTemplatePath ?? null,
           verified.contentChecksum, input.origin, skill.current_private_version_id, nowIso());
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
    return versionId;
  });
  return getVersionRow(tx());
}

export function approveSkillVersion(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  versionId: string;
  approvedBy: string;
  approvalRef: string;
  ownerToken?: string;
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
  // 系统域批准必须走 owner 决策；用户域接受同 scope 会话消息或 owner 决策。
  if (input.domain === "system") {
    requireOwnerAuthorization(input.ownerToken, "system skill approval");
  } else {
    verifyAuthorization(
      input.scope as UserScope,
      { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: input.versionId, versionId: input.versionId, extraBinding: { skillId: input.skillId } },
      input.approvalRef,
      input.ownerToken,
    );
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
    return input.versionId;
  });
  return getVersionRow(tx());
}

export function publishSkillRelease(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  versionId: string;
  releaseVersion: string;
  visibility: ReleaseVisibility;
  publishedBy: string;
  ownerToken?: string;
  actor: string;
}): { releaseId: string; versionId: string; contentChecksum: string; visibility: ReleaseVisibility } {
  assertDomainRowShape(input.domain, input.scope);
  requireSystemWriteAuthorization(input.domain, input.ownerToken, "system skill publish");
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
  const tx = sqlite.transaction(() => {
    const releaseId = newId("srel");
    const now = nowIso();
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
           version.content_checksum, input.visibility, input.publishedBy, now, now);
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
    return releaseId;
  });
  const release = getReleaseRow(tx());
  return { releaseId: release.release_id, versionId: input.versionId, contentChecksum: release.content_checksum, visibility: release.visibility };
}

/** 撤回发布（发布者 scope 或 owner）：撤回后不可安装，历史审计保留。 */
export function retireSkillRelease(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  releaseId: string;
  ownerToken?: string;
  actor: string;
}): void {
  assertDomainRowShape(input.domain, input.scope);
  const release = getReleaseRow(input.releaseId);
  if (release.domain !== input.domain) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "release belongs to another domain");
  }
  if (input.domain === "user") {
    assertRowScope(release, input.scope as UserScope);
  }
  if (release.status === "retired") return;
  const tx = sqlite.transaction(() => {
    sqlite.prepare("UPDATE agent_space_skill_releases SET status='retired' WHERE release_id=?").run(input.releaseId);
    recordAgentSpaceAudit({
      domain: input.domain,
      scope: input.scope,
      actor: input.actor,
      action: "skill.release.retired",
      objectType: "agent_space_skill_release",
      objectId: input.releaseId,
      fromStatus: "published",
      toStatus: "retired",
    });
  });
  tx();
}

/**
 * 安装方视角的 release 可用性判定（验收 R2）：
 * - public：published 状态即可安装（跨用户允许）；
 * - private：仅属主 scope；
 * - shared：授权模型未定义，跨用户一律拒绝（fail-closed）。
 */
export function assertReleaseInstallableBy(release: ReleaseRow, installerScope: UserScope): void {
  if (release.status !== "published") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `release is ${release.status}`);
  }
  if (release.domain === "user" && release.user_id !== null) {
    const isOwner = release.user_id === installerScope.userId
      && release.project_id === installerScope.projectId
      && release.instance_id === installerScope.instanceId;
    if (release.visibility === "private" && !isOwner) {
      throw new AgentSpaceError("AGENT_SPACE_VISIBILITY_INVALID", "private release is installable by its owner only");
    }
    if (release.visibility === "shared" && !isOwner) {
      throw new AgentSpaceError("AGENT_SPACE_VISIBILITY_INVALID", "shared release cross-user install is not supported until an authorization model is defined");
    }
  }
}

export function getSkillReleaseForInstaller(installerScope: UserScope, releaseId: string): ReleaseRow {
  const release = getReleaseRow(releaseId);
  assertReleaseInstallableBy(release, installerScope);
  return release;
}

/** 市场查询：只返回 public + published；私有内容不进任何市场面。 */
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

export type { SkillRow, SkillVersionRow, ReleaseRow };
