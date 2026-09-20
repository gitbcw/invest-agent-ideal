/**
 * T-524 状态对象（W1 契约层；返工 R4/R5）。
 *
 * 语义（T-524 v2 + 验收 R4）：
 * - 批准绑定预览版本：approve 必须携带 expectedVersionId，修订产生新草稿后
 *   旧确认不能激活新版本（乐观并发）；
 * - 提出修订不令原有效版本退出生效：active 对象保持 active，草稿走
 *   draft_version_id 独立指针；
 * - 状态对象必须归属会话/任务/Agent（owner_kind/owner_id 经真实记录校验）；
 * - approvalRef 必须可核对（同 scope 会话消息或 owner 决策）；
 * - 内容字段按对象类型白名单校验，不接受任意 content。
 */
import { sqlite } from "../../db/index.js";
import {
  AgentSpaceError,
  assertIdempotencyConsistent,
  assertOnlyFields,
  assertDomainRowShape,
  assertRowScope,
  assertScopeValid,
  findByIdempotencyKey,
  newId,
  nowIso,
  recordAgentSpaceAudit,
  recordAuthorizationOutcome,
  verifyAuthorization,
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

// ---------- Lesson / Workflow ----------

export type LessonStatus = "draft" | "active" | "superseded" | "expired" | "rejected" | "disabled";
export type EvidenceState = "hypothesis" | "verified_once" | "supported" | "counterexample";
export type StateOwnerKind = "conversation" | "task" | "agent";

type StateObjectTable = "agent_space_lessons" | "agent_space_workflows";

/** 内容白名单（验收 R4：不接受任意 content）。 */
const LESSON_CONTENT_FIELDS = ["trigger", "guidance", "applicability"] as const;
const WORKFLOW_CONTENT_FIELDS = ["scenario", "steps", "expectedOutputs", "failureHandling", "references"] as const;

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

/** 归属校验（验收 R4）：状态对象必须挂在真实的会话/任务/Agent 上且同 scope。 */
function verifyStateOwner(scope: UserScope | null, domain: AgentSpaceScopeDomain, ownerKind: StateOwnerKind, ownerId: string): void {
  if (domain !== "user") {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "system-domain state objects are owner-managed; owner binding is user-domain only");
  }
  if (!scope) throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "owner binding requires scope");
  if (ownerKind === "conversation") {
    const row = sqlite
      .prepare("SELECT conversation_id, user_id, project_id, instance_id FROM conversation_sessions WHERE conversation_id=?")
      .get(ownerId) as { conversation_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `conversation ${ownerId} not found`);
    assertRowScope(row, scope);
    return;
  }
  if (ownerKind === "task") {
    const row = sqlite
      .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_tasks WHERE task_id=?")
      .get(ownerId) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation task ${ownerId} not found`);
    assertRowScope(row, scope);
    return;
  }
  if (ownerKind === "agent") {
    const row = sqlite
      .prepare("SELECT agent_id, user_id, project_id, instance_id FROM agent_space_agents WHERE agent_id=?")
      .get(ownerId) as { agent_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `agent ${ownerId} not found`);
    assertRowScope(row, scope);
    return;
  }
  throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `owner kind ${ownerKind}`);
}

export interface CreateStateCandidateInput {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  title: string;
  content: Record<string, unknown>;
  ownerKind: StateOwnerKind;
  ownerId: string;
  origin?: "agent" | "owner" | "ops";
  actor: string;
}

function verifyStateContent(kind: "lesson" | "workflow", content: Record<string, unknown>): void {
  const allowed = kind === "lesson" ? LESSON_CONTENT_FIELDS : WORKFLOW_CONTENT_FIELDS;
  assertOnlyFields(content, allowed, `${kind} content`);
  const requiredStrings = kind === "lesson" ? ["trigger", "guidance"] : ["scenario"];
  for (const field of requiredStrings) {
    if (typeof content[field] !== "string" || !(content[field] as string).trim()) {
      throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", `${kind} content.${field} is required`);
    }
  }
  if (kind === "workflow" && !Array.isArray(content.steps)) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "workflow content.steps must be an array");
  }
}

/** 创建候选：draft + 首个内容版本 + 归属。draft 不进入任何有效检索。 */
export function createStateCandidate(input: CreateStateCandidateInput): { objectId: string; versionId: string } {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  verifyStateContent(input.kind, input.content);
  verifyStateOwner(input.scope, domain, input.ownerKind, input.ownerId);
  const now = nowIso();
  const isLesson = input.kind === "lesson";
  const tx = sqlite.transaction(() => {
    const objectId = newId(isLesson ? "lesson" : "wflow");
    const versionId = newId(isLesson ? "lver" : "wver");
    if (isLesson) {
      sqlite
        .prepare(
          `INSERT INTO agent_space_lessons (
             lesson_id, domain, user_id, project_id, instance_id, title,
             status, evidence_state, origin, current_version_id, draft_version_id, owner_kind, owner_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'hypothesis', ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(objectId, domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
             input.title, input.origin ?? "agent", versionId, input.ownerKind, input.ownerId, now, now);
      sqlite
        .prepare(`INSERT INTO agent_space_lesson_versions (version_id, lesson_id, content_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(versionId, objectId, JSON.stringify(input.content), now);
    } else {
      sqlite
        .prepare(
          `INSERT INTO agent_space_workflows (
             workflow_id, domain, user_id, project_id, instance_id, title,
             status, origin, current_version_id, draft_version_id, owner_kind, owner_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(objectId, domain, input.scope?.userId ?? null, input.scope?.projectId ?? null, input.scope?.instanceId ?? null,
             input.title, input.origin ?? "agent", versionId, input.ownerKind, input.ownerId, now, now);
      sqlite
        .prepare(`INSERT INTO agent_space_workflow_versions (version_id, workflow_id, content_json, created_at) VALUES (?, ?, ?, ?)`)
        .run(versionId, objectId, JSON.stringify(input.content), now);
    }
    recordAgentSpaceAudit({
      domain,
      scope: input.scope,
      actor: input.actor,
      action: `${input.kind}.candidate_created`,
      objectType: isLesson ? "agent_space_lesson" : "agent_space_workflow",
      objectId,
      toStatus: "draft",
      detail: { versionId, ownerKind: input.ownerKind, ownerId: input.ownerId },
    });
    return { objectId, versionId };
  });
  return tx();
}

/**
 * 批准候选（验收 R4）：
 * - expectedVersionId 必填——批准绑定的就是用户看到并确认的那个版本；
 * - active 对象的修订草稿在 draft_version_id 上，批准它才会切换 current；
 * - approvalRef 必须可核对；批准不改 evidence_state。
 */
export function approveStateCandidate(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  objectId: string;
  expectedVersionId: string;
  approvedBy: string;
  approvalRef: string;
  ownerToken?: string;
  actor: string;
}): void {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  if (domain !== "user") {
    throw new AgentSpaceError("AGENT_SPACE_OWNER_AUTH_REQUIRED", "system-domain state approval is not exposed in W1");
  }
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  const tx = sqlite.transaction(() => {
    // R9：核验+消耗与业务变更、审计同事务（失败整体回滚）。
    const approval = verifyAuthorization(
      input.scope,
      {
        operation: "state.approve",
        objectType: input.kind === "lesson" ? "agent_space_lesson" : "agent_space_workflow",
        objectId: input.objectId,
        versionId: input.expectedVersionId,
        extraBinding: { kind: input.kind },
      },
      input.approvalRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回原结果（void），不重新执行转换，
    // 也不恢复后来被停用/拒绝的对象。授权凭证与 owner 决策记录都携带稳定
    // 结果，回放不依赖可变业务行。
    if (approval.replayed) return;
    // 事务内重读当前状态（预读不作为转换依据）。
    const fresh = getStateRow(table, input.objectId);
    assertStateScope(fresh, domain, input.scope);
    const status = fresh.status as string;
    const currentVersionId = fresh.current_version_id as string | null;
    const draftVersionId = fresh.draft_version_id as string | null;
    if (status !== "draft" && status !== "active") {
      throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot approve ${input.kind} in status ${status}`);
    }
    // 乐观并发：待批准版本必须是当前可批准指针（draft 对象=current；active 对象=draft 指针）。
    const approvable = status === "draft" ? currentVersionId : draftVersionId;
    if (!approvable) {
      throw new AgentSpaceError("AGENT_SPACE_VERSION_INVALID", status === "active" ? "no pending revision to approve" : "candidate has no version");
    }
    if (input.expectedVersionId !== approvable) {
      throw new AgentSpaceError(
        "AGENT_SPACE_IDEMPOTENCY_CONFLICT",
        `approval bound to version ${input.expectedVersionId} but approvable version is ${approvable}`,
      );
    }
    const now = nowIso();
    if (status === "active") {
      sqlite
        .prepare(`UPDATE ${table} SET current_version_id=?, draft_version_id=NULL, approved_at=?, approval_ref=?, approved_by=?, updated_at=? WHERE ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}=?`)
        .run(input.expectedVersionId, now, input.approvalRef, input.approvedBy, now, input.objectId);
    } else {
      sqlite
        .prepare(`UPDATE ${table} SET status='active', approved_by=?, approved_at=?, approval_ref=?, updated_at=? WHERE ${input.kind === "lesson" ? "lesson_id" : "workflow_id"}=?`)
        .run(input.approvedBy, now, input.approvalRef, now, input.objectId);
    }
    recordAgentSpaceAudit({
      domain,
      scope: input.scope,
      actor: input.actor,
      action: `${input.kind}.approved`,
      objectType: table,
      objectId: input.objectId,
      fromStatus: status,
      toStatus: "active",
      detail: { approvedBy: input.approvedBy, approvalRef: input.approvalRef, versionId: input.expectedVersionId },
    });
    recordAuthorizationOutcome(approval.authorizationId, { objectId: input.objectId, versionId: input.expectedVersionId });
  });
  tx();
}

/**
 * 修订（验收 R7）：
 * - 首次草稿（从未批准）：新版本直接替换 current_version_id——旧草稿的
 *   确认随之失效（expectedVersionId 不再匹配）；
 * - active：新版本进 draft_version_id 待批准指针，原有效版本保持生效；
 *   同一时刻只允许一个待批准修订。
 */
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
  verifyStateContent(input.kind, input.content);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  const status = row.status as string;
  if (status !== "active" && status !== "draft") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot revise ${input.kind} in status ${status}`);
  }
  if (status === "active" && row.draft_version_id) {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "a pending revision already exists; approve or discard it first");
  }
  const now = nowIso();
  const versionId = newId(input.kind === "lesson" ? "lver" : "wver");
  const idColumn = input.kind === "lesson" ? "lesson_id" : "workflow_id";
  const tx = sqlite.transaction(() => {
    if (input.kind === "lesson") {
      sqlite
        .prepare("INSERT INTO agent_space_lesson_versions (version_id, lesson_id, content_json, supersedes_version_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(versionId, input.objectId, JSON.stringify(input.content), row.current_version_id as string | null, now);
      sqlite
        .prepare(`UPDATE agent_space_lessons SET ${status === "draft" ? "current_version_id" : "draft_version_id"}=?, updated_at=? WHERE lesson_id=?`)
        .run(versionId, now, input.objectId);
    } else {
      sqlite
        .prepare("INSERT INTO agent_space_workflow_versions (version_id, workflow_id, content_json, supersedes_version_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(versionId, input.objectId, JSON.stringify(input.content), row.current_version_id as string | null, now);
      sqlite
        .prepare(`UPDATE agent_space_workflows SET ${status === "draft" ? "current_version_id" : "draft_version_id"}=?, updated_at=? WHERE workflow_id=?`)
        .run(versionId, now, input.objectId);
    }
    recordAgentSpaceAudit({
      domain,
      scope: input.scope,
      actor: input.actor,
      action: `${input.kind}.revised`,
      objectType: table,
      objectId: input.objectId,
      fromStatus: status,
      toStatus: status,
      detail: { versionId, mode: status === "draft" ? "replace-initial-draft" : "pending-on-active" },
    });
    return versionId;
  });
  return { versionId: tx() };
}

/**
 * 撤销/拒绝待批准修订（验收 R7）：只清 draft_version_id 待批准指针，
 * 原 active 有效版本不受影响；对象状态不改变（拒绝修订≠停用对象）。
 */
export function discardStateRevision(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
  objectId: string;
  reason?: string;
  actor: string;
}): void {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const row = getStateRow(table, input.objectId);
  assertStateScope(row, domain, input.scope);
  const idColumn = input.kind === "lesson" ? "lesson_id" : "workflow_id";
  if (row.status !== "active" || !row.draft_version_id) {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "no pending revision to discard");
  }
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(`UPDATE ${table} SET draft_version_id=NULL, updated_at=? WHERE ${idColumn}=?`)
      .run(nowIso(), input.objectId);
    recordAgentSpaceAudit({
      domain,
      scope: input.scope,
      actor: input.actor,
      action: `${input.kind}.revision_discarded`,
      objectType: table,
      objectId: input.objectId,
      detail: { discardedVersionId: row.draft_version_id as string, reason: input.reason ?? null },
    });
  });
  tx();
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
  const tx = sqlite.transaction(() => {
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
  });
  tx();
}

/**
 * 有效检索：只返回 active 且未过期对象，绑定 current（已批准）版本。
 * draft/修订草稿/rejected/expired/disabled/superseded 全部排除。
 */
export function listEffectiveState(input: {
  domain?: AgentSpaceScopeDomain;
  scope: UserScope | null;
  kind: "lesson" | "workflow";
}): Array<{ objectId: string; title: string; versionId: string; content: Record<string, unknown>; ownerKind: string | null; ownerId: string | null }> {
  const domain = input.domain ?? "user";
  assertDomainRowShape(domain, input.scope);
  const table: StateObjectTable = input.kind === "lesson" ? "agent_space_lessons" : "agent_space_workflows";
  const versionTable = input.kind === "lesson" ? "agent_space_lesson_versions" : "agent_space_workflow_versions";
  const rows = sqlite
    .prepare(
      `SELECT h.${input.kind === "lesson" ? "lesson_id" : "workflow_id"} AS objectId, h.title, h.current_version_id AS versionId,
              h.owner_kind AS ownerKind, h.owner_id AS ownerId, v.content_json AS content
       FROM ${table} h JOIN ${versionTable} v ON v.version_id = h.current_version_id
       WHERE h.domain=? AND COALESCE(h.user_id,'')=? AND COALESCE(h.project_id,'')=? AND COALESCE(h.instance_id,'')=?
         AND h.status='active' AND (h.expires_at IS NULL OR h.expires_at > ?)`,
    )
    .all(domain, input.scope?.userId ?? "", input.scope?.projectId ?? "", input.scope?.instanceId ?? "", nowIso()) as Array<{
    objectId: string;
    title: string;
    versionId: string;
    ownerKind: string | null;
    ownerId: string | null;
    content: string;
  }>;
  return rows.map((r) => ({
    objectId: r.objectId, title: r.title, versionId: r.versionId,
    ownerKind: r.ownerKind, ownerId: r.ownerId, content: JSON.parse(r.content),
  }));
}

// ---------- AgentCommitment ----------

export type CommitmentStatus = "proposed" | "active" | "paused" | "cancelled" | "completed";
export type FulfillmentStatus = "pending" | "running" | "satisfied" | "failed_needs_attention" | "skipped";

function getCommitmentRow(scope: UserScope, commitmentId: string): Record<string, unknown> {
  const row = sqlite.prepare("SELECT * FROM agent_space_commitments WHERE commitment_id=?").get(commitmentId);
  if (!row) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `commitment ${commitmentId}`);
  assertRowScope(row as { user_id: string | null; project_id: string | null; instance_id: string | null }, scope);
  return row as Record<string, unknown>;
}

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
  if (input.executorTaskId) {
    const task = sqlite
      .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_tasks WHERE task_id=?")
      .get(input.executorTaskId) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!task) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `executor task ${input.executorTaskId} not found`);
    assertRowScope(task, input.scope);
  }
  if (input.idempotencyKey) {
    const existing = findByIdempotencyKey("agent_space_commitments", input.scope, input.idempotencyKey);
    assertIdempotencyConsistent(
      existing,
      (row) => JSON.stringify([row.title, row.content_json, row.commitment_kind, row.completion_criteria]),
      JSON.stringify([input.title, JSON.stringify(input.content), input.commitmentKind, input.completionCriteria]),
      "createCommitment",
    );
    if (existing) return { commitmentId: String(existing.commitment_id) };
  }
  const now = nowIso();
  const tx = sqlite.transaction(() => {
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
    return commitmentId;
  });
  return { commitmentId: tx() };
}

export function activateCommitment(input: {
  scope: UserScope;
  commitmentId: string;
  authorizationRef: string;
  executorTaskId: string;
  ownerToken?: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  getCommitmentRow(input.scope, input.commitmentId);
  const executor = sqlite
    .prepare("SELECT task_id, user_id, project_id, instance_id FROM automation_tasks WHERE task_id=?")
    .get(input.executorTaskId) as { task_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
  if (!executor) {
    throw new AgentSpaceError("AGENT_SPACE_ARGUMENT_INVALID", "executor task not found in scope; commitment stays proposed");
  }
  assertRowScope(executor, input.scope);
  const tx = sqlite.transaction(() => {
    // R9：核验+消耗与激活写入、审计同事务。
    const approval = verifyAuthorization(
      input.scope,
      { operation: "commitment.activate", objectType: "agent_space_commitment", objectId: input.commitmentId, versionId: null, extraBinding: { executorTaskId: input.executorTaskId } },
      input.authorizationRef,
      input.ownerToken,
    );
    // R9②：已成功操作的幂等回放——返回原结果（void），后续 paused/cancelled
    // 状态保持不变，不被回放恢复成 active（授权凭证与 owner 决策记录同机制）。
    if (approval.replayed) return;
    // 事务内重读状态（预读不作为转换依据）。
    const current = getCommitmentRow(input.scope, input.commitmentId);
    if (String(current.status) !== "proposed" && String(current.status) !== "paused") {
      throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot activate commitment in status ${String(current.status)}`);
    }
    sqlite
      .prepare("UPDATE agent_space_commitments SET status='active', authorization_ref=?, executor_task_id=?, updated_at=? WHERE commitment_id=?")
      .run(input.authorizationRef, input.executorTaskId, nowIso(), input.commitmentId);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "commitment.activated",
      objectType: "agent_space_commitment",
      objectId: input.commitmentId,
      fromStatus: String(current.status),
      toStatus: "active",
      detail: { authorizationRef: input.authorizationRef, executorTaskId: input.executorTaskId },
    });
    recordAuthorizationOutcome(approval.authorizationId, { commitmentId: input.commitmentId });
  });
  tx();
}

export function transitionCommitment(input: {
  scope: UserScope;
  commitmentId: string;
  toStatus: "paused" | "cancelled" | "completed";
  reason?: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  const row = getCommitmentRow(input.scope, input.commitmentId);
  const allowed: Record<string, string[]> = {
    proposed: ["cancelled"],
    active: ["paused", "cancelled", "completed"],
    paused: ["active", "cancelled"],
    completed: [],
    cancelled: [],
  };
  if (!allowed[String(row.status)]?.includes(input.toStatus)) {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `${row.status} -> ${input.toStatus} is not allowed`);
  }
  if (input.toStatus === "completed" && row.commitment_kind !== "one_shot") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", "recurring commitments stay active across periods; use paused/cancelled");
  }
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare("UPDATE agent_space_commitments SET status=?, updated_at=? WHERE commitment_id=?")
      .run(input.toStatus, nowIso(), input.commitmentId);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "commitment.transitioned",
      objectType: "agent_space_commitment",
      objectId: input.commitmentId,
      fromStatus: String(row.status),
      toStatus: input.toStatus,
      detail: { reason: input.reason ?? null },
    });
  });
  tx();
}

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
  const row = getCommitmentRow(input.scope, input.commitmentId);
  if (row.status !== "active") {
    throw new AgentSpaceError("AGENT_SPACE_INVALID_TRANSITION", `cannot record fulfillment on ${row.status} commitment`);
  }
  if (input.runId) {
    const run = sqlite
      .prepare("SELECT run_id, user_id, project_id, instance_id FROM automation_task_runs WHERE run_id=?")
      .get(input.runId) as { run_id: string; user_id: string; project_id: string; instance_id: string } | undefined;
    if (!run) throw new AgentSpaceError("AGENT_SPACE_NOT_FOUND", `automation run ${input.runId} not found`);
    assertRowScope(run, input.scope);
  }
  const now = nowIso();
  const tx = sqlite.transaction(() => {
    const fulfillmentId = newId("cful");
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
           Number(row.version_number), now, now);
    recordAgentSpaceAudit({
      scope: input.scope,
      actor: input.actor,
      action: "commitment.fulfillment_recorded",
      objectType: "agent_space_commitment_fulfillment",
      objectId: `${input.commitmentId}:${input.dueAt ?? "ad-hoc"}`,
      toStatus: input.status,
      detail: { runId: input.runId ?? null, commitmentVersion: Number(row.version_number) },
    });
    return fulfillmentId;
  });
  return { fulfillmentId: tx() };
}
