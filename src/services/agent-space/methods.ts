/**
 * Method 域服务（W1/W2 底座；返工 R3/R5）。
 *
 * 语义：内容底座是 user_asset 版本——服务层校验引用的真实性（存在、同
 * scope、checksum 一致），不信任调用方自报；W0 采用约束结构化落列，批准/
 * 绑定/解析不得绕过；历史读取与运行采用分开。全部写入与审计同事务。
 */
import { sqlite } from "../../db/index.js";
import { readUserAssetVersion } from "../user-assets.js";
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
  /** 2026-10-08 两层裁决：framework=投资框架（整体常驻）；strategy=策略（主策略唯一）。 */
  kind?: "framework" | "strategy";
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
  kind?: "framework" | "strategy";
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
           method_id, user_id, project_id, instance_id, name, description, status, kind, current_version_id, idempotency_key, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, NULL, ?, ?, ?)`,
      )
      .run(methodId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
           input.name, input.description ?? null, input.kind ?? "strategy", input.idempotencyKey ?? null, now, now);
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
  const constraints = parseAdoptionConstraints(version.adoption_constraints);
  const blocksDefault = constraints.filter((c) => BLOCKS_DEFAULT_ADOPTION.includes(c));
  const tx = sqlite.transaction(() => {
    // R9：凭证核验+消耗与业务变更、审计同事务（失败整体回滚，凭证不失耗）。
    // adopt 影响结果（是否采为当前版本），纳入完整操作绑定（验收 R9 第五轮）。
    const approval = verifyAuthorization(
      input.scope,
      {
        operation: "method.version.approve",
        objectType: "agent_space_method_version",
        objectId: input.versionId,
        versionId: input.versionId,
        extraBinding: { methodId: input.methodId, adopt: input.adopt !== false ? "true" : "false" },
      },
      input.approvalRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回首次执行记录的既有结果，
    // 不重新执行状态转换、不新增审计，也不恢复后来停用的对象。
    if (approval.replayed) {
      const stored = approval.replayResult as { methodId: string; versionId: string };
      return { method: getMethodRow(input.scope, stored.methodId), version: getVersionRow(input.scope, stored.versionId) };
    }
    const current = getVersionRow(input.scope, input.versionId);
    if (current.status !== "draft") {
      throw new AgentSpaceError("AGENT_SPACE_IMMUTABLE", `version already ${current.status}`);
    }
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
    recordAuthorizationOutcome(approval.authorizationId, { methodId: input.methodId, versionId: input.versionId });
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

// ---------- W2：方法路径与读模型 ----------

/**
 * 固定版本字节读取（W2）：canonical bytes 始终在 user_assets 版本链上，
 * 本入口只是带 scope 的版本寻址读取——复用 user-assets 的路径安全与
 * checksum 校验（hash 变化/缺文件为明确失败），不做任何 Workspace
 * list/grep 式发现；内容不复制、不缓存。
 */
export async function readMethodVersionContent(
  scope: UserScope,
  versionId: string,
): Promise<{ version: MethodVersionRow; bytes: Buffer }> {
  assertScopeValid(scope);
  const version = getVersionRow(scope, versionId);
  if (version.content_ref_type !== "user_asset_version" || !version.asset_id || !version.asset_version_id) {
    throw new AgentSpaceError("AGENT_SPACE_UNSUPPORTED", "method version has no user-asset content ref");
  }
  const read = await readUserAssetVersion({ ...scope, assetId: version.asset_id, versionId: version.asset_version_id });
  return { version, bytes: read.bytes };
}

/**
 * 显式回退/重采用（W2）：把既有正式版本重新设为 current——版本不可变，
 * 回退只是采用指针的变化；旧 current 转 superseded（仍可固定读取重现）。
 * 授权与 R9 契约同五条路径：核验+消耗+指针变更+审计+结果记录同事务。
 */
export function readoptMethodVersion(input: {
  scope: UserScope;
  methodId: string;
  versionId: string;
  approvalRef: string;
  ownerToken?: string;
  actor: string;
}): { method: MethodRow; version: MethodVersionRow } {
  assertScopeValid(input.scope);
  const method = getMethodRow(input.scope, input.methodId);
  const version = getVersionRow(input.scope, input.versionId);
  if (version.method_id !== input.methodId) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "version does not belong to method");
  }
  const constraints = parseAdoptionConstraints(version.adoption_constraints);
  const blocksDefault = constraints.filter((c) => BLOCKS_DEFAULT_ADOPTION.includes(c));
  const tx = sqlite.transaction(() => {
    const approval = verifyAuthorization(
      input.scope,
      { operation: "method.readopt", objectType: "agent_space_method_version", objectId: input.versionId, versionId: input.versionId, extraBinding: { methodId: input.methodId } },
      input.approvalRef,
      input.ownerToken,
    );
    if (approval.replayed) {
      const stored = approval.replayResult as { methodId: string; versionId: string };
      return { method: getMethodRow(input.scope, stored.methodId), version: getVersionRow(input.scope, stored.versionId) };
    }
    const freshMethod = getMethodRow(input.scope, input.methodId);
    const current = getVersionRow(input.scope, input.versionId);
    if (freshMethod.status !== "active") {
      throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot readopt on ${freshMethod.status} method`);
    }
    if (current.status !== "approved" && current.status !== "superseded") {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", `version ${input.versionId} is ${current.status}; only formal versions can be readopted`);
    }
    if (freshMethod.current_version_id === input.versionId) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "version is already the adopted current version");
    }
    // 返工 W2-R1：history-only 版本永远不能成为 current——readopt 的语义就是
    // 成为 current，因此 owner 通道也不能通过回退绕过运行阻断约束（与
    // approve/resolve 路径统一）。拒绝随事务回滚：current/版本状态/凭证/审计
    // 均不变。历史读取仍走 getMethodVersion/readMethodVersionContent。
    const blocksRun = constraints.filter((c) => BLOCKS_RUN_BINDING.includes(c));
    if (blocksRun.length > 0) {
      throw new AgentSpaceError(
        "AGENT_SPACE_ADOPTION_CONSTRAINT",
        `version carries ${blocksRun.join(",")}; history-only versions can never become the current version, readopt included`,
      );
    }
    if (blocksDefault.length > 0 && approval.kind !== "owner-decision") {
      throw new AgentSpaceError(
        "AGENT_SPACE_ADOPTION_CONSTRAINT",
        `version carries ${blocksDefault.join(",")}; readoption requires an owner decision, not a conversation approval`,
      );
    }
    const now = nowIso();
    if (freshMethod.current_version_id) {
      sqlite
        .prepare("UPDATE agent_space_method_versions SET status='superseded' WHERE version_id=? AND status='approved'")
        .run(freshMethod.current_version_id);
    }
    sqlite
      .prepare("UPDATE agent_space_method_versions SET status='approved' WHERE version_id=?")
      .run(input.versionId);
    sqlite
      .prepare("UPDATE agent_space_methods SET current_version_id=?, updated_at=? WHERE method_id=?")
      .run(input.versionId, now, input.methodId);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "method.version.readopted",
      objectType: "agent_space_method_version",
      objectId: input.versionId,
      fromStatus: "superseded",
      toStatus: "approved",
      detail: {
        methodId: input.methodId,
        previousCurrentVersionId: freshMethod.current_version_id,
        approvalRef: input.approvalRef,
        approvalKind: approval.kind,
        adoptionConstraints: constraints,
      },
    });
    recordAuthorizationOutcome(approval.authorizationId, { methodId: input.methodId, versionId: input.versionId });
    return { method: getMethodRow(input.scope, input.methodId), version: getVersionRow(input.scope, input.versionId) };
  });
  return tx();
}

export interface MethodSummary {
  methodId: string;
  name: string;
  status: MethodStatus;
  currentVersionId: string | null;
  currentVersionConstraints: AdoptionConstraint[];
  updatedAt: string;
}

/**
 * 默认发现读模型（W2）：只呈现方法与其 current 版本；历史版本不在默认
 * 发现面（须显式 versionId 或 getMethodVersionHistory）。
 */
export function listUserMethods(scope: UserScope): MethodSummary[] {
  assertScopeValid(scope);
  const rows = sqlite
    .prepare(
      `SELECT m.method_id, m.name, m.status, m.current_version_id, m.updated_at, v.adoption_constraints
       FROM agent_space_methods m
       LEFT JOIN agent_space_method_versions v ON v.version_id = m.current_version_id
       WHERE m.user_id=? AND m.project_id=? AND m.instance_id=?
       ORDER BY m.updated_at DESC`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId) as Array<{
      method_id: string; name: string; status: MethodStatus; current_version_id: string | null;
      updated_at: string; adoption_constraints: string | null;
    }>;
  return rows.map((r) => ({
    methodId: r.method_id,
    name: r.name,
    status: r.status,
    currentVersionId: r.current_version_id,
    currentVersionConstraints: r.current_version_id ? parseAdoptionConstraints(r.adoption_constraints) : [],
    updatedAt: r.updated_at,
  }));
}

export interface MethodVersionHistoryEntry {
  versionId: string;
  versionNumber: number;
  status: MethodVersionStatus;
  contentChecksum: string;
  assetVersionId: string | null;
  adoptionConstraints: AdoptionConstraint[];
  supersedesVersionId: string | null;
  approvedAt: string | null;
  createdAt: string;
}

/**
 * 显式版本历史（W2）：只含正式版本（approved/superseded）的采用链——
 * 草稿不进入正式历史；被 run/task/commitment 引用的版本始终在此可寻址。
 */
export function getMethodVersionHistory(scope: UserScope, methodId: string): MethodVersionHistoryEntry[] {
  assertScopeValid(scope);
  getMethodRow(scope, methodId);
  const rows = sqlite
    .prepare(
      `SELECT version_id, version_number, status, content_checksum, asset_version_id,
              adoption_constraints, supersedes_version_id, approved_at, created_at
       FROM agent_space_method_versions
       WHERE method_id=? AND user_id=? AND project_id=? AND instance_id=? AND status IN ('approved','superseded')
       ORDER BY version_number DESC`,
    )
    .all(methodId, scope.userId, scope.projectId, scope.instanceId) as Array<{
      version_id: string; version_number: number; status: MethodVersionStatus; content_checksum: string;
      asset_version_id: string | null; adoption_constraints: string | null; supersedes_version_id: string | null;
      approved_at: string | null; created_at: string;
    }>;
  return rows.map((r) => ({
    versionId: r.version_id,
    versionNumber: r.version_number,
    status: r.status,
    contentChecksum: r.content_checksum,
    assetVersionId: r.asset_version_id,
    adoptionConstraints: parseAdoptionConstraints(r.adoption_constraints),
    supersedesVersionId: r.supersedes_version_id,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  }));
}

/**
 * 版本间元数据 diff（W2）：只比对 canonical 引用与 checksum，不复制/内嵌
 * 正文；逐版本字节读取不受任何去重/差异压缩影响（本域不做字节去重）。
 */
export function diffMethodVersions(
  scope: UserScope,
  fromVersionId: string,
  toVersionId: string,
): { fromChecksum: string; toChecksum: string; identical: boolean; fromAssetVersionId: string | null; toAssetVersionId: string | null } {
  assertScopeValid(scope);
  const from = getVersionRow(scope, fromVersionId);
  const to = getVersionRow(scope, toVersionId);
  if (from.method_id !== to.method_id) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "cannot diff versions of different methods");
  }
  return {
    fromChecksum: from.content_checksum,
    toChecksum: to.content_checksum,
    identical: from.content_checksum === to.content_checksum,
    fromAssetVersionId: from.asset_version_id,
    toAssetVersionId: to.asset_version_id,
  };
}

export { BLOCKS_RUN_BINDING, BLOCKS_DEFAULT_ADOPTION, ADOPTION_CONSTRAINTS };
