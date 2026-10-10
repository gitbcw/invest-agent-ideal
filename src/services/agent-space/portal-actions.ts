/**
 * T-538 Portal GUI 动作与读模型入口（方法/Skill 域）。
 *
 * 职责边界：
 * - 读模型：给「工作空间」页面聚合卡片/详情所需的跨表视图（方法-任务绑定
 *   计数、待确认版本、安装态、可用升级）。只读，不改表结构。
 * - 显式动作：GUI 的采用/恢复/启用/安装/卸载走本模块的受信入口——先登记
 *   `portal` 来源的授权凭证（source_kind='portal'，source_ref 绑定调用方
 *   幂等键），再在**同一事务**内调用既有状态机（approve/readopt/install/
 *   remove）。凭证的绑定必须与状态机核验时声明的 binding 完全一致，因此
 *   每个动作的 extraBinding 在这里与状态机逐字段对齐；改状态机绑定时必须
 *   同步改这里。
 * - 内容上传：方法/Skill 编辑正文先落到 user_assets 版本链（source=upload），
 *   再以 {assetId, assetVersionId, contentChecksum} 引用进 agent_space——
 *   服务层校验 checksum，不信任自报。
 *
 * 输出契约：所有返回给 connector 的 DTO **不携带** scope 三元组、checksum、
 * idempotencyKey、storagePath、approvalRef 等内部字段（redact 由构造保证，
 * connector 不做二次清洗也不泄露）。
 */
import { sqlite } from "../../db/index.js";
import { createUserAsset, uploadUserAssetVersion } from "../user-assets.js";
import {
  AgentSpaceError,
  assertRowScope,
  assertScopeValid,
  canonicalExtraBindingJson,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  type UserScope,
} from "./core.js";
import type { AdoptionConstraint } from "./methods.js";
import {
  addMethodVersion,
  approveMethodVersion,
  createMethod,
  diffMethodVersions,
  getMethod,
  getMethodVersion,
  readMethodVersionContent,
  readoptMethodVersion,
  retireMethod,
} from "./methods.js";
import {
  addSkillVersion,
  approveSkillVersion,
  getSkillReleaseForInstaller,
  getSkillVersion,
  readSkillVersionContentBytes,
  upsertSkill,
  getVersionRow as getSkillVersionRow,
} from "./skills.js";
import { getAgent, installSkill, removeInstalledSkill, setInstalledSkillEnabled } from "./agents.js";

// ---------------------------------------------------------------------------
// Portal 授权可信入口
// ---------------------------------------------------------------------------

export interface PortalAuthorizationInput {
  scope: UserScope;
  operation: string;
  objectType: string;
  objectId: string;
  versionId?: string | null;
  extraBinding?: Record<string, string>;
  /** 稳定来源引用（如 `portal:111:<idempotencyKey>`）；同 ref 只命名一个操作。 */
  sourceRef: string;
  actor: string;
}

/**
 * 登记 portal 显式动作授权（R6 同构：消息存在 ≠ 用户批准——这里的“批准”是
 * 已认证 Portal 会话里的显式确认动作，由受信 connector 调用）。
 *
 * 幂等语义与 owner-decision 一致：同 sourceRef + 同绑定的重复登记返回同一
 * 凭证（消耗后由状态机走 R9② 回放）；同 ref 换绑定拒绝。
 * 必须在调用方业务事务内使用，与状态机核验/消耗原子提交。
 */
export function registerPortalActionAuthorization(input: PortalAuthorizationInput): string {
  assertScopeValid(input.scope);
  const sourceRef = `portal:${input.sourceRef}`;
  const existing = sqlite
    .prepare(
      `SELECT * FROM agent_space_authorizations
       WHERE source_kind='portal' AND source_ref=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(sourceRef, input.scope.userId, input.scope.projectId, input.scope.instanceId) as
    | {
        authorization_id: string; operation: string; object_type: string; object_id: string;
        version_id: string | null; extra_binding_json: string | null; subject_user: string;
      }
    | undefined;
  if (existing) {
    const storedExtra = existing.extra_binding_json ? (JSON.parse(existing.extra_binding_json) as Record<string, string>) : {};
    const providedExtra = input.extraBinding ?? {};
    const sameBinding = existing.operation === input.operation
      && existing.object_type === input.objectType
      && existing.object_id === input.objectId
      && (existing.version_id ?? null) === (input.versionId ?? null)
      && canonicalExtraBindingJson(storedExtra) === canonicalExtraBindingJson(providedExtra);
    if (!sameBinding) {
      throw new AgentSpaceError(
        "AGENT_SPACE_APPROVAL_REQUIRED",
        `portal action ${sourceRef} is bound to a different target; one source ref names exactly one operation`,
      );
    }
    return `authorization:${existing.authorization_id}`;
  }
  const authorizationId = newId("authz");
  sqlite
    .prepare(
      `INSERT INTO agent_space_authorizations (
         authorization_id, user_id, project_id, instance_id, subject_user,
         operation, object_type, object_id, version_id, extra_binding_json,
         source_kind, source_ref, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'portal', ?, 'active', ?)`,
    )
    .run(
      authorizationId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.scope.userId,
      input.operation, input.objectType, input.objectId, input.versionId ?? null,
      canonicalExtraBindingJson(input.extraBinding) || null, sourceRef, nowIso(),
    );
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "authorization.registered",
    objectType: "agent_space_authorization",
    objectId: authorizationId,
    toStatus: "active",
    detail: {
      operation: input.operation,
      boundObjectType: input.objectType,
      boundObjectId: input.objectId,
      versionId: input.versionId ?? null,
      sourceKind: "portal",
      sourceRef,
      subjectUser: input.scope.userId,
    },
  });
  return `authorization:${authorizationId}`;
}

// ---------------------------------------------------------------------------
// Agent 解析
// ---------------------------------------------------------------------------

export interface PortalAgentSummary {
  agentId: string;
  name: string;
  status: string;
}

/** scope 内 Agent 清单（GUI 安装/启停动作的目标）。 */
export function listPortalAgents(scope: UserScope): PortalAgentSummary[] {
  assertScopeValid(scope);
  const rows = sqlite
    .prepare(
      `SELECT agent_id, name, status FROM agent_space_agents
       WHERE user_id=? AND project_id=? AND instance_id=? ORDER BY created_at ASC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{ agent_id: string; name: string; status: string }>;
  return rows.map((r) => ({ agentId: r.agent_id, name: r.name, status: r.status }));
}

/**
 * 解析 GUI 动作的目标 Agent：显式 agentId 优先；缺省时要求 scope 内恰好
 * 一个 Agent（多 Agent 必须显式指定，不静默挑第一个）。
 */
export function resolvePortalAgent(scope: UserScope, agentId?: string): PortalAgentSummary {
  assertScopeValid(scope);
  if (agentId) {
    const agent = getAgent(scope, agentId);
    return { agentId: agent.agent_id, name: agent.name, status: agent.status };
  }
  const agents = listPortalAgents(scope);
  if (agents.length === 1) return agents[0]!;
  if (agents.length === 0) {
    throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", "this scope has no agent to install skills on");
  }
  throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "multiple agents exist; agentId is required");
}

// ---------------------------------------------------------------------------
// 内容上传（方法/Skill 编辑正文 → user_assets 版本链）
// ---------------------------------------------------------------------------

export interface CommitWorkspaceContentInput {
  scope: UserScope;
  /** 已有内容资产则追加版本；否则新建资产。 */
  assetId?: string;
  fileName: string;
  bytes: Buffer;
  idempotencyKey?: string;
  /** 2026-10-08：技能内容用 skill_content、方法/策略内容用 method_content
   * （「我的文件」默认隐藏，各自管理页负责）；历史默认 upload 保持兼容。 */
  source?: "upload" | "skill_content" | "method_content";
}

export async function commitWorkspaceContent(
  input: CommitWorkspaceContentInput,
): Promise<{ assetId: string; assetVersionId: string; contentChecksum: string }> {
  assertScopeValid(input.scope);
  const contentSource = input.source ?? "upload";
  if (input.assetId) {
    const asset = await uploadUserAssetVersion({
      ...input.scope,
      assetId: input.assetId,
      fileName: input.fileName,
      bytes: input.bytes,
      source: contentSource,
      idempotencyKey: input.idempotencyKey,
    });
    const version = asset.currentVersion;
    if (!asset.currentVersionId || !version) {
      throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "content asset version commit returned no current version");
    }
    return { assetId: asset.assetId, assetVersionId: asset.currentVersionId, contentChecksum: version.checksum };
  }
  const asset = await createUserAsset({
    ...input.scope,
    fileName: input.fileName,
    bytes: input.bytes,
    source: contentSource,
    idempotencyKey: input.idempotencyKey,
  });
  const version = asset.currentVersion;
  if (!asset.currentVersionId || !version) {
    throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "content asset creation returned no current version");
  }
  return { assetId: asset.assetId, assetVersionId: asset.currentVersionId, contentChecksum: version.checksum };
}

// ---------------------------------------------------------------------------
// 方法域显式动作
// ---------------------------------------------------------------------------

export interface PortalActionContext {
  scope: UserScope;
  actor: string;
  /** GUI 幂等键（同键重放返回首次结果，经 R9② 凭证回放）。 */
  idempotencyKey: string;
}

/** 采用草稿版本（approve + adopt 为当前版本）。带默认采用约束的版本会被状态机拒绝（需 owner 决策）。 */
export function portalAdoptMethodVersion(
  ctx: PortalActionContext,
  methodId: string,
  versionId: string,
) {
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: ctx.scope,
      operation: "method.version.approve",
      objectType: "agent_space_method_version",
      objectId: versionId,
      versionId,
      extraBinding: { methodId, adopt: "true" },
      sourceRef: `${ctx.scope.userId}:${ctx.idempotencyKey}`,
      actor: ctx.actor,
    });
    return approveMethodVersion({
      scope: ctx.scope,
      methodId,
      versionId,
      approvedBy: ctx.actor,
      approvalRef,
      adopt: true,
      actor: ctx.actor,
    });
  });
  return tx();
}

/** 恢复/重采用既有正式版本（版本不可变，只移动 current 指针）。 */
export function portalReadoptMethodVersion(
  ctx: PortalActionContext,
  methodId: string,
  versionId: string,
) {
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: ctx.scope,
      operation: "method.readopt",
      objectType: "agent_space_method_version",
      objectId: versionId,
      versionId,
      extraBinding: { methodId },
      sourceRef: `${ctx.scope.userId}:${ctx.idempotencyKey}`,
      actor: ctx.actor,
    });
    return readoptMethodVersion({
      scope: ctx.scope,
      methodId,
      versionId,
      approvalRef,
      actor: ctx.actor,
    });
  });
  return tx();
}

/** 停用方法体系（retire：状态机自身无授权门槛，GUI 侧需显式确认）。 */
export function portalRetireMethod(ctx: PortalActionContext, methodId: string) {
  return retireMethod(ctx.scope, methodId, ctx.actor);
}

// ---------------------------------------------------------------------------
// 方法创建/编辑（内容先落 user_assets，再引用进 agent_space）
// ---------------------------------------------------------------------------

const ADOPTION_CONSTRAINT_VALUES = [
  "hold-ambiguity", "historical-not-default", "split-in-progress",
  "task-specific-reference", "restore-candidate", "revision-evidence",
] as const;

/** 校验并收敛 adoptionConstraints（白名单外拒绝）。 */
function normalizeAdoptionConstraints(raw: string[] | undefined): AdoptionConstraint[] | undefined {
  if (!raw) return undefined;
  const result: AdoptionConstraint[] = [];
  for (const constraint of raw) {
    if (!(ADOPTION_CONSTRAINT_VALUES as readonly string[]).includes(constraint)) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `unknown adoption constraint ${constraint}`);
    }
    result.push(constraint as AdoptionConstraint);
  }
  return result;
}

function contentFileName(base: string): string {
  const cleaned = base.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "content";
  return `${cleaned.slice(0, 120)}.md`;
}

function latestMethodAssetId(scope: UserScope, methodId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT asset_id FROM agent_space_method_versions
       WHERE method_id=? AND user_id=? AND project_id=? AND instance_id=? AND asset_id IS NOT NULL
       ORDER BY version_number DESC LIMIT 1`,
    )
    .get(methodId, scope.userId, scope.projectId, scope.instanceId) as { asset_id: string | null } | undefined;
  return row?.asset_id ?? null;
}

function latestSkillAssetId(scope: UserScope, skillId: string): string | null {
  const row = sqlite
    .prepare(
      `SELECT asset_id FROM agent_space_skill_versions
       WHERE skill_id=? AND user_id=? AND project_id=? AND instance_id=? AND asset_id IS NOT NULL
       ORDER BY version_number DESC LIMIT 1`,
    )
    .get(skillId, scope.userId, scope.projectId, scope.instanceId) as { asset_id: string | null } | undefined;
  return row?.asset_id ?? null;
}

export interface PortalCreateMethodInput {
  scope: UserScope;
  name: string;
  description?: string;
  /** Markdown 正文；服务层落为 user_asset 版本后再被方法版本引用。 */
  text: string;
  adoptionNote?: string;
  adoptionConstraints?: string[];
  actor: string;
  idempotencyKey?: string;
}

/** 创建方法体系 + 首个草稿版本（默认未采用；采用必须走显式 adopt 动作）。 */
export async function portalCreateMethod(input: PortalCreateMethodInput) {
  assertScopeValid(input.scope);
  const adoptionConstraints = normalizeAdoptionConstraints(input.adoptionConstraints);
  const key = input.idempotencyKey ?? `portal:create-method:${input.scope.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = await commitWorkspaceContent({
    scope: input.scope,
    fileName: contentFileName(input.name),
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: `${key}:content`,
    source: "method_content",
  });
  const method = createMethod({
    scope: input.scope,
    name: input.name,
    description: input.description,
    idempotencyKey: `${key}:method`,
    actor: input.actor,
  });
  const version = addMethodVersion({
    scope: input.scope,
    methodId: method.method_id,
    contentRef: content,
    origin: "user",
    adoptionNote: input.adoptionNote,
    adoptionConstraints,
    idempotencyKey: `${key}:version`,
    actor: input.actor,
  });
  return { method: getMethod(input.scope, method.method_id), version, content };
}

export interface PortalAddMethodVersionInput {
  scope: UserScope;
  methodId: string;
  text: string;
  fileName?: string;
  adoptionNote?: string;
  adoptionConstraints?: string[];
  actor: string;
  idempotencyKey?: string;
}

/** 编辑方法：形成新内容版本（草稿，待确认）；不改当前采用版本。 */
export async function portalAddMethodVersion(input: PortalAddMethodVersionInput) {
  assertScopeValid(input.scope);
  const adoptionConstraints = normalizeAdoptionConstraints(input.adoptionConstraints);
  const method = getMethod(input.scope, input.methodId);
  if (method.status === "retired") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "retired method cannot receive versions");
  }
  const assetId = latestMethodAssetId(input.scope, input.methodId);
  const content = await commitWorkspaceContent({
    scope: input.scope,
    assetId: assetId ?? undefined,
    fileName: input.fileName ?? contentFileName(method.name),
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: input.idempotencyKey,
    source: "method_content",
  });
  const version = addMethodVersion({
    scope: input.scope,
    methodId: input.methodId,
    contentRef: content,
    origin: "user",
    adoptionNote: input.adoptionNote,
    adoptionConstraints,
    actor: input.actor,
  });
  return { method: getMethod(input.scope, input.methodId), version, content };
}

// ---------------------------------------------------------------------------
// Skill 域显式动作
// ---------------------------------------------------------------------------

/** 启用私有 Skill 版本（approve → active + current；安装不影响此状态）。 */
export function portalApproveSkillVersion(
  ctx: PortalActionContext,
  skillId: string,
  versionId: string,
) {
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: ctx.scope,
      operation: "skill.version.approve",
      objectType: "agent_space_skill_version",
      objectId: versionId,
      versionId,
      extraBinding: { skillId },
      sourceRef: `${ctx.scope.userId}:${ctx.idempotencyKey}`,
      actor: ctx.actor,
    });
    return approveSkillVersion({
      domain: "user",
      scope: ctx.scope,
      skillId,
      versionId,
      approvedBy: ctx.actor,
      approvalRef,
      actor: ctx.actor,
    });
  });
  return tx();
}

export interface PortalInstallSkillInput {
  ctx: PortalActionContext;
  agentId: string;
  skillId: string;
  source: "release" | "private";
  releaseId?: string;
  versionId: string;
  installedBy: string;
}

/** 安装/升级（新安装行固定版本，旧行 superseded；R9 凭证核验+消耗同事务）。 */
export function portalInstallSkill(input: PortalInstallSkillInput) {
  const extra: Record<string, string> = { skillId: input.skillId, source: input.source };
  if (input.source === "release") extra.releaseId = input.releaseId ?? "";
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: input.ctx.scope,
      operation: "skill.install",
      objectType: "agent_space_agent_skill_installation",
      objectId: input.agentId,
      versionId: input.versionId,
      extraBinding: extra,
      sourceRef: `${input.ctx.scope.userId}:${input.ctx.idempotencyKey}`,
      actor: input.ctx.actor,
    });
    return installSkill({
      scope: input.ctx.scope,
      agentId: input.agentId,
      skillId: input.skillId,
      source: input.source,
      releaseId: input.releaseId,
      versionId: input.versionId,
      installedBy: input.installedBy,
      approvalRef,
      actor: input.ctx.actor,
    });
  });
  return tx();
}

/** 卸载（安装行保留 status=removed 供追溯，运行解析随即拒绝）；user 域技能同事务打墓碑（2026-10-08 裁决「删除就消失」），系统域不变。 */
export function portalRemoveInstalledSkill(
  ctx: PortalActionContext,
  agentId: string,
  skillId: string,
) {
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: ctx.scope,
      operation: "skill.remove",
      objectType: "agent_space_agent_skill_installation",
      objectId: agentId,
      versionId: null,
      extraBinding: { skillId },
      sourceRef: `${ctx.scope.userId}:${ctx.idempotencyKey}`,
      actor: ctx.actor,
    });
    return removeInstalledSkill({
      scope: ctx.scope,
      agentId,
      skillId,
      approvalRef,
      actor: ctx.actor,
    });
  });
  return tx();
}

export function portalSetInstalledSkillEnabled(
  ctx: PortalActionContext, agentId: string, skillId: string, enabled: boolean,
) {
  const tx = sqlite.transaction(() => {
    const approvalRef = registerPortalActionAuthorization({
      scope: ctx.scope, operation: "skill.installation.set_enabled",
      objectType: "agent_space_agent_skill_installation", objectId: agentId, versionId: null,
      extraBinding: { skillId, enabled: String(enabled) },
      sourceRef: `${ctx.scope.userId}:${ctx.idempotencyKey}`, actor: ctx.actor,
    });
    return setInstalledSkillEnabled({ scope: ctx.scope, agentId, skillId, enabled, approvalRef, actor: ctx.actor });
  });
  return tx();
}

// ---------------------------------------------------------------------------
// Skill 创建/编辑（私有域；编辑形成新版本，明确启用才生效）
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-_.]{1,120}$/;

export interface PortalCreateSkillInput {
  scope: UserScope;
  slug: string;
  name: string;
  description?: string;
  text: string;
  actor: string;
  idempotencyKey?: string;
}

/** 创建私有 Skill + 首个草稿版本（未启用；启用/安装是后续显式动作）。 */
export async function portalCreateSkill(input: PortalCreateSkillInput) {
  assertScopeValid(input.scope);
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "slug must be lowercase letters, digits, '-', '_' or '.' (2-121 chars)");
  }
  const existing = sqlite
    .prepare(
      `SELECT skill_id FROM agent_space_skills
       WHERE domain='user' AND COALESCE(user_id,'')=? AND COALESCE(project_id,'')=? AND COALESCE(instance_id,'')=? AND slug=?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.slug) as { skill_id: string } | undefined;
  if (existing) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `slug ${input.slug} already exists in this scope`);
  }
  const key = input.idempotencyKey ?? `portal:create-skill:${input.scope.userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const content = await commitWorkspaceContent({
    scope: input.scope,
    fileName: contentFileName(input.slug),
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: `${key}:content`,
    source: "skill_content",
  });
  const skill = upsertSkill({ domain: "user", scope: input.scope, slug: input.slug, name: input.name, description: input.description, actor: input.actor });
  const version = await addSkillVersion({
    domain: "user",
    scope: input.scope,
    skillId: skill.skill_id,
    contentRef: { contentRefType: "user_asset_version", assetId: content.assetId, assetVersionId: content.assetVersionId, contentChecksum: content.contentChecksum },
    origin: "private_edit",
    actor: input.actor,
  });
  return { skill, version, content };
}

export interface PortalEditSkillInput {
  scope: UserScope;
  skillId: string;
  text: string;
  name?: string;
  description?: string;
  fileName?: string;
  actor: string;
  idempotencyKey?: string;
}

/** 编辑私有 Skill：新草稿版本（继承 contentRefType=user_asset_version 的内容链）。
 * name/description 可选一并更新（对话 Agent 的 skill.edit 开放元信息修改）。 */
export async function portalEditSkill(input: PortalEditSkillInput) {
  assertScopeValid(input.scope);
  const skill = sqlite
    .prepare(
      `SELECT skill_id, slug, status FROM agent_space_skills
       WHERE skill_id=? AND domain='user' AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(input.skillId, input.scope.userId, input.scope.projectId, input.scope.instanceId) as
    | { skill_id: string; slug: string; status: string }
    | undefined;
  if (!skill) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${input.skillId}`);
  // 2026-10-08 裁决「删除就消失」：墓碑技能不可再编辑（避免复活）。
  if (skill.status === "deleted") throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${input.skillId}`);
  if (input.name !== undefined || input.description !== undefined) {
    if (input.name !== undefined && !input.name.trim()) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "name must be non-empty when provided");
    }
    sqlite
      .prepare("UPDATE agent_space_skills SET name=COALESCE(?, name), description=COALESCE(?, description), updated_at=? WHERE skill_id=?")
      .run(input.name?.trim() ?? null, input.description?.trim() ?? null, nowIso(), input.skillId);
  }
  const assetId = latestSkillAssetId(input.scope, input.skillId);
  const content = await commitWorkspaceContent({
    scope: input.scope,
    assetId: assetId ?? undefined,
    fileName: input.fileName ?? contentFileName(skill.slug),
    bytes: Buffer.from(input.text, "utf8"),
    idempotencyKey: input.idempotencyKey,
    source: "skill_content",
  });
  const version = await addSkillVersion({
    domain: "user",
    scope: input.scope,
    skillId: input.skillId,
    contentRef: { contentRefType: "user_asset_version", assetId: content.assetId, assetVersionId: content.assetVersionId, contentChecksum: content.contentChecksum },
    origin: "private_edit",
    actor: input.actor,
  });
  return { skillId: input.skillId, version, content };
}

// ---------------------------------------------------------------------------
// Skill 安装目标解析（release/private 默认版本）
// ---------------------------------------------------------------------------

/**
 * 解析 install/upgrade 目标版本：
 * - releaseId 给定 → 校验可安装（public+published / private 属主）并取其固定版本；
 * - 否则取私有 Skill 当前已批准版本（draft 不可安装，状态机强制）。
 */
export function resolveSkillInstallTarget(
  scope: UserScope,
  skillId: string,
  releaseId?: string,
  versionId?: string,
): { source: "release" | "private"; releaseId?: string; versionId: string } {
  assertScopeValid(scope);
  if (releaseId) {
    const release = getSkillReleaseForInstaller(scope, releaseId);
    if (release.skill_id !== skillId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "release does not belong to this skill");
    }
    if (versionId && versionId !== release.version_id) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "release does not pin this version");
    }
    return { source: "release", releaseId, versionId: release.version_id };
  }
  if (versionId) {
    const version = getSkillVersion("user", scope, versionId);
    if (version.skill_id !== skillId) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to this skill");
    }
    return { source: "private", versionId };
  }
  const row = sqlite
    .prepare(
      `SELECT current_private_version_id FROM agent_space_skills
       WHERE skill_id=? AND domain='user' AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(skillId, scope.userId, scope.projectId, scope.instanceId) as { current_private_version_id: string | null } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${skillId}`);
  if (!row.current_private_version_id) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "skill has no approved version to install; enable it first");
  }
  return { source: "private", versionId: row.current_private_version_id };
}

export function assertPortalManageableSkill(skillId: string): void {
  const row = sqlite.prepare("SELECT is_core FROM agent_space_skills WHERE skill_id=?").get(skillId) as { is_core: number } | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${skillId}`);
  if (row.is_core === 1) throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "core skill is not user manageable");
}

// ---------------------------------------------------------------------------
// 读模型：方法
// ---------------------------------------------------------------------------

export interface PortalMethodVersionMeta {
  versionId: string;
  versionNumber: number;
  status: "draft" | "approved" | "superseded" | "retired";
  adoptionNote: string | null;
  adoptionConstraints: string[];
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesVersionNumber: number | null;
  createdAt: string;
}

export interface PortalMethodTaskUsage {
  taskId: string;
  taskName: string | null;
  taskStatus: string | null;
  versionPolicy: string;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
}

export interface PortalMethodAgentBinding {
  agentId: string;
  agentName: string;
  versionPolicy: string;
  pinnedVersionId: string | null;
  pinnedVersionNumber: number | null;
}

export interface PortalMethodCard {
  methodId: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentVersionApprovedAt: string | null;
  currentVersionConstraints: string[];
  pendingDraft: { versionId: string; versionNumber: number; adoptionNote: string | null; createdAt: string } | null;
  versionCount: number;
  taskBindingCount: number;
  agentBindings: PortalMethodAgentBinding[];
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MethodVersionRaw {
  version_id: string;
  method_id: string;
  version_number: number;
  status: string;
  adoption_note: string | null;
  adoption_constraints: string | null;
  approved_by: string | null;
  approved_at: string | null;
  supersedes_version_id: string | null;
  asset_id: string | null;
  created_at: string;
}

function toVersionMeta(row: MethodVersionRaw, numberById: Map<string, number>): PortalMethodVersionMeta {
  return {
    versionId: row.version_id,
    versionNumber: row.version_number,
    status: row.status as PortalMethodVersionMeta["status"],
    adoptionNote: row.adoption_note,
    adoptionConstraints: row.adoption_constraints ? JSON.parse(row.adoption_constraints) as string[] : [],
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    supersedesVersionNumber: row.supersedes_version_id ? numberById.get(row.supersedes_version_id) ?? null : null,
    createdAt: row.created_at,
  };
}

function loadMethodVersions(scope: UserScope, methodId: string): MethodVersionRaw[] {
  return sqlite
    .prepare(
      `SELECT version_id, method_id, version_number, status, adoption_note, adoption_constraints,
              approved_by, approved_at, supersedes_version_id, asset_id, created_at
       FROM agent_space_method_versions
       WHERE method_id=? AND user_id=? AND project_id=? AND instance_id=?
       ORDER BY version_number ASC`,
    )
    .all(methodId, scope.userId, scope.projectId, scope.instanceId) as MethodVersionRaw[];
}

function loadMethodTaskUsage(scope: UserScope, methodId: string): PortalMethodTaskUsage[] {
  return (
    sqlite
      .prepare(
        `SELECT d.task_id, d.version_policy, d.pinned_version_id, v.version_number AS pinned_version_number,
                (SELECT r.name FROM automation_task_revisions r
                 WHERE r.task_id = d.task_id AND r.revision_id = t.current_revision_id) AS task_name,
                t.status AS task_status
         FROM agent_space_task_dependencies d
         LEFT JOIN automation_tasks t ON t.task_id = d.task_id AND t.user_id=d.user_id AND t.project_id=d.project_id AND t.instance_id=d.instance_id
         LEFT JOIN agent_space_method_versions v ON v.version_id = d.pinned_version_id
         WHERE d.kind='method' AND d.ref_id=? AND d.user_id=? AND d.project_id=? AND d.instance_id=?
         ORDER BY d.created_at DESC`,
      )
      .all(methodId, scope.userId, scope.projectId, scope.instanceId) as Array<{
        task_id: string; task_name: string | null; task_status: string | null;
        version_policy: string; pinned_version_id: string | null; pinned_version_number: number | null;
      }>
  ).map((r) => ({
    taskId: r.task_id,
    taskName: r.task_name,
    taskStatus: r.task_status,
    versionPolicy: r.version_policy,
    pinnedVersionId: r.pinned_version_id,
    pinnedVersionNumber: r.pinned_version_number,
  }));
}

function loadMethodAgentBindings(scope: UserScope, methodId: string): PortalMethodAgentBinding[] {
  return (
    sqlite
      .prepare(
        `SELECT b.agent_id, a.name AS agent_name, b.version_policy, b.pinned_version_id, v.version_number AS pinned_version_number
         FROM agent_space_agent_method_bindings b
         JOIN agent_space_agents a ON a.agent_id = b.agent_id
         LEFT JOIN agent_space_method_versions v ON v.version_id = b.pinned_version_id
         WHERE b.method_id=? AND b.user_id=? AND b.project_id=? AND b.instance_id=? AND b.status='active'`,
      )
      .all(methodId, scope.userId, scope.projectId, scope.instanceId) as Array<{
        agent_id: string; agent_name: string; version_policy: string;
        pinned_version_id: string | null; pinned_version_number: number | null;
      }>
  ).map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    versionPolicy: r.version_policy,
    pinnedVersionId: r.pinned_version_id,
    pinnedVersionNumber: r.pinned_version_number,
  }));
}

/** 方法列表读模型（卡片字段：名称/用途/采用态/最近变更/绑定任务数/待确认版本）。 */
export function listPortalMethods(scope: UserScope): PortalMethodCard[] {
  assertScopeValid(scope);
  const methods = sqlite
    .prepare(
      `SELECT m.method_id, m.name, m.description, m.status, m.current_version_id, m.created_at, m.updated_at,
              (SELECT COUNT(*) FROM agent_space_method_versions v WHERE v.method_id = m.method_id) AS version_count,
              (SELECT v.asset_id FROM agent_space_method_versions v WHERE v.method_id = m.method_id
               ORDER BY v.version_number DESC LIMIT 1) AS asset_id
       FROM agent_space_methods m
       WHERE m.user_id=? AND m.project_id=? AND m.instance_id=?
       ORDER BY m.updated_at DESC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{
      method_id: string; name: string; description: string | null; status: string;
      current_version_id: string | null; created_at: string; updated_at: string;
      version_count: number; asset_id: string | null;
    }>;
  return methods.map((m) => {
    const versions = loadMethodVersions(scope, m.method_id);
    const current = versions.find((v) => v.version_id === m.current_version_id) ?? null;
    const drafts = versions.filter((v) => v.status === "draft");
    const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1]! : null;
    const usage = loadMethodTaskUsage(scope, m.method_id);
    return {
      methodId: m.method_id,
      name: m.name,
      description: m.description,
      status: m.status,
      currentVersionId: m.current_version_id,
      currentVersionNumber: current?.version_number ?? null,
      currentVersionApprovedAt: current?.approved_at ?? null,
      currentVersionConstraints: current?.adoption_constraints ? JSON.parse(current.adoption_constraints) as string[] : [],
      pendingDraft: latestDraft
        ? {
            versionId: latestDraft.version_id,
            versionNumber: latestDraft.version_number,
            adoptionNote: latestDraft.adoption_note,
            createdAt: latestDraft.created_at,
          }
        : null,
      versionCount: m.version_count,
      taskBindingCount: usage.length,
      agentBindings: loadMethodAgentBindings(scope, m.method_id),
      assetId: m.asset_id,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    };
  });
}

export async function listPortalMethodAssets(scope: UserScope): Promise<Array<{
  assetId: string; name: string; fileName: string; format: string; sizeBytes: number;
  source: string; updatedAt: string; status: string; folderName: string; currentVersionId: string | null;
  workingCopyUpdatedAt: string | null; workingCopyBaseVersionId: string | null;
}>> {
  assertScopeValid(scope);
  const folder = sqlite.prepare(
    `SELECT folder_id, name FROM user_asset_folders
     WHERE user_id=? AND project_id=? AND instance_id=? AND name='我的方法' LIMIT 1`,
  ).get(scope.userId, scope.projectId, scope.instanceId) as { folder_id: string; name: string } | undefined;
  if (!folder) return [];
  return sqlite.prepare(
    `SELECT a.asset_id AS assetId, a.name, v.file_name AS fileName, v.format, v.size_bytes AS sizeBytes,
            v.source, a.updated_at AS updatedAt, a.status, f.name AS folderName, a.current_version_id AS currentVersionId,
            wc.updated_at AS workingCopyUpdatedAt, wc.base_version_id AS workingCopyBaseVersionId
     FROM user_assets a JOIN user_asset_versions v ON v.version_id=a.current_version_id
     JOIN user_asset_folders f ON f.folder_id=a.folder_id
     LEFT JOIN method_asset_working_copies wc ON wc.asset_id=a.asset_id AND wc.user_id=a.user_id
       AND wc.project_id=a.project_id AND wc.instance_id=a.instance_id
     WHERE a.user_id=? AND a.project_id=? AND a.instance_id=? AND a.folder_id=? AND a.status='active'
     ORDER BY a.updated_at DESC, a.name COLLATE NOCASE`,
  ).all(scope.userId, scope.projectId, scope.instanceId, folder.folder_id) as Array<{
    assetId: string; name: string; fileName: string; format: string; sizeBytes: number;
    source: string; updatedAt: string; status: string; folderName: string; currentVersionId: string | null;
    workingCopyUpdatedAt: string | null; workingCopyBaseVersionId: string | null;
  }>;
}

export interface PortalMethodDetail {
  method: PortalMethodCard;
  versions: PortalMethodVersionMeta[];
  taskUsage: PortalMethodTaskUsage[];
  content: { versionId: string; versionNumber: number; text: string } | null;
}

function buildPortalMethodCard(scope: UserScope, methodId: string): { card: PortalMethodCard; versions: MethodVersionRaw[] } {
  const row = getMethod(scope, methodId);
  const versions = loadMethodVersions(scope, methodId);
  const current = versions.find((v) => v.version_id === row.current_version_id) ?? null;
  const drafts = versions.filter((v) => v.status === "draft");
  const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1]! : null;
  const assetId = versions.length > 0 ? versions[versions.length - 1]!.asset_id : null;
  const taskUsage = loadMethodTaskUsage(scope, methodId);
  const card: PortalMethodCard = {
    methodId: row.method_id,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersionId: row.current_version_id,
    currentVersionNumber: current?.version_number ?? null,
    currentVersionApprovedAt: current?.approved_at ?? null,
    currentVersionConstraints: current?.adoption_constraints ? JSON.parse(current.adoption_constraints) as string[] : [],
    pendingDraft: latestDraft
      ? { versionId: latestDraft.version_id, versionNumber: latestDraft.version_number, adoptionNote: latestDraft.adoption_note, createdAt: latestDraft.created_at }
      : null,
    versionCount: versions.length,
    taskBindingCount: taskUsage.length,
    agentBindings: loadMethodAgentBindings(scope, methodId),
    assetId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return { card, versions };
}

/** 单方法卡片读模型（写动作后回读，不含正文）。 */
export function getPortalMethodCard(scope: UserScope, methodId: string): PortalMethodCard {
  assertScopeValid(scope);
  return buildPortalMethodCard(scope, methodId).card;
}

/** 方法详情读模型（含当前版本正文，供编辑入口预填）。 */
export async function getPortalMethodDetail(scope: UserScope, methodId: string): Promise<PortalMethodDetail> {
  assertScopeValid(scope);
  const { card, versions } = buildPortalMethodCard(scope, methodId);
  const numberById = new Map(versions.map((v) => [v.version_id, v.version_number]));
  let content: PortalMethodDetail["content"] = null;
  const current = versions.find((v) => v.version_id === card.currentVersionId);
  if (current) {
    const text = await readVersionTextSafely(async () => {
      const read = await readMethodVersionContent(scope, current.version_id);
      return read.bytes;
    });
    if (text !== null) content = { versionId: current.version_id, versionNumber: current.version_number, text };
  }
  return {
    method: card,
    versions: versions.map((v) => toVersionMeta(v, numberById)),
    taskUsage: loadMethodTaskUsage(scope, methodId),
    content,
  };
}

/** 版本正文（Diff/预览用；markdown 文本）。 */
export async function readPortalMethodVersionText(scope: UserScope, versionId: string): Promise<{ versionId: string; versionNumber: number; text: string } | null> {
  assertScopeValid(scope);
  const read = await readMethodVersionContent(scope, versionId);
  const text = await readVersionTextSafely(async () => read.bytes);
  return text === null ? null : { versionId: read.version.version_id, versionNumber: read.version.version_number, text };
}

/** 版本元数据 diff（checksum 层）+ 双侧正文（GUI 并排展示）。 */
export async function diffPortalMethodVersions(
  scope: UserScope,
  fromVersionId: string,
  toVersionId: string,
): Promise<{
  identical: boolean;
  from: { versionId: string; versionNumber: number; text: string } | null;
  to: { versionId: string; versionNumber: number; text: string } | null;
}> {
  const meta = diffMethodVersions(scope, fromVersionId, toVersionId);
  return {
    identical: meta.identical,
    from: await readPortalMethodVersionText(scope, fromVersionId),
    to: await readPortalMethodVersionText(scope, toVersionId),
  };
}

// ---------------------------------------------------------------------------
// 读模型：Skill
// ---------------------------------------------------------------------------

export interface PortalSkillVersionMeta {
  versionId: string;
  versionNumber: number;
  status: "draft" | "approved" | "superseded";
  origin: string;
  approvedBy: string | null;
  approvedAt: string | null;
  supersedesVersionNumber: number | null;
  derivedFromVersionNumber: number | null;
  createdAt: string;
}

export interface PortalSkillInstallation {
  installationId: string;
  agentId: string;
  agentName: string;
  source: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  installedAt: string;
  status: "installed" | "disabled";
}

export interface PortalUpgradeOption {
  kind: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  publishedAt: string | null;
}

export interface PortalPrivateSkillCard {
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  currentVersionApprovedAt: string | null;
  pendingDraft: { versionId: string; versionNumber: number; createdAt: string } | null;
  versionCount: number;
  derivedFromReleaseId: string | null;
  installation: PortalSkillInstallation | null;
  availableUpgrade: PortalUpgradeOption | null;
  taskBindingCount: number;
  assetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PortalInstalledSkillCard {
  installationId: string;
  skillId: string;
  slug: string;
  name: string;
  description: string | null;
  source: "release" | "private";
  releaseId: string | null;
  releaseVersion: string | null;
  versionId: string;
  versionNumber: number;
  installedAt: string;
  status: "installed" | "disabled";
  availableUpgrade: PortalUpgradeOption | null;
  isPrivateSkill: boolean;
}

interface SkillVersionRaw {
  version_id: string;
  skill_id: string;
  version_number: number;
  origin: string;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  supersedes_version_id: string | null;
  derived_from_version_id: string | null;
  asset_id: string | null;
  created_at: string;
}

function loadSkillVersions(scope: UserScope, skillId: string): SkillVersionRaw[] {
  return sqlite
    .prepare(
      `SELECT version_id, skill_id, version_number, origin, status, approved_by, approved_at,
              supersedes_version_id, derived_from_version_id, asset_id, created_at
       FROM agent_space_skill_versions
       WHERE skill_id=? AND user_id=? AND project_id=? AND instance_id=?
       ORDER BY version_number ASC`,
    )
    .all(skillId, scope.userId, scope.projectId, scope.instanceId) as SkillVersionRaw[];
}

function loadSkillInstallations(scope: UserScope, skillIds: string[]): Map<string, PortalSkillInstallation> {
  const result = new Map<string, PortalSkillInstallation>();
  if (skillIds.length === 0) return result;
  const placeholders = skillIds.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT i.installation_id, i.agent_id, a.name AS agent_name, i.skill_id, i.source,
              i.release_id, i.release_version, i.version_id, v.version_number, i.installed_at, i.status
       FROM agent_space_agent_skill_installations i
       JOIN agent_space_agents a ON a.agent_id = i.agent_id
       JOIN agent_space_skill_versions v ON v.version_id = i.version_id
       WHERE i.skill_id IN (${placeholders}) AND i.user_id=? AND i.project_id=? AND i.instance_id=? AND i.status IN ('installed','disabled')
       ORDER BY i.installed_at DESC`,
    )
    .all(...skillIds, scope.userId, scope.projectId, scope.instanceId) as Array<{
      installation_id: string; agent_id: string; agent_name: string; skill_id: string;
      source: "release" | "private"; release_id: string | null; release_version: string | null;
      version_id: string; version_number: number; installed_at: string; status: "installed" | "disabled";
    }>;
  for (const r of rows) if (!result.has(r.skill_id)) {
    result.set(r.skill_id, {
      installationId: r.installation_id,
      agentId: r.agent_id,
      agentName: r.agent_name,
      source: r.source,
      releaseId: r.release_id,
      releaseVersion: r.release_version,
      versionId: r.version_id,
      versionNumber: r.version_number,
      installedAt: r.installed_at,
      status: r.status,
    });
  }
  return result;
}

/** 已安装安装的可用升级：release 来源看更新发布；private 来源看更新已批准私有版本。 */
function loadAvailableUpgrade(
  scope: UserScope,
  skillId: string,
  installed: PortalSkillInstallation | null,
): PortalUpgradeOption | null {
  if (!installed) return null;
  if (installed.source === "release") {
    const row = sqlite
      .prepare(
        `SELECT release_id, release_version, version_id, published_at
         FROM agent_space_skill_releases
         WHERE skill_id=? AND status='published' AND visibility='public' AND release_id<>?
         ORDER BY published_at DESC LIMIT 1`,
      )
      .get(skillId, installed.releaseId ?? "") as
      | { release_id: string; release_version: string; version_id: string; published_at: string }
      | undefined;
    if (!row) return null;
    const version = sqlite
      .prepare("SELECT version_number FROM agent_space_skill_versions WHERE version_id=?")
      .get(row.version_id) as { version_number: number } | undefined;
    return {
      kind: "release",
      releaseId: row.release_id,
      releaseVersion: row.release_version,
      versionId: row.version_id,
      versionNumber: version?.version_number ?? 0,
      publishedAt: row.published_at,
    };
  }
  const row = sqlite
    .prepare(
      `SELECT version_id, version_number FROM agent_space_skill_versions
       WHERE skill_id=? AND user_id=? AND project_id=? AND instance_id=? AND status='approved' AND version_number>?
       ORDER BY version_number DESC LIMIT 1`,
    )
    .get(skillId, scope.userId, scope.projectId, scope.instanceId, installed.versionNumber) as
    | { version_id: string; version_number: number }
    | undefined;
  if (!row) return null;
  return { kind: "private", releaseId: null, releaseVersion: null, versionId: row.version_id, versionNumber: row.version_number, publishedAt: null };
}

function countSkillTaskBindings(scope: UserScope, skillId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS c FROM agent_space_task_dependencies
       WHERE kind='skill' AND ref_id=? AND user_id=? AND project_id=? AND instance_id=?`,
    )
    .get(skillId, scope.userId, scope.projectId, scope.instanceId) as { c: number };
  return row.c;
}

/** 私有 Skill 列表读模型（两区块之一：scope 内 user 域技能）；墓碑技能不出现（2026-10-08 裁决「删除就消失」）。 */
export function listPortalPrivateSkills(scope: UserScope): PortalPrivateSkillCard[] {
  assertScopeValid(scope);
  const skills = sqlite
    .prepare(
      `SELECT s.skill_id, s.slug, s.name, s.description, s.status, s.current_private_version_id,
              s.derived_from_release_id, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM agent_space_skill_versions v WHERE v.skill_id = s.skill_id) AS version_count,
              (SELECT v.asset_id FROM agent_space_skill_versions v WHERE v.skill_id = s.skill_id
               ORDER BY v.version_number DESC LIMIT 1) AS asset_id
       FROM agent_space_skills s
       WHERE s.domain='user' AND s.user_id=? AND s.project_id=? AND s.instance_id=? AND s.status <> 'deleted'
       ORDER BY s.updated_at DESC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{
      skill_id: string; slug: string; name: string; description: string | null; status: string;
      current_private_version_id: string | null; derived_from_release_id: string | null;
      created_at: string; updated_at: string; version_count: number; asset_id: string | null;
    }>;
  const installations = loadSkillInstallations(scope, skills.map((s) => s.skill_id));
  return skills.map((s) => {
    const versions = loadSkillVersions(scope, s.skill_id);
    const current = versions.find((v) => v.version_id === s.current_private_version_id) ?? null;
    const drafts = versions.filter((v) => v.status === "draft");
    const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1]! : null;
    const installation = installations.get(s.skill_id) ?? null;
    return {
      skillId: s.skill_id,
      slug: s.slug,
      name: s.name,
      description: s.description,
      status: s.status,
      currentVersionId: s.current_private_version_id,
      currentVersionNumber: current?.version_number ?? null,
      currentVersionApprovedAt: current?.approved_at ?? null,
      pendingDraft: latestDraft ? { versionId: latestDraft.version_id, versionNumber: latestDraft.version_number, createdAt: latestDraft.created_at } : null,
      versionCount: s.version_count,
      derivedFromReleaseId: s.derived_from_release_id,
      installation,
      availableUpgrade: loadAvailableUpgrade(scope, s.skill_id, installation),
      taskBindingCount: countSkillTaskBindings(scope, s.skill_id),
      assetId: s.asset_id,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  });
}

/** 已安装 Skill 列表读模型（两区块之二：指定 Agent 的当前安装清单）。 */
export function listPortalInstalledSkills(scope: UserScope, agentId?: string): { agent: PortalAgentSummary; items: PortalInstalledSkillCard[] } {
  const agent = resolvePortalAgent(scope, agentId);
  const rows = sqlite
    .prepare(
      `SELECT i.installation_id, i.skill_id, s.slug, s.name, s.description, i.source,
              i.release_id, i.release_version, i.version_id, v.version_number, i.installed_at, i.status,
              (s.domain='user' AND s.user_id=? AND s.project_id=? AND s.instance_id=?) AS is_private_skill
       FROM agent_space_agent_skill_installations i
       JOIN agent_space_skills s ON s.skill_id = i.skill_id
       JOIN agent_space_skill_versions v ON v.version_id = i.version_id
       WHERE i.agent_id=? AND i.user_id=? AND i.project_id=? AND i.instance_id=?
         AND i.status IN ('installed','disabled') AND s.is_core=0
       ORDER BY i.installed_at DESC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId, agent.agentId, scope.userId, scope.projectId, scope.instanceId) as Array<{
      installation_id: string; skill_id: string; slug: string; name: string; description: string | null;
      source: "release" | "private"; release_id: string | null; release_version: string | null;
      version_id: string; version_number: number; installed_at: string; is_private_skill: number; status: "installed" | "disabled";
    }>;
  const installations = loadSkillInstallations(scope, rows.map((r) => r.skill_id));
  return {
    agent,
    items: rows.map((r) => ({
      installationId: r.installation_id,
      skillId: r.skill_id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      source: r.source,
      releaseId: r.release_id,
      releaseVersion: r.release_version,
      versionId: r.version_id,
      versionNumber: r.version_number,
      installedAt: r.installed_at,
      status: r.status,
      availableUpgrade: loadAvailableUpgrade(scope, r.skill_id, installations.get(r.skill_id) ?? null),
      isPrivateSkill: r.is_private_skill === 1,
      taskBindingCount: countSkillTaskBindings(scope, r.skill_id),
    })),
  };
}

/** Small recovery directory: latest installable release/private version per skill. Tombstoned skills (2026-10-08 裁决) never appear. */
export function listPortalSkillCatalog(scope: UserScope, agentId?: string) {
  const agent = resolvePortalAgent(scope, agentId);
  const releases = sqlite.prepare(
    `SELECT r.skill_id AS skillId, s.slug, s.name, s.description, r.release_id AS releaseId,
            r.release_version AS releaseVersion, r.version_id AS versionId
     FROM agent_space_skill_releases r JOIN agent_space_skills s ON s.skill_id=r.skill_id
     WHERE r.visibility='public' AND r.status='published' AND s.is_core=0 AND s.status <> 'deleted'
       AND NOT EXISTS (SELECT 1 FROM agent_space_agent_skill_installations i
         WHERE i.agent_id=? AND i.skill_id=r.skill_id AND i.status IN ('installed','disabled'))
     ORDER BY r.published_at DESC`,
  ).all(agent.agentId) as Array<{ skillId: string; slug: string; name: string; description: string | null; releaseId: string; releaseVersion: string; versionId: string }>;
  const privateSkills = sqlite.prepare(
    `SELECT s.skill_id AS skillId, s.slug, s.name, s.description,
            s.current_private_version_id AS versionId
     FROM agent_space_skills s
     WHERE s.domain='user' AND s.user_id=? AND s.project_id=? AND s.instance_id=?
       AND s.current_private_version_id IS NOT NULL AND s.status <> 'deleted'
       AND NOT EXISTS (SELECT 1 FROM agent_space_agent_skill_installations i
         WHERE i.agent_id=? AND i.skill_id=s.skill_id AND i.status IN ('installed','disabled'))`,
  ).all(scope.userId, scope.projectId, scope.instanceId, agent.agentId) as Array<{ skillId: string; slug: string; name: string; description: string | null; versionId: string }>;
  const items = new Map<string, { skillId: string; slug: string; name: string; description: string | null; releaseId: string | null; releaseVersion: string | null; versionId: string; source: "release" | "private" }>();
  for (const row of releases) if (!items.has(row.skillId)) items.set(row.skillId, { ...row, source: "release" });
  for (const row of privateSkills) items.set(row.skillId, { ...row, releaseId: null, releaseVersion: null, source: "private" });
  return { items: [...items.values()] };
}

export interface PortalSkillDetail {
  skill: PortalPrivateSkillCard;
  versions: PortalSkillVersionMeta[];
  installations: PortalSkillInstallation[];
  taskUsage: Array<{ taskId: string; taskName: string | null; taskStatus: string | null }>;
  relatedMethodIds: Array<{ methodId: string; name: string }>;
  content: { versionId: string; versionNumber: number; text: string } | null;
}

/** Skill 详情读模型（版本、关联方法与适用任务，含当前版本正文）。 */
export async function getPortalSkillDetail(scope: UserScope, skillId: string): Promise<PortalSkillDetail> {
  assertScopeValid(scope);
  const row = sqlite
    .prepare(
      `SELECT s.skill_id, s.slug, s.name, s.description, s.status, s.current_private_version_id,
              s.derived_from_release_id, s.created_at, s.updated_at
       FROM agent_space_skills s
       WHERE s.skill_id=? AND s.domain='user' AND s.user_id=? AND s.project_id=? AND s.instance_id=?`,
    )
    .get(skillId, scope.userId, scope.projectId, scope.instanceId) as
    | { skill_id: string; slug: string; name: string; description: string | null; status: string;
        current_private_version_id: string | null; derived_from_release_id: string | null;
        created_at: string; updated_at: string }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `skill ${skillId}`);
  const versions = loadSkillVersions(scope, skillId);
  const numberById = new Map(versions.map((v) => [v.version_id, v.version_number]));
  const current = versions.find((v) => v.version_id === row.current_private_version_id) ?? null;
  const drafts = versions.filter((v) => v.status === "draft");
  const latestDraft = drafts.length > 0 ? drafts[drafts.length - 1]! : null;
  const installations = [...loadSkillInstallations(scope, [skillId]).values()];
  const installation = installations[0] ?? null;
  const taskUsage = (
    sqlite
      .prepare(
        `SELECT d.task_id,
                (SELECT r.name FROM automation_task_revisions r
                 WHERE r.task_id = d.task_id AND r.revision_id = t.current_revision_id) AS task_name,
                t.status AS task_status
         FROM agent_space_task_dependencies d
         LEFT JOIN automation_tasks t ON t.task_id = d.task_id AND t.user_id=d.user_id AND t.project_id=d.project_id AND t.instance_id=d.instance_id
         WHERE d.kind='skill' AND d.ref_id=? AND d.user_id=? AND d.project_id=? AND d.instance_id=?
         ORDER BY d.created_at DESC`,
      )
      .all(skillId, scope.userId, scope.projectId, scope.instanceId) as Array<{ task_id: string; task_name: string | null; task_status: string | null }>
  ).map((r) => ({ taskId: r.task_id, taskName: r.task_name, taskStatus: r.task_status }));
  const relatedMethodIds = (
    sqlite
      .prepare(
        `SELECT DISTINCT m.method_id, m.name
         FROM agent_space_methods m
         JOIN agent_space_task_dependencies dm ON dm.kind='method' AND dm.ref_id = m.method_id
           AND dm.user_id=m.user_id AND dm.project_id=m.project_id AND dm.instance_id=m.instance_id
         JOIN agent_space_task_dependencies ds ON ds.kind='skill' AND ds.task_id = dm.task_id
           AND ds.user_id=dm.user_id AND ds.project_id=dm.project_id AND ds.instance_id=dm.instance_id
         WHERE ds.ref_id=? AND m.user_id=? AND m.project_id=? AND m.instance_id=?`,
      )
      .all(skillId, scope.userId, scope.projectId, scope.instanceId) as Array<{ method_id: string; name: string }>
  ).map((r) => ({ methodId: r.method_id, name: r.name }));

  let content: PortalSkillDetail["content"] = null;
  if (current) {
    const text = await readVersionTextSafely(async () => readSkillVersionContentBytes(getSkillVersionRow(current.version_id)));
    if (text !== null) content = { versionId: current.version_id, versionNumber: current.version_number, text };
  }
  return {
    skill: {
      skillId: row.skill_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: row.status,
      currentVersionId: row.current_private_version_id,
      currentVersionNumber: current?.version_number ?? null,
      currentVersionApprovedAt: current?.approved_at ?? null,
      pendingDraft: latestDraft ? { versionId: latestDraft.version_id, versionNumber: latestDraft.version_number, createdAt: latestDraft.created_at } : null,
      versionCount: versions.length,
      derivedFromReleaseId: row.derived_from_release_id,
      installation,
      availableUpgrade: loadAvailableUpgrade(scope, skillId, installation),
      taskBindingCount: taskUsage.length,
      assetId: versions.length > 0 ? versions[versions.length - 1]!.asset_id : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    versions: versions.map((v) => ({
      versionId: v.version_id,
      versionNumber: v.version_number,
      status: v.status as PortalSkillVersionMeta["status"],
      origin: v.origin,
      approvedBy: v.approved_by,
      approvedAt: v.approved_at,
      supersedesVersionNumber: v.supersedes_version_id ? numberById.get(v.supersedes_version_id) ?? null : null,
      derivedFromVersionNumber: v.derived_from_version_id ? numberById.get(v.derived_from_version_id) ?? null : null,
      createdAt: v.created_at,
    })),
    installations,
    taskUsage,
    relatedMethodIds,
    content,
  };
}

/** Skill 版本正文（比较版本用）。 */
export async function readPortalSkillVersionText(scope: UserScope, versionId: string): Promise<{ versionId: string; versionNumber: number; text: string } | null> {
  assertScopeValid(scope);
  const version = getSkillVersionRow(versionId);
  if (version.domain !== "user") {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "system-domain skill versions are not readable from the user workspace");
  }
  assertRowScope({ user_id: version.user_id, project_id: version.project_id, instance_id: version.instance_id }, scope);
  const text = await readVersionTextSafely(async () => readSkillVersionContentBytes(version));
  return text === null ? null : { versionId: version.version_id, versionNumber: version.version_number, text };
}

/** Skill 版本比较：双侧正文（GUI 并排展示；仅 user 域版本）。 */
export async function comparePortalSkillVersions(
  scope: UserScope,
  fromVersionId: string,
  toVersionId: string,
): Promise<{
  identical: boolean;
  from: { versionId: string; versionNumber: number; text: string } | null;
  to: { versionId: string; versionNumber: number; text: string } | null;
}> {
  const from = await readPortalSkillVersionText(scope, fromVersionId);
  const to = await readPortalSkillVersionText(scope, toVersionId);
  return { identical: from !== null && to !== null && from.text === to.text, from, to };
}

// ---------------------------------------------------------------------------
// 读模型：我的文件关联（asset → workspace 对象反查）
// ---------------------------------------------------------------------------

export interface PortalWorkspaceUsageForAsset {
  methods: Array<{ methodId: string; name: string; currentVersionId: string | null }>;
  skills: Array<{ skillId: string; name: string; slug: string; currentVersionId: string | null }>;
}

/** 文件页关联升级：该资产被哪些方法/Skill 版本引用（只跳转，不提供第二编辑入口）。 */
export function listPortalWorkspaceUsageForAsset(scope: UserScope, assetId: string): PortalWorkspaceUsageForAsset {
  assertScopeValid(scope);
  const methods = (
    sqlite
      .prepare(
        `SELECT DISTINCT m.method_id, m.name, m.current_version_id
         FROM agent_space_methods m
         JOIN agent_space_method_versions v ON v.method_id = m.method_id AND v.asset_id = ?
         WHERE m.user_id=? AND m.project_id=? AND m.instance_id=?`,
      )
      .all(assetId, scope.userId, scope.projectId, scope.instanceId) as Array<{ method_id: string; name: string; current_version_id: string | null }>
  ).map((r) => ({ methodId: r.method_id, name: r.name, currentVersionId: r.current_version_id }));
  const skills = (
    sqlite
      .prepare(
        `SELECT DISTINCT s.skill_id, s.name, s.slug, s.current_private_version_id
         FROM agent_space_skills s
         JOIN agent_space_skill_versions v ON v.skill_id = s.skill_id AND v.asset_id = ?
         WHERE s.domain='user' AND s.user_id=? AND s.project_id=? AND s.instance_id=?`,
      )
      .all(assetId, scope.userId, scope.projectId, scope.instanceId) as Array<{ skill_id: string; name: string; slug: string; current_private_version_id: string | null }>
  ).map((r) => ({ skillId: r.skill_id, name: r.name, slug: r.slug, currentVersionId: r.current_private_version_id }));
  return { methods, skills };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const MAX_TEXT_BYTES = 512 * 1024;

async function readVersionTextSafely(read: () => Promise<Buffer>): Promise<string | null> {
  try {
    const bytes = await read();
    if (bytes.length > MAX_TEXT_BYTES) {
      return `（正文 ${bytes.length} 字节，超过页面预览上限 ${MAX_TEXT_BYTES} 字节；请通过关联文件下载查看）`;
    }
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}
