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
      | "AGENT_SPACE_ARGUMENT_INVALID",
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
