/**
 * T-524 状态对象（W1 契约层）：AgentFact / AgentLesson / AgentWorkflow /
 * AgentCommitment + 履约引用。
 *
 * 语义（docs/agent-self-correction-workspace-design.md v2）：
 * - 事实由服务层记录，只引用既有 message/trace/run/delivery/audit 记录；
 * - 候选（draft）必须经用户批准才 active；批准绑定具体版本与适用范围；
 * - 采用许可与证据状态分离：批准不改变 evidenceState；
 * - draft/过期/拒绝/退役不进入检索（listEffective* 只返回 active 且未过期）；
 * - 承诺与履约分开建模，状态机不复用 lesson；周期承诺履约后仍有效；
 * - 用户级与系统级分域；系统域写入走 owner/ops 调用方。
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

// ---------- AgentFact ----------

export interface RecordFactInput {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  eventType: string;
  sourceType: "trace" | "message" | "run" | "delivery" | "audit" | "task";
  sourceId: string;
  summary?: Record<string, unknown>;
  occurredAt: string;
}

/** 幂等：同一 (scope, eventType, sourceId) 只保留一行（自然键索引兜底）。 */
export function recordAgentFact(input: RecordFactInput): { factId: string; duplicated: boolean } {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const existing = sqlite
    .prepare(
      `SELECT fact_id FROM agent_space_facts
       WHERE COALESCE(user_id,'')=? AND COALESCE(project_id,'')=? AND COALESCE(instance_id,'')=?
         AND event_type=? AND source_id=?`,
    )
    .get(input.scope?.userId ?? "", input.scope?.projectId ?? "", input.scope?.instanceId ?? "", input.eventType, input.sourceId) as
    | { fact_id: string }
    | undefined;
  if (existing) return { factId: existing.fact_id, duplicated: true };
  const factId = newId("fact");
  sqlite
    .prepare(
      `INSERT INTO agent_space_facts (
         fact_id, domain, user_id, project_id, instance_id, event_type, source_type, source_id, summary_json, occurred_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(factId, domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
         input.eventType, input.sourceType, input.sourceId, input.summary ? JSON.stringify(input.summary) : null,
         input.occurredAt, nowIso());
  return { factId, duplicated: false };
}

// ---------- Lesson / Workflow 共用生命周期 ----------

export type LessonStatus = "draft" | "active" | "superseded" | "expired" | "rejected" | "disabled";
export type EvidenceState = "hypothesis" | "verified_once" | "supported" | "counterexample";

type StateObjectTable = "agent_space_lessons" | "agent_space_workflows";

function getStateRow(table: StateObjectTable, id: string): Record<string, unknown> {
  const row = sqlite.prepare(`SELECT * FROM ${table} WHERE ${table === "agent_space_lessons" ? "lesson_id" : "workflow_id"}=?`).get(id);
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `${table} ${id}`);
  return row as Record<string, unknown>;
}

function assertStateScope(row: Record<string, unknown>, domain: AgentSpaceScopeDomain, scope: UserScope | null): void {
  if (row.domain !== domain) throw new AgentSpaceError("AGENT_SPACE_SCOPE_MISMATCH", `object belongs to ${row.domain} domain`);
  if (domain === "user") {
    if (!scope) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "user-domain access requires scope");
    assertRowScope(row as { user_id: string | null; project_id: string | null; instance_id: string | null }, scope);
  }
}

export interface CreateStateCandidateInput {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  title: string;
  /** 结构化内容（trigger/guidance/applicability 或工作说明步骤），版本化保存。 */
  content: Record<string, unknown>;
  origin?: "agent" | "owner" | "ops";
  actor: string;
}

/** 创建候选：draft + 首个内容版本。draft 不进入任何有效检索。 */
export function createStateCandidate(input: CreateStateCandidateInput): { objectId: string; versionId: string } {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const now = nowIso();
  const isLesson = input.kind === "lesson";
  const objectId = newId(isLesson ? "lesson" : "wflow");
  const versionId = newId(isLesson ? "lver" : "wver");
  const tx = sqlite.transaction(() => {
    if (isLesson) {
      sqlite
        .prepare(
          `INSERT INTO agent_space_lessons (
             lesson_id, domain, user_id, project_id, instance_id, title,
             status, evidence_state, origin, current_version_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'hypothesis', ?, NULL, ?, ?)`,
        )
        .run(objectId, domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
             input.title, input.origin ?? "agent", now, now);
    } else {
      sqlite
        .prepare(
          `INSERT INTO agent_space_workflows (
             workflow_id, domain, user_id, project_id, instance_id, title,
             status, origin, current_version_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, NULL, ?, ?)`,
        )
        .run(objectId, domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
             input.title, input.origin ?? "agent", now, now);
    }
    sqlite
      .prepare(
        `INSERT INTO ${isLesson ? "agent_space_lesson_versions" : "agent_space_workflow_versions"} (
           version_id, ${isLesson ? "lesson_id" : "workflow_id"}, content_json, created_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(versionId, objectId, JSON.stringify(input.content), now);
    sqlite
      .prepare(
        `UPDATE ${isLesson ? "agent_space_lessons" : "agent_space_workflows"} SET current_version_id=? WHERE ${isLesson ? "lesson_id" : "workflow_id"}=?`,
      )
      .run(versionId, objectId);
    recordAgentSpaceAudit({
      domain,
      scope: input.scope,
      actor: input.actor,
      action: `${input.kind}.candidate_created`,
      objectType: isLesson ? "agent_space_lesson" : "agent_space_workflow",
      objectId,
      toStatus: "draft",
      detail: { versionId },
    });
    return { objectId, versionId };
  });
  return tx();
}

/**
 * 批准候选：active 必须绑定具体版本与可核对依据。批准只改采用许可，
 * 不改 evidenceState（证据状态由反例/验证单独演进）。
 */
export function approveStateCandidate(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  objectId: string;
  approvedBy: string;
  approvalRef: string;
  actor: string;
}): void {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  if (row.status !== "draft" && row.status !== "disabled") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot approve ${input.kind} in status ${row.status}`);
  }
  if (!input.approvalRef?.trim()) {
    throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "approvalRef is required");
  }
  if (!row.current_version_id) {
    throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", "candidate has no version to approve");
  }
  const now = nowIso();
  sqlite
    .prepare(
      `UPDATE ${table} SET status='active', approved_by=?, approved_at=?, approval_ref=?, updated_at=?
       WHERE ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}=?`,
    )
    .run(input.approvedBy, now, input.approvalRef, now, input.objectId);
  recordAgentSpaceAudit({
    domain,
    scope: input.scope,
    actor: input.actor,
    action: `${input.kind}.approved`,
    objectType: table,
    objectId: input.objectId,
    fromStatus: String(row.status),
    toStatus: "active",
    detail: { approvedBy: input.approvedBy, approvalRef: input.approvalRef, versionId: row.current_version_id },
  });
}

/** 修订：active 对象产生新 draft 版本并回到 draft（旧版本保留为 superseded 依据）。 */
export function reviseStateCandidate(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  objectId: string;
  content: Record<string, unknown>;
  actor: string;
}): { versionId: string } {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  if (row.status !== "active" && row.status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot revise ${input.kind} in status ${row.status}`);
  }
  const now = nowIso();
  const versionId = newId(input.kind === "lesson" ? "lver" : "wver");
  sqlite
    .prepare(
      `INSERT INTO ${input.kind === "lesson" ? "agent_space_lesson_versions" : "agent_space_workflow_versions"} (
         version_id, ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}, content_json, supersedes_version_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(versionId, input.objectId, JSON.stringify(input.content), row.current_version_id ?? null, now);
  sqlite
    .prepare(`UPDATE ${table} SET status='draft', current_version_id=?, updated_at=? WHERE ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}=?`)
    .run(versionId, now, input.objectId);
  recordAgentSpaceAudit({
    domain,
    scope: input.scope,
    actor: input.actor,
    action: `${input.kind}.revised`,
    objectType: table,
    objectId: input.objectId,
    fromStatus: String(row.status),
    toStatus: "draft",
    detail: { versionId, supersedesVersionId: row.current_version_id ?? null },
  });
  return { versionId };
}

const TERMINAL_OR_INACTIVE: LessonStatus[] = ["superseded", "expired", "rejected", "disabled"];

/** 退役/拒绝/停用/过期等非 active 转换；draft 可直接 reject。 */
export function transitionStateCandidate(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  objectId: string;
  toStatus: "superseded" | "expired" | "rejected" | "disabled";
  reason?: string;
  actor: string;
}): void {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  const from = row.status as string;
  if (from === input.toStatus) return;
  if (!TERMINAL_OR_INACTIVE.includes(input.toStatus)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "unsupported transition target");
  }
  if (from === "rejected" || from === "superseded") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `${from} is terminal`);
  }
  sqlite
    .prepare(`UPDATE ${table} SET status=?, updated_at=? WHERE ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}=?`)
    .run(input.toStatus, nowIso(), input.objectId);
  recordAgentSpaceAudit({
    domain,
    scope: input.scope,
    actor: input.actor,
    action: `${input.kind}.transitioned`,
    objectType: table,
    objectId: input.objectId,
    fromStatus: from,
    toStatus: input.toStatus,
    detail: { reason: input.reason ?? null },
  });
}

/**
 * 有效检索（State Packet 的 W1 契约形态）：只返回 active 且未过期的对象，
 * 绑定 current_version_id。draft/rejected/expired/disabled/superseded 全部排除。
 */
export function listEffectiveState(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
}): Array<{ objectId: string; title: string; versionId: string; content: Record<string, unknown> }> {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const versionTable = input.kind === "lesson" ? "agent_space_lesson_versions" : "agent_space_workflow_versions";
  const rows = sqlite
    .prepare(
      `SELECT h.${input.kind === "lesson" ? "lesson_id" : "workflow_id"} AS objectId, h.title, h.current_version_id AS versionId, v.content_json AS content
       FROM ${table} h JOIN ${versionTable} v ON v.version_id = h.current_version_id
       WHERE h.domain=? AND COALESCE(h.user_id,'')=? AND COALESCE(h.project_id,'')=? AND COALESCE(h.instance_id,'')=?
         AND h.status='active' AND (h.expires_at IS NULL OR h.expires_at > ?)`,
    )
    .all(domain, input.scope?.userId ?? "", input.scope?.projectId ?? "", input.scope?.instanceId ?? "", nowIso()) as Array<{
    objectId: string;
    title: string;
    versionId: string;
    content: string;
  }>;
  return rows.map((r) => ({ objectId: r.objectId, title: r.title, versionId: r.versionId, content: JSON.parse(r.content) }));
}

// ---------- AgentCommitment ----------

export type CommitmentStatus = "proposed" | "active" | "paused" | "cancelled" | "completed";
export type FulfillmentStatus = "pending" | "running" | "satisfied" | "failed_needs_attention" | "skipped";

export function createCommitment(input: {
  scope: UserScope;
  title: string;
  content: Record<string, unknown>;
  commitmentKind: "one_shot" | "recurring";
  trigger?: Record<string, unknown>;
  completionCriteria: string;
  executorType?: string;
  executorTaskId?: string;
  idempotencyKey?: string;
  actor: string;
}): { commitmentId: string } {
  assertScopeValid(input.scope);
  if (input.idempotencyKey) {
    const existing = sqlite
      .prepare(
        "SELECT commitment_id FROM agent_space_commitments WHERE user_id=? AND project_id=? AND instance_id=? AND idempotency_key=?",
      )
      .get(input.scope.userId, input.scope.projectId, input.scope.instanceId, input.idempotencyKey) as { commitment_id: string } | undefined;
    if (existing) return { commitmentId: existing.commitment_id };
  }
  const now = nowIso();
  const commitmentId = newId("cmt");
  sqlite
    .prepare(
      `INSERT INTO agent_space_commitments (
         commitment_id, user_id, project_id, instance_id, title, content_json, commitment_kind,
         trigger_json, completion_criteria, executor_type, executor_task_id, authorization_ref,
         status, version_number, idempotency_key, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'proposed', 1, ?, ?, ?)`,
    )
    .run(commitmentId, input.scope.userId, input.scope.projectId, input.scope.instanceId, input.title,
         JSON.stringify(input.content), input.commitmentKind, input.trigger ? JSON.stringify(input.trigger) : null,
         input.completionCriteria, input.executorType ?? null, input.executorTaskId ?? null,
         input.idempotencyKey ?? null, now, now);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "commitment.created",
    objectType: "agent_space_commitment",
    objectId: commitmentId,
    toStatus: "proposed",
  });
  return { commitmentId };
}

/**
 * proposed → active 需要授权依据（用户消息/操作引用）且执行器已可用；
 * 执行器缺失时保留 proposed 并写明原因，不声称已安排。
 */
export function activateCommitment(input: {
  scope: UserScope;
  commitmentId: string;
  authorizationRef: string;
  executorTaskId: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  const row = sqlite.prepare("SELECT * FROM agent_space_commitments WHERE commitment_id=?").get(input.commitmentId) as
    | { user_id: string; project_id: string; instance_id: string; status: CommitmentStatus; executor_task_id: string | null }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `commitment ${input.commitmentId}`);
  assertRowScope(row, input.scope);
  if (row.status !== "proposed" && row.status !== "paused") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot activate commitment in status ${row.status}`);
  }
  if (!input.authorizationRef?.trim()) {
    throw new AgentSpaceError("AGENT_SPACE_APPROVAL_REQUIRED", "authorizationRef is required; agent self-claim is not authorization");
  }
  const executorExists = sqlite
    .prepare("SELECT task_id FROM automation_tasks WHERE task_id=? AND user_id=? AND project_id=? AND instance_id=?")
    .get(input.executorTaskId, input.scope.userId, input.scope.projectId, input.scope.instanceId);
  if (!executorExists) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "executor task not found in scope; commitment stays proposed");
  }
  const now = nowIso();
  sqlite
    .prepare("UPDATE agent_space_commitments SET status='active', authorization_ref=?, executor_task_id=?, updated_at=? WHERE commitment_id=?")
    .run(input.authorizationRef, input.executorTaskId, now, input.commitmentId);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "commitment.activated",
    objectType: "agent_space_commitment",
    objectId: input.commitmentId,
    fromStatus: row.status,
    toStatus: "active",
    detail: { authorizationRef: input.authorizationRef, executorTaskId: input.executorTaskId },
  });
}

export function transitionCommitment(input: {
  scope: UserScope;
  commitmentId: string;
  toStatus: "paused" | "cancelled" | "completed";
  reason?: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  const row = sqlite.prepare("SELECT * FROM agent_space_commitments WHERE commitment_id=?").get(input.commitmentId) as
    | { user_id: string; project_id: string; instance_id: string; status: CommitmentStatus; commitment_kind: string }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `commitment ${input.commitmentId}`);
  assertRowScope(row, input.scope);
  const allowed: Record<string, string[]> = {
    proposed: ["cancelled"],
    active: ["paused", "cancelled", "completed"],
    paused: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  };
  if (!allowed[row.status]?.includes(input.toStatus)) {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `${row.status} -> ${input.toStatus} is not allowed`);
  }
  if (input.toStatus === "completed" && row.commitment_kind !== "one_shot") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "recurring commitments stay active across periods; use paused/cancelled");
  }
  sqlite
    .prepare("UPDATE agent_space_commitments SET status=?, updated_at=? WHERE commitment_id=?")
    .run(input.toStatus, nowIso(), input.commitmentId);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "commitment.transitioned",
    objectType: "agent_space_commitment",
    objectId: input.commitmentId,
    fromStatus: row.status,
    toStatus: input.toStatus,
    detail: { reason: input.reason ?? null },
  });
}

/** 登记一期履约：绑定约定版本与 run/产物/投递引用。 */
export function recordFulfillment(input: {
  scope: UserScope;
  commitmentId: string;
  dueAt?: string;
  status: FulfillmentStatus;
  runId?: string;
  resultRef?: Record<string, unknown>;
  deliveryRef?: Record<string, unknown>;
  actor: string;
}): { fulfillmentId: string } {
  assertScopeValid(input.scope);
  const row = sqlite.prepare("SELECT * FROM agent_space_commitments WHERE commitment_id=?").get(input.commitmentId) as
    | { user_id: string; project_id: string; instance_id: string; status: CommitmentStatus; version_number: number }
    | undefined;
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `commitment ${input.commitmentId}`);
  assertRowScope(row, input.scope);
  if (row.status !== "active") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot record fulfillment on ${row.status} commitment`);
  }
  const fulfillmentId = newId("cful");
  const now = nowIso();
  sqlite
    .prepare(
      `INSERT INTO agent_space_commitment_fulfillments (
         fulfillment_id, commitment_id, user_id, project_id, instance_id, due_at, status,
         run_id, result_ref_json, delivery_ref_json, commitment_version_number, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(commitment_id, due_at) DO UPDATE SET
         status=excluded.status, run_id=excluded.run_id,
         result_ref_json=excluded.result_ref_json, delivery_ref_json=excluded.delivery_ref_json,
         updated_at=excluded.updated_at`,
    )
    .run(fulfillmentId, input.commitmentId, input.scope.userId, input.scope.projectId, input.scope.instanceId,
         input.dueAt ?? null, input.status, input.runId ?? null,
         input.resultRef ? JSON.stringify(input.resultRef) : null,
         input.deliveryRef ? JSON.stringify(input.deliveryRef) : null,
         row.version_number, now, now);
  recordAgentSpaceAudit({
    scope: input.scope,
    actor: input.actor,
    action: "commitment.fulfillment_recorded",
    objectType: "agent_space_commitment_fulfillment",
    objectId: `${input.commitmentId}:${input.dueAt ?? "ad-hoc"}`,
    toStatus: input.status,
    detail: { runId: input.runId ?? null, commitmentVersion: row.version_number },
  });
  return { fulfillmentId };
}
