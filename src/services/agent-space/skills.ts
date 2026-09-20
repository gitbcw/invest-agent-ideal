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
import { readUserAssetVersion } from "../user-assets.js";
import {
  AgentSpaceError,
  assertDomainRowShape,
  assertOnlyFields,
  assertRowScope,
  assertScopeValid,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  recordAuthorizationOutcome,
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
  /** 派生血缘：本版本派生自某个发布版本的 versionId（W3 派生可追溯）。 */
  derivedFromVersionId?: string;
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
  derived_from_release_id: string | null;
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
  approved_by: string | null;
  approved_at: string | null;
  approval_ref: string | null;
  supersedes_version_id: string | null;
  derived_from_version_id: string | null;
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
  is_default: number;
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
           origin, status, supersedes_version_id, derived_from_version_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      )
      .run(versionId, input.skillId, input.domain, input.scope?.userId ?? null, input.scope?.projectId ?? null,
           input.scope?.instanceId ?? null, nextNumber, verified.contentRefType, verified.assetId ?? null,
           verified.assetVersionId ?? null, verified.systemTemplatePath ?? null,
           verified.contentChecksum, input.origin, skill.current_private_version_id,
           input.derivedFromVersionId ?? null, nowIso());
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
  // 系统域批准必须走 owner 决策；用户域须绑定式授权（核验在事务内执行）。
  if (input.domain === "system") {
    requireOwnerAuthorization(input.ownerToken, "system skill approval");
  }
  const tx = sqlite.transaction(() => {
    // R9：核验+消耗与业务变更、审计同事务。
    const approval = verifyAuthorization(
      input.scope,
      { operation: "skill.version.approve", objectType: "agent_space_skill_version", objectId: input.versionId, versionId: input.versionId, extraBinding: { skillId: input.skillId } },
      input.approvalRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回既有版本行，不重复转换/审计。
    if (approval.replayed) {
      return getVersionRow((approval.replayResult as { versionId: string }).versionId);
    }
    const current = getVersionRow(input.versionId);
    if (current.status !== "draft") {
      throw new AgentSpaceError("AGENT_SPACE_IMMUTABLE", `version already ${current.status}`);
    }
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
    recordAuthorizationOutcome(approval.authorizationId, { skillId: input.skillId, versionId: input.versionId });
    return getVersionRow(input.versionId);
  });
  return tx();
}

export function publishSkillRelease(input: {
  domain: AgentSpaceScopeDomain;
  scope: UserScope | null;
  skillId: string;
  versionId: string;
  releaseVersion: string;
  visibility: ReleaseVisibility;
  publishedBy: string;
  /** 默认清单标记：仅系统域发布可携带（owner 令牌治理的目录策略）。 */
  isDefault?: boolean;
  ownerToken?: string;
  actor: string;
}): { releaseId: string; versionId: string; contentChecksum: string; visibility: ReleaseVisibility } {
  assertDomainRowShape(input.domain, input.scope);
  requireSystemWriteAuthorization(input.domain, input.ownerToken, "system skill publish");
  if (input.isDefault && input.domain !== "system") {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "default-manifest releases can only be published in the system domain");
  }
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
  // 发布不可变：同一 skill 的 release_version 唯一，重复发布明确冲突。
  const duplicate = sqlite
    .prepare("SELECT release_id FROM agent_space_skill_releases WHERE skill_id=? AND release_version=?")
    .get(input.skillId, input.releaseVersion) as { release_id: string } | undefined;
  if (duplicate) {
    throw new AgentSpaceError(
      "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
      `release version ${input.releaseVersion} already exists for this skill (${duplicate.release_id}); published releases are immutable`,
    );
  }
  const tx = sqlite.transaction(() => {
    const releaseId = newId("srel");
    const now = nowIso();
    sqlite
      .prepare(
        `INSERT INTO agent_space_skill_releases (
           release_id, skill_id, domain, user_id, project_id, instance_id,
           release_version, version_id, content_ref_type, content_checksum,
           visibility, status, is_default, published_by, published_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
      )
      .run(releaseId, input.skillId, input.domain, input.scope?.userId ?? null, input.scope?.projectId ?? null,
           input.scope?.instanceId ?? null, input.releaseVersion, input.versionId, version.content_ref_type,
           version.content_checksum, input.visibility, input.isDefault ? 1 : 0, input.publishedBy, now, now);
    recordAgentSpaceAudit({
      domain: input.domain,
      scope: input.scope,
      actor: input.actor,
      action: "skill.release.published",
      objectType: "agent_space_skill_release",
      objectId: releaseId,
      toStatus: "published",
      detail: { skillId: input.skillId, versionId: input.versionId, releaseVersion: input.releaseVersion, visibility: input.visibility, isDefault: input.isDefault === true },
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

// ---------- W3：目录、派生与内容读取 ----------

export interface SkillCatalogEntry {
  releaseId: string;
  skillId: string;
  slug: string;
  name: string;
  domain: AgentSpaceScopeDomain;
  releaseVersion: string;
  versionId: string;
  contentRefType: string;
  contentChecksum: string;
  isDefault: boolean;
  publishedAt: string;
}

/**
 * 市场目录（W3）：只呈现 public + published 的发布（含系统默认标记）；
 * private/shared 不进任何目录枚举面。目录只暴露元数据与 checksum，不吐正文。
 */
export function listSkillCatalog(): SkillCatalogEntry[] {
  return (
    sqlite
      .prepare(
        `SELECT r.release_id, r.skill_id, s.slug, s.name, r.domain, r.release_version, r.version_id,
                r.content_ref_type, r.content_checksum, r.is_default, r.published_at
         FROM agent_space_skill_releases r JOIN agent_space_skills s ON s.skill_id = r.skill_id
         WHERE r.visibility='public' AND r.status='published'
         ORDER BY r.published_at DESC`,
      )
      .all() as Array<{
        release_id: string; skill_id: string; slug: string; name: string; domain: AgentSpaceScopeDomain;
        release_version: string; version_id: string; content_ref_type: string; content_checksum: string;
        is_default: number; published_at: string;
      }>
  ).map((r) => ({
      releaseId: r.release_id,
      skillId: r.skill_id,
      slug: r.slug,
      name: r.name,
      domain: r.domain,
      releaseVersion: r.release_version,
      versionId: r.version_id,
      contentRefType: r.content_ref_type,
      contentChecksum: r.content_checksum,
      isDefault: r.is_default === 1,
      publishedAt: r.published_at,
    }));
}

/**
 * 安装方视角的发布详情（W3）：可见性规则与安装一致——private 仅属主、
 * shared 跨用户 fail-closed、public+published 开放；retired 拒绝。
 */
export function getReleaseDetailForInstaller(
  installerScope: UserScope,
  releaseId: string,
): SkillCatalogEntry & { visibility: ReleaseVisibility; status: string } {
  const release = getReleaseRow(releaseId);
  assertReleaseInstallableBy(release, installerScope);
  const skill = getSkillRow(release.skill_id);
  return {
    releaseId: release.release_id,
    skillId: release.skill_id,
    slug: skill.slug,
    name: skill.name,
    domain: release.domain,
    releaseVersion: release.release_version,
    versionId: release.version_id,
    contentRefType: release.content_ref_type,
    contentChecksum: release.content_checksum,
    isDefault: release.is_default === 1,
    publishedAt: release.published_at,
    visibility: release.visibility,
    status: release.status,
  };
}

/**
 * 市场安装后的定制 = 私有派生（W3）：以发布为血缘起点创建用户私有技能，
 * 首版内容必须是派生者自己 scope 内的真实资产版本（正文归派生者所有，
 * 不跨 scope 复制字节）；血缘列记录来源 release/version，可追溯、可审计。
 * 来源发布的可见性规则与安装一致。
 */
export async function derivePrivateSkillFromRelease(input: {
  scope: UserScope;
  releaseId: string;
  slug: string;
  name: string;
  description?: string;
  /** 派生者自己 scope 内的内容引用（定制后的正文）。 */
  contentRef: SkillContentRef;
  actor: string;
}): Promise<{ skill: SkillRow; version: SkillVersionRow }> {
  assertScopeValid(input.scope);
  const release = getReleaseRow(input.releaseId);
  assertReleaseInstallableBy(release, input.scope);
  const existing = sqlite
    .prepare(
      `SELECT skill_id FROM agent_space_skills
       WHERE domain='user' AND COALESCE(user_id,'')=? AND COALESCE(project_id,'')=? AND COALESCE(instance_id,'')=? AND slug=?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.slug) as { skill_id: string } | undefined;
  if (existing) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `slug ${input.slug} already exists in this scope`);
  }
  const verified = await verifySkillContentRef("user", input.scope, input.contentRef);
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    const skillId = newId("skill");
    sqlite
      .prepare(
        `INSERT INTO agent_space_skills (
           skill_id, domain, user_id, project_id, instance_id, slug, name, description,
           status, current_private_version_id, derived_from_release_id, created_at, updated_at
         ) VALUES (?, 'user', ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?)`,
      )
      .run(skillId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.slug, input.name,
           input.description ?? null, input.releaseId, now, now);
    const versionId = newId("sver");
    sqlite
      .prepare(
        `INSERT INTO agent_space_skill_versions (
           version_id, skill_id, domain, user_id, project_id, instance_id, version_number,
           content_ref_type, asset_id, asset_version_id, system_template_path, content_checksum,
           origin, status, supersedes_version_id, derived_from_version_id, created_at
         ) VALUES (?, ?, 'user', ?, ?, ?, 1, ?, ?, ?, ?, ?, 'release_import', 'draft', NULL, ?, ?)`,
      )
      .run(versionId, skillId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           verified.contentRefType, verified.assetId ?? null, verified.assetVersionId ?? null,
           verified.systemTemplatePath ?? null, verified.contentChecksum, release.version_id, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "skill.derived_from_release",
      objectType: "agent_space_skill",
      objectId: skillId,
      toStatus: "draft",
      detail: { releaseId: input.releaseId, derivedFromVersionId: release.version_id, slug: input.slug, versionId },
    });
    return { skillId, versionId };
  });
  const { skillId, versionId } = tx();
  return { skill: getSkillRow(skillId), version: getVersionRow(versionId) };
}

/**
 * 技能版本字节读取（W3）：user_asset_version 走 scoped 校验读取；
 * system_template 在模板根内做包含校验 + 字节 checksum 校验。
 * 供运行时固定版本解析使用（agents.ts resolveInstalledSkillContent）。
 */
export async function readSkillVersionContentBytes(version: SkillVersionRow): Promise<Buffer> {
  if (version.content_ref_type === "user_asset_version") {
    if (!version.user_id || !version.asset_id || !version.asset_version_id) {
      throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "skill version has an incomplete user-asset content ref");
    }
    const read = await readUserAssetVersion({
      userId: version.user_id, projectId: version.project_id ?? "", instanceId: version.instance_id ?? "",
      assetId: version.asset_id, versionId: version.asset_version_id,
    });
    return read.bytes;
  }
  if (version.content_ref_type === "system_template") {
    if (!version.system_template_path || path.isAbsolute(version.system_template_path) || version.system_template_path.includes("..")) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "systemTemplatePath must be a relative path inside the template root");
    }
    const root = path.resolve(process.env.SYSTEM_SKILLS_TEMPLATE_ROOT || path.join(process.cwd(), "templates", "skills"));
    const absolute = path.join(root, version.system_template_path);
    if (!absolute.startsWith(root + path.sep)) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "systemTemplatePath escapes template root");
    }
    const bytes = await readFile(absolute);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== version.content_checksum) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `system template checksum mismatch for ${version.system_template_path}`);
    }
    return bytes;
  }
  throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", `unknown contentRefType ${version.content_ref_type}`);
}

/** 默认清单候选（W3）：is_default + published + public 的系统发布，按技能取最新。 */
export function listDefaultReleases(): ReleaseRow[] {
  const rows = sqlite
    .prepare(
      `SELECT * FROM agent_space_skill_releases
       WHERE is_default=1 AND status='published' AND visibility='public'
       ORDER BY published_at DESC, rowid DESC`,
    )
    .all() as ReleaseRow[];
  const bySkill = new Map<string, ReleaseRow>();
  for (const row of rows) if (!bySkill.has(row.skill_id)) bySkill.set(row.skill_id, row);
  return [...bySkill.values()];
}

export type { SkillRow, SkillVersionRow, ReleaseRow };
