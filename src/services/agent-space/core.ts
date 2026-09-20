/**
 * Agent Space 域核心（W1）：scope 校验、错误契约、审计与 ID 原语。
 *
 * 设计依据 docs/agent-space-workspace-exit-design-v3.md §3 与
 * docs/agent-space-execution/W1-domain-contracts.md：
 * - 每个用户对象都有 user/project/instance scope，服务层在每次读写上强制；
 * - 生命周期转换、审批、授权、幂等和审计由服务层校验；
 * - 安全保证不依赖对象文本——本模块只处理引用与状态，不承载内容正文。
 */
import { randomUUID, createHash } from "node:crypto";

import { sqlite } from "../../db/index.js";

export interface UserScope {
  userId: string;
  projectId: string;
  instanceId: string;
}

export type AgentSpaceScopeDomain = "user" | "system";

const SCOPE_KEYS = ["userId", "projectId", "instanceId"] as const;

export class AgentSpaceError extends Error {
  constructor(
    public readonly code:
      | "AGENT_SPACE_SCOPE_MISMATCH"
      | "AGENT_SPACE_NOT_FOUND"
      | "AGENT_SPACE_INVALID_TRANSITION"
      | "AGENT_SPACE_APPROVAL_REQUIRED"
      | "AGENT_SPACE_IMMUTABLE"
      | "AGENT_SPACE_VERSION_INVALID"
      | "AGENT_SPACE_SYSTEM_DOMAIN_REQUIRED"
      | "AGENT_SPACE_VISIBILITY_INVALID"
      | "AGENT_SPACE_ARGUMENT_INVALID"
      | "AGENT_SPACE_IDEMPOTENCY_CONFLICT"
      | "AGENT_SPACE_OWNER_AUTH_REQUIRED"
      | "AGENT_SPACE_ADOPTION_CONSTRAINT"
      | "AGENT_SPACE_UNSUPPORTED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AgentSpaceError";
  }
}

export function assertScopeValid(scope: UserScope): void {
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (!value || typeof value !== "string" || value.trim() === "") {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${key} is required`);
    }
  }
}

/** 行的 scope 三元组必须与调用 scope 完全一致；不一致一律拒绝（不返回对象）。 */
export function assertRowScope(row: { user_id: string | null; project_id: string | null; instance_id: string | null }, scope: UserScope): void {
  if (row.user_id !== scope.userId || row.project_id !== scope.projectId || row.instance_id !== scope.instanceId) {
    throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", "object belongs to another scope");
  }
}

/** 用户域行必须有完整 scope；系统域行必须三列全空（物理分域）。 */
export function assertDomainRowShape(domain: AgentSpaceScopeDomain, scope: UserScope | null): void {
  if (domain === "user") {
    if (!scope) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user domain requires scope");
    assertScopeValid(scope);
  } else if (scope) {
    throw new AgentSpaceError("AGENT_SPACE_SYSTEM_DOMAIN_REQUIRED", "system domain must not carry a user scope");
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function sha256Of(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface AuditInput {
  domain?: AgentSpaceScopeDomain;
  scope?: UserScope | null;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: Record<string, unknown>;
}

/** 统一生命周期审计；失败抛错（审计是契约的一部分，不静默吞掉）。 */
export function recordAgentSpaceAudit(input: AuditInput): void {
  sqlite
    .prepare(
      `INSERT INTO agent_space_audit_logs (
         audit_id, domain, user_id, project_id, instance_id,
         actor, action, object_type, object_id, from_status, to_status, detail_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("asaudit"),
      input.domain ?? "user",
      input.scope?.userId ?? null,
      input.scope?.projectId ?? null,
      input.scope?.instanceId ?? null,
      input.actor,
      input.action,
      input.objectType,
      input.objectId,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      nowIso(),
    );
}

/** 幂等创建辅助：按 (scope, idempotency_key) 查既有行，命中直接返回。 */
export function findByIdempotencyKey(
  table: string,
  scope: UserScope,
  idempotencyKey: string,
): Record<string, unknown> | undefined {
  const row = sqlite
    .prepare(`SELECT * FROM ${table} WHERE user_id=? AND project_id=? AND instance_id=? AND idempotency_key=?`)
    .get(scope.userId, scope.projectId, scope.instanceId, idempotencyKey);
  return row as Record<string, unknown> | undefined;
}

/**
 * 幂等冲突守卫（验收 R5）：同 key 重放必须与首次内容一致；
 * 内容不同属于冲突，必须拒绝而不是静默返回旧行。
 */
export function assertIdempotencyConsistent(
  existing: Record<string, unknown> | undefined,
  contentFingerprint: (row: Record<string, unknown>) => string,
  expectedFingerprint: string,
  what: string,
): void {
  if (!existing) return;
  const actual = contentFingerprint(existing);
  if (actual !== expectedFingerprint) {
    throw new AgentSpaceError(
      "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
      `${what}: idempotency key replay with different content (${actual} != ${expectedFingerprint})`,
    );
  }
}

/**
 * 可信授权登记（验收 R6）：消息存在 ≠ 用户批准。批准凭证必须绑定主体、
 * scope、操作、对象、版本；会话消息只是来源证据——登记时核验该消息是
 * role=user 且 status=sent 的同 scope 真实消息（assistant/system/failed/
 * superseded 一律拒绝）。明确指令场景由可信入口（运行时确认层）在同一
 * 操作内调用本函数登记，不新增二次确认。
 */
export interface RegisterAuthorizationInput {
  scope: UserScope;
  /** 实际作出批准的用户。 */
  subjectUser: string;
  operation: string;
  objectType: string;
  objectId: string;
  versionId?: string | null;
  extraBinding?: Record<string, string>;
  /** 来源消息 id（须同 scope、role=user、status=sent）。 */
  sourceMessageId: string;
  actor: string;
}

export function registerUserAuthorization(input: RegisterAuthorizationInput): { authorizationId: string; duplicated: boolean } {
  assertScopeValid(input.scope);
  const message = sqlite
    .prepare("SELECT message_id, role, status, user_id, project_id, instance_id FROM conversation_messages WHERE message_id=?")
    .get(input.sourceMessageId) as
    | { message_id: string; role: string; status: string; user_id: string; project_id: string; instance_id: string }
    | undefined;
  if (!message) throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", `source message ${input.sourceMessageId} not found`);
  assertRowScope(message, input.scope);
  if (message.role !== "user" || message.status !== "sent") {
    throw new AgentSpaceError(
      "AGENT_SPACE_APPROVAL_REQUIRED",
      `source message must be a delivered user message (got role=${message.role}, status=${message.status})`,
    );
  }
  const naturalKey = sqlite
    .prepare(
      `SELECT authorization_id FROM agent_space_authorizations
       WHERE user_id=? AND project_id=? AND instance_id=? AND operation=? AND object_type=? AND object_id=?
         AND COALESCE(version_id,'')=? AND source_ref=? AND COALESCE(extra_binding_json,'')=?`,
    )
    .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.operation, input.objectType,
         input.objectId, input.versionId ?? "", `conversation:${input.sourceMessageId}`,
         input.extraBinding ? JSON.stringify(input.extraBinding) : "") as { authorization_id: string } | undefined;
  if (naturalKey) return { authorizationId: naturalKey.authorization_id, duplicated: true };
  const authorizationId = newId("authz");
  sqlite
    .prepare(
      `INSERT INTO agent_space_authorizations (
         authorization_id, user_id, project_id, instance_id, subject_user,
         operation, object_type, object_id, version_id, extra_binding_json,
         source_kind, source_ref, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'conversation', ?, 'active', ?)`,
    )
    .run(authorizationId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.subjectUser,
         input.operation, input.objectType, input.objectId, input.versionId ?? null,
         input.extraBinding ? JSON.stringify(input.extraBinding) : null,
         `conversation:${input.sourceMessageId}`, nowIso());
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "authorization.registered",
    objectType: "agent_space_authorization",
    objectId: authorizationId,
    toStatus: "active",
    detail: { operation: input.operation, boundObjectType: input.objectType, boundObjectId: input.objectId, versionId: input.versionId ?? null, sourceMessageId: input.sourceMessageId, subjectUser: input.subjectUser },
  });
  return { authorizationId, duplicated: false };
}

export interface AuthorizationBinding {
  operation: string;
  objectType: string;
  objectId: string;
  versionId?: string | null;
  extraBinding?: Record<string, string>;
}

/**
 * 批准凭证核验（验收 R6）：只接受
 * - `authorization:<id>`：绑定必须与本次操作的对象/版本/附加字段完全一致；
 *   同一授权对同一目标的合法重放幂等放行，跨对象/动作/版本重放拒绝；
 * - `owner-decision:<ref>`：须 owner 令牌；目标绑定记入审计。
 * 旧的 `conversation:<messageId>` 形态不再作为凭证（消息只是登记授权时的
 * 来源证据）。
 */
export function verifyAuthorization(
  scope: UserScope,
  binding: AuthorizationBinding,
  approvalRef: string,
  ownerToken?: string,
): { kind: "authorization" | "owner-decision"; ref: string; authorizationId?: string } {
  const trimmed = approvalRef?.trim();
  if (!trimmed) throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "approvalRef is required");
  const authzMatch = /^authorization:([A-Za-z0-9_-]+)$/.exec(trimmed);
  if (authzMatch) {
    const row = sqlite
      .prepare("SELECT * FROM agent_space_authorizations WHERE authorization_id=?")
      .get(authzMatch[1]!) as
      | {
          authorization_id: string; user_id: string; project_id: string; instance_id: string; subject_user: string;
          operation: string; object_type: string; object_id: string; version_id: string | null;
          extra_binding_json: string | null; status: string; consumed_at: string | null;
        }
      | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", `authorization ${authzMatch[1]} not found`);
    assertRowScope(row, scope);
    const mismatches: string[] = [];
    if (row.operation !== binding.operation) mismatches.push(`operation ${row.operation}!=${binding.operation}`);
    if (row.object_type !== binding.objectType) mismatches.push("objectType");
    if (row.object_id !== binding.objectId) mismatches.push("objectId");
    if ((row.version_id ?? null) !== (binding.versionId ?? null)) mismatches.push("versionId");
    const extra = row.extra_binding_json ? (JSON.parse(row.extra_binding_json) as Record<string, string>) : {};
    for (const [key, value] of Object.entries(binding.extraBinding ?? {})) {
      if (extra[key] !== value) mismatches.push(`extraBinding.${key}`);
    }
    if (mismatches.length > 0) {
      throw new AgentSpaceError(
        "AGENT_SPACE_APPROVAL_REQUIRED",
        `authorization ${row.authorization_id} is bound to a different target (${mismatches.join(", ")}); replay across object/action/version is rejected`,
      );
    }
    if (row.status !== "active") {
      throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", `authorization is ${row.status}`);
    }
    if (!row.consumed_at) {
      sqlite.prepare("UPDATE agent_space_authorizations SET consumed_at=?, status='consumed' WHERE authorization_id=? AND consumed_at IS NULL")
        .run(nowIso(), row.authorization_id);
    }
    // 已 consumed 的同绑定重放幂等放行（同一合法操作的重试）。
    return { kind: "authorization", ref: row.authorization_id, authorizationId: row.authorization_id };
  }
  const ownerMatch = /^owner-decision:(.+)$/.exec(trimmed);
  if (ownerMatch) {
    requireOwnerAuthorization(ownerToken, `owner-decision ${ownerMatch[1]}`);
    return { kind: "owner-decision", ref: ownerMatch[1]! };
  }
  throw new AgentSpaceError(
    "AGENT_SPACE_APPROVAL_REQUIRED",
    "approvalRef must be authorization:<id> (bound to this exact operation/object/version) or owner-decision:<ref> (with owner token)",
  );
}

const OWNER_ADMIN_SETTINGS_KEY = "agent_space.owner_admin_token";

/**
 * owner/系统域授权（验收 R2）：系统域写操作与 owner 决策不能凭调用方自报
 * actor 字符串获得权限。令牌来自服务侧 settings（运维写入）或进程环境变量，
 * 两者都缺位时 fail-closed。测试与运维通过受控入口注入，不经模型可达面。
 */
export function requireOwnerAuthorization(token: string | undefined, what: string): void {
  const provided = token?.trim();
  if (!provided) {
    throw new AgentSpaceError("AGENT_SPACE_OWNER_AUTH_REQUIRED", `${what} requires an owner token`);
  }
  let expected: string | undefined;
  const row = sqlite.prepare("SELECT value FROM settings WHERE key=?").get(OWNER_ADMIN_SETTINGS_KEY) as { value: string } | undefined;
  expected = row?.value?.trim() || process.env.AGENT_SPACE_OWNER_ADMIN_TOKEN?.trim();
  if (!expected || provided !== expected) {
    throw new AgentSpaceError("AGENT_SPACE_OWNER_AUTH_REQUIRED", `${what}: owner token mismatch`);
  }
}

/** 运行时白名单字段校验（验收 R1）：引用载荷不得携带未声明字段。 */
export function assertOnlyFields(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${what}: unexpected fields ${extra.join(",")}`);
  }
}
