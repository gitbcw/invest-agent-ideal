/**
 * Method 域服务（W1/W2 底座）。
 *
 * 语义（v3 §2/§3）：用户可保留多个方法体系与完整正式版本链；只有已批准、
 * 生效的修改产生正式版本；草稿不膨胀为正式历史；默认运行只加载当前采用
 * 版本。内容底座是 user_asset 版本——本域只保存引用（assetId/versionId/
 * checksum），不复制正文；读取正文仍走 user-assets 服务按 scope 鉴权。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertRowScope,
  assertScopeValid,
  findByIdempotencyKey,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  type UserScope,
} from "./core.js";

export type MethodStatus = "draft" | "active" | "retired";
export type MethodVersionStatus = "draft" | "approved" | "superseded" | "retired";

export interface CreateMethodInput {
  scope: UserScope;
  name: string;
  description?: string;
  idempotencyKey?: string;
  actor: string;
}

export interface AddMethodVersionInput {
  scope: UserScope;
  methodId: string;
  contentRef: { assetId: string; assetVersionId: string; contentChecksum: string };
  origin?: "user" | "migration";
  /** W0 阻塞语义载体：hold/historical-not-default 等，批准与采用时强制展示。 */
  adoptionNote?: string;
  idempotencyKey?: string;
  actor: string;
}

export interface ApproveMethodVersionInput {
  scope: UserScope;
  methodId: string;
  versionId: string;
  approvedBy: string;
  /** 可核对的授权依据（用户消息/操作引用）；模型自述不算。 */
  approvalRef: string;
  /** 是否同时采用为当前版本（默认 true；false 允许批准但暂不切默认加载）。 */
  adopt?: boolean;
  actor: string;
}

type MethodRow = {
  method_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  name: string;
  description: string | null;
  status: MethodStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type MethodVersionRow = {
  version_id: string;
  method_id: string;
  user_id: string;
  project_id: string;
  instance_id: string;
  version_number: number;
  content_ref_type: string;
  asset_id: string | null;
  asset_version_id: string | null;
  content_checksum: string;
  status: MethodVersionStatus;
  origin: string;
  adoption_note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_ref: string | null;
  supersedes_version_id: string | null;
  created_at: string;
};

function getMethodRow(scope: UserScope, methodId: string): MethodRow {
  const row = sqlite.prepare("SELECT * FROM agent_space_methods WHERE method_id=?").get(methodId) as MethodRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `method ${methodId}`);
  assertRowScope(row, scope);
  return row;
}

function getVersionRow(scope: UserScope, versionId: string): MethodVersionRow {
  const row = sqlite.prepare("SELECT * FROM agent_space_method_versions WHERE version_id=?").get(versionId) as MethodVersionRow | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `method version ${versionId}`);
  assertRowScope(row, scope);
  return row;
}

export function createMethod(input: CreateMethodInput): MethodRow {
  assertScopeValid(input.scope);
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_methods", input.scope, input.idempotencyKey);
    if (existing) return existing as unknown as MethodRow;
  }
  const now = nowIso();
  const row: MethodRow = {
    method_id: newId("method"),
    user_id: input.scope.userId,
    project_id: input.scope.projectId,
    instance_id: input.scope.instanceId,
    name: input.name,
    description: input.description ?? null,
    status: "draft",
    current_version_id: null,
    created_at: now,
    updated_at: now,
  };
  sqlite
    .prepare(
      `INSERT INTO agent_space_methods (
         method_id, user_id, project_id, instance_id, name, description, status, current_version_id, idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?)`,
    )
    .run(row.method_id, row.user_id, row.project_id, row.instance_id, row.name, row.description, input.idempotencyKey ?? null, now, now);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "method.created",
    objectType: "agent_space_method",
    objectId: row.method_id,
    toStatus: "draft",
  });
  return row;
}

export function addMethodVersion(input: AddMethodVersionInput): MethodVersionRow {
  assertScopeValid(input.scope);
  const method = getMethodRow(input.scope, input.methodId);
  if (method.status === "retired") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "retired method cannot receive versions");
  }
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_method_versions", input.scope, input.idempotencyKey) as unknown as MethodVersionRow | undefined;
    if (existing) return existing;
  }
  const tx = sqlite.transaction(() => {
    const maxRow = sqlite
      .prepare("SELECT MAX(version_number) AS n FROM agent_space_method_versions WHERE method_id=?")
      .get(input.methodId) as { n: number | null };
    const nextNumber = (maxRow.n ?? 0) + 1;
    const current = method.current_version_id
      ? getVersionRow(input.scope, method.current_version_id)
      : null;
    const versionId = newId("mver");
    sqlite
      .prepare(
        `INSERT INTO agent_space_method_versions (
           version_id, method_id, user_id, project_id, instance_id, version_number,
           content_ref_type, asset_id, asset_version_id, content_checksum,
           status, origin, adoption_note, supersedes_version_id, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'user_asset_version', ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        input.methodId,
        input.scope.userId,
        input.scope.projectId,
        input.scope.instanceId,
        nextNumber,
        input.contentRef.assetId,
        input.contentRef.assetVersionId,
        input.contentRef.contentChecksum,
        input.origin ?? "user",
        input.adoptionNote ?? null,
        current?.version_id ?? null,
        input.idempotencyKey ?? null,
        nowIso(),
      );
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "method.version.drafted",
      objectType: "agent_space_method_version",
      objectId: versionId,
      toStatus: "draft",
      detail: { methodId: input.methodId, versionNumber: nextNumber, adoptionNote: input.adoptionNote ?? null },
    });
    return getVersionRow(input.scope, versionId);
  });
  return tx();
}

export function approveMethodVersion(input: ApproveMethodVersionInput): { method: MethodRow; version: MethodVersionRow } {
  assertScopeValid(input.scope);
  const method = getMethodRow(input.scope, input.methodId);
  const version = getVersionRow(input.scope, input.versionId);
  if (version.method_id !== input.methodId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to method");
  }
  if (version.status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_IMMUTABLE", `version already ${version.status}`);
  }
  if (!input.approvalRef?.trim()) {
    throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "approvalRef is required and must be verifiable");
  }
  const adopt = input.adopt !== false;
  const tx = sqlite.transaction(() => {
    const now = nowIso();
    sqlite
      .prepare(
        `UPDATE agent_space_method_versions
         SET status='approved', approved_by=?, approved_at=?, approval_ref=? WHERE version_id=? AND status='draft'`,
      )
      .run(input.approvedBy, now, input.approvalRef, input.versionId);
    if (adopt) {
      if (method.current_version_id && method.current_version_id !== input.versionId) {
        sqlite
          .prepare("UPDATE agent_space_method_versions SET status='superseded' WHERE version_id=? AND status='approved'")
          .run(method.current_version_id);
      }
      sqlite
        .prepare("UPDATE agent_space_methods SET status='active', current_version_id=?, updated_at=? WHERE method_id=?")
        .run(input.versionId, now, input.methodId);
    }
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "method.version.approved",
      objectType: "agent_space_method_version",
      objectId: input.versionId,
      fromStatus: "draft",
      toStatus: "approved",
      detail: { methodId: input.methodId, adoptedAsCurrent: adopt, approvalRef: input.approvalRef, approvedBy: input.approvedBy },
    });
    return {
      method: getMethodRow(input.scope, input.methodId),
      version: getVersionRow(input.scope, input.versionId),
    };
  });
  return tx();
}

/** 已批准版本不可变：唯一合法的后续变更是被新版本顶替（superseded）。 */
export function assertMethodVersionImmutable(version: MethodVersionRow): void {
  if (version.status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_IMMUTABLE", `method version is ${version.status}; only draft input may change`);
  }
}

export function retireMethod(scope: UserScope, methodId: string, actor: string): MethodRow {
  assertScopeValid(scope);
  const method = getMethodRow(scope, methodId);
  if (method.status !== "active" && method.status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot retire method in status ${method.status}`);
  }
  sqlite.prepare("UPDATE agent_space_methods SET status='retired', updated_at=? WHERE method_id=?").run(nowIso(), methodId);
  if (method.current_version_id) {
    sqlite
      .prepare("UPDATE agent_space_method_versions SET status='retired' WHERE version_id=? AND status='approved'")
      .run(method.current_version_id);
  }
  recordAgentSpaceAudit({
    scope,
    actor,
    action: "method.retired",
    objectType: "agent_space_method",
    objectId: methodId,
    fromStatus: method.status,
    toStatus: "retired",
  });
  return getMethodRow(scope, methodId);
}

/**
 * 解析运行应加载的版本：默认只返回当前采用版本；任务可用 pinnedVersionId
 * 固定历史正式版本（受保护版本必须可完整重现）。draft 永远不会被解析。
 */
export function resolveMethodVersion(
  scope: UserScope,
  methodId: string,
  pinnedVersionId?: string,
): { method: MethodRow; version: MethodVersionRow } {
  assertScopeValid(scope);
  const method = getMethodRow(scope, methodId);
  const targetId = pinnedVersionId ?? method.current_version_id;
  if (!targetId) throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "method has no adopted version");
  const version = getVersionRow(scope, targetId);
  if (version.status !== "approved" && version.status !== "superseded") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `version ${targetId} is ${version.status}; only formal versions resolve`);
  }
  return { method, version };
}

export function getMethod(scope: UserScope, methodId: string): MethodRow {
  assertScopeValid(scope);
  return getMethodRow(scope, methodId);
}

export function getMethodVersion(scope: UserScope, versionId: string): MethodVersionRow {
  assertScopeValid(scope);
  return getVersionRow(scope, versionId);
}
