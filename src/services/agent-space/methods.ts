/**
 * Method 域服务（W1/W2 底座；返工 R3/R5）。
 *
 * 语义：内容底座是 user_asset 版本——服务层校验引用的真实性（存在、同
 * scope、checksum 一致），不信任调用方自报；W0 采用约束结构化落列，批准/
 * 绑定/解析不得绕过；历史读取与运行采用分开。全部写入与审计同事务。
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
  verifyAuthorization,
  type UserScope,
} from "./core.js";

export type MethodStatus = "draft" | "active" | "retired";
export type MethodVersionStatus = "draft" | "approved" | "superseded" | "retired";

/** W0 处置语义的结构化采用约束（验收 R3：不是自由文本）。 */
export type AdoptionConstraint =
  | "hold-ambiguity" // 未决条款：不得自动作为运行 Method 采用（owner 决策可解）
  | "historical-not-default" // 历史定位：不得默认采用，也不得作为运行绑定
  | "split-in-progress" // 拆分未验证：不得作为完整新 Method 采用
  | "task-specific-reference" // 任务特定参考：不推广采用
  | "restore-candidate" // 恢复可发现性候选：未接入运行
  | "revision-evidence"; // 修订证据：不是目标正文

const ADOPTION_CONSTRAINTS: readonly AdoptionConstraint[] = [
  "hold-ambiguity", "historical-not-default", "split-in-progress",
  "task-specific-reference", "restore-candidate", "revision-evidence",
];
/** 不允许成为默认采用版本的约束。 */
const BLOCKS_DEFAULT_ADOPTION: readonly AdoptionConstraint[] = ["hold-ambiguity", "historical-not-default", "split-in-progress"];
/** 不允许任何运行绑定（pin/current 解析）的约束。 */
const BLOCKS_RUN_BINDING: readonly AdoptionConstraint[] = ["historical-not-default"];

export interface CreateMethodInput {
  scope: UserScope;
  name: string;
  description?: string;
  idempotencyKey?: string;
  actor: string;
}

export interface ContentRefInput {
  assetId: string;
  assetVersionId: string;
  /** 必须等于 user_asset_versions.checksum；服务层核对，不信任自报。 */
  contentChecksum: string;
}

export interface AddMethodVersionInput {
  scope: UserScope;
  methodId: string;
  contentRef: ContentRefInput;
  origin?: "user" | "migration";
  adoptionNote?: string;
  adoptionConstraints?: AdoptionConstraint[];
  idempotencyKey?: string;
  actor: string;
}

export interface ApproveMethodVersionInput {
  scope: UserScope;
  methodId: string;
  versionId: string;
  approvedBy: string;
  /** conversation:<messageId>（同 scope 存在）或 owner-decision:<ref>（附 token）。 */
  approvalRef: string;
  ownerToken?: string;
  /** 是否同时采用为当前版本；带约束版本强制 false。 */
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
  adoption_constraints: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_ref: string | null;
  supersedes_version_id: string | null;
  created_at: string;
};

export function parseAdoptionConstraints(raw: string | null): AdoptionConstraint[] {
  if (!raw) return [];
  return JSON.parse(raw) as AdoptionConstraint[];
}

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

/** 内容引用真实性校验（验收 R3）：资产版本必须存在、同 scope、checksum 一致。 */
function verifyContentRef(scope: UserScope, ref: ContentRefInput): { assetId: string; assetVersionId: string; checksum: string } {
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
  return { assetId: ref.assetId, assetVersionId: ref.assetVersionId, checksum: row.checksum };
}

export function createMethod(input: CreateMethodInput): MethodRow {
  assertScopeValid(input.scope);
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_methods", input.scope, input.idempotencyKey);
    assertIdempotencyConsistent(
      existing,
      (row) => String(row.name),
      input.name,
      "createMethod",
    );
    if (existing) return existing as unknown as MethodRow;
  }
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    const methodId = newId("method");
    sqlite
      .prepare(
        `INSERT INTO agent_space_methods (
           method_id, user_id, project_id, instance_id, name, description, status, current_version_id, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?)`,
      )
      .run(methodId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.name, input.description ?? null, input.idempotencyKey ?? null, now, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "method.created",
      objectType: "agent_space_method",
      objectId: methodId,
      toStatus: "draft",
    });
    return methodId;
  });
  const methodId = tx();
  return getMethodRow(input.scope, methodId);
}

export function addMethodVersion(input: AddMethodVersionInput): MethodVersionRow {
  assertScopeValid(input.scope);
  const method = getMethodRow(input.scope, input.methodId);
  if (method.status === "retired") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "retired method cannot receive versions");
  }
  for (const constraint of input.adoptionConstraints ?? []) {
    if (!ADOPTION_CONSTRAINTS.includes(constraint)) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `unknown adoption constraint ${constraint}`);
    }
  }
  const verified = verifyContentRef(input.scope, input.contentRef);
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_method_versions", input.scope, input.idempotencyKey) as unknown as MethodVersionRow | undefined;
    assertIdempotencyConsistent(
      existing,
      (row) => JSON.stringify([row.method_id, row.asset_version_id, row.content_checksum, row.adoption_constraints]),
      JSON.stringify([input.methodId, verified.assetVersionId, verified.checksum, JSON.stringify(input.adoptionConstraints ?? [])]),
      "addMethodVersion",
    );
    if (existing) return existing;
  }
  const tx = sqlite.transaction(() => {
    const maxRow = sqlite
      .prepare("SELECT MAX(version_number) AS n FROM agent_space_method_versions WHERE method_id=?")
      .get(input.methodId) as { n: number | null };
    const nextNumber = (maxRow.n ?? 0) + 1;
    const current = method.current_version_id ? getVersionRow(input.scope, method.current_version_id) : null;
    const versionId = newId("mver");
    sqlite
      .prepare(
        `INSERT INTO agent_space_method_versions (
           version_id, method_id, user_id, project_id, instance_id, version_number,
           content_ref_type, asset_id, asset_version_id, content_checksum,
           status, origin, adoption_note, adoption_constraints, supersedes_version_id, idempotency_key, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'user_asset_version', ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId, input.methodId, input.scope.userId, input.scope.projectId, input.scope.instanceId, nextNumber,
        verified.assetId, verified.assetVersionId, verified.checksum,
        input.origin ?? "user", input.adoptionNote ?? null,
        JSON.stringify(input.adoptionConstraints ?? []), current?.version_id ?? null,
        input.idempotencyKey ?? null, nowIso(),
      );
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "method.version.drafted",
      objectType: "agent_space_method_version",
      objectId: versionId,
      toStatus: "draft",
      detail: { methodId: input.methodId, versionNumber: nextNumber, adoptionConstraints: input.adoptionConstraints ?? [] },
    });
    return versionId;
  });
  return getVersionRow(input.scope, tx());
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
  const constraints = parseAdoptionConstraints(version.adoption_constraints);
  const blocksDefault = constraints.filter((c) => BLOCKS_DEFAULT_ADOPTION.includes(c));
  const tx = sqlite.transaction(() => {
    // R9：凭证核验+消耗与业务变更、审计同事务（失败整体回滚，凭证不失耗）。
    const approval = verifyAuthorization(
      input.scope,
      { operation: "method.version.approve", objectType: "agent_space_method_version", objectId: input.versionId, versionId: input.versionId, extraBinding: { methodId: input.methodId } },
      input.approvalRef,
      input.ownerToken,
    );
    let adopt = input.adopt !== false;
    if (blocksDefault.length > 0 && adopt) {
      if (approval.kind !== "owner-decision") {
        throw new AgentSpaceError(
          "AGENT_SPACE_ADOPTION_CONSTRAINT",
          `version carries ${blocksDefault.join(",")}; default adoption requires an owner decision, not a conversation approval`,
        );
      }
      if (constraints.some((c) => BLOCKS_RUN_BINDING.includes(c))) {
        // historical-not-default：连 owner 也不能把它变成默认运行版本，只能批准为历史正式版本。
        adopt = false;
      }
    }
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
      detail: {
        methodId: input.methodId,
        adoptedAsCurrent: adopt,
        approvalRef: input.approvalRef,
        approvalKind: approval.kind,
        approvedBy: input.approvedBy,
        adoptionConstraints: constraints,
      },
    });
    return {
      method: getMethodRow(input.scope, input.methodId),
      version: getVersionRow(input.scope, input.versionId),
    };
  });
  return tx();
}

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
  const tx = sqlite.transaction(() => {
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
  });
  return tx();
}

/**
 * 解析运行版本：默认只解析当前采用版本；pin 可固定正式历史版本
 * （superseded 可完整重现）。版本必须属于指定 Method；带运行阻断约束的
 * 版本不得解析（历史读取走 getMethodVersion）。
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
  if (version.method_id !== methodId) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "version does not belong to the requested method");
  }
  if (version.status !== "approved" && version.status !== "superseded") {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `version ${targetId} is ${version.status}; only formal versions resolve`);
  }
  const blocked = parseAdoptionConstraints(version.adoption_constraints).filter((c) => BLOCKS_RUN_BINDING.includes(c));
  if (blocked.length > 0) {
    throw new AgentSpaceError("AGENT_SPACE_ADOPTION_CONSTRAINT", `version carries ${blocked.join(",")}; it is history-only for runtime`);
  }
  // pin 未被 owner 采纳为 current 的约束版本 = 绕过默认采用路径（验收 R8）
  if (pinnedVersionId && pinnedVersionId !== method.current_version_id) {
    const bypass = parseAdoptionConstraints(version.adoption_constraints).filter((c) => BLOCKS_DEFAULT_ADOPTION.includes(c));
    if (bypass.length > 0) {
      throw new AgentSpaceError(
        "AGENT_SPACE_ADOPTION_CONSTRAINT",
        `pinned version carries ${bypass.join(",")} and is not the owner-adopted current version; pinning would bypass the default adoption path`,
      );
    }
  }
  return { method, version };
}

export function getMethod(scope: UserScope, methodId: string): MethodRow {
  assertScopeValid(scope);
  return getMethodRow(scope, methodId);
}

/** 历史读取入口：不过运行约束，但必须同 scope。 */
export function getMethodVersion(scope: UserScope, versionId: string): MethodVersionRow {
  assertScopeValid(scope);
  return getVersionRow(scope, versionId);
}

export { BLOCKS_RUN_BINDING, BLOCKS_DEFAULT_ADOPTION, ADOPTION_CONSTRAINTS };
