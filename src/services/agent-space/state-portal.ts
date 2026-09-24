import { randomUUID } from "node:crypto";

import { sqlite } from "../../db/index.js";
import { AgentSpaceError, assertScopeValid, nowIso } from "./core.js";
import { registerPortalActionAuthorization } from "./portal-actions.js";
import { approveStateCandidate, transitionStateCandidate } from "./state.js";
import type { UserScope } from "./core.js";

/**
 * T-540 候选审阅 Portal 层：draft 候选列表/详情读模型 + 批准/拒绝的显式
 * 动作。批准唯一生效口是 approveStateCandidate（凭证消耗同事务）；拒绝后
 * 无新事实或实质内容变化不得重复打扰——以 dedup 键（同 owner 同标题）在
 * 读模型上呈现「已拒绝（勿重复提示）」状态。
 */

export interface StateCandidateView {
  objectId: string;
  kind: "lesson" | "workflow";
  title: string;
  status: string;
  origin: string;
  ownerKind: string;
  ownerId: string;
  /** 触达分流：conversation=当前对话/问题会话；task=自动化附着。 */
  surface: "conversation" | "task";
  versionId: string;
  content: Record<string, unknown>;
  /** 同 owner 同标题的既有 rejected 候选（提示勿重复打扰）。 */
  previouslyRejected: boolean;
  createdAt: string;
  updatedAt: string;
}

type RawRow = {
  object_id: string;
  kind: "lesson" | "workflow";
  title: string;
  status: string;
  origin: string;
  owner_kind: string;
  owner_id: string;
  draft_version_id: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  content_json: string;
};

function loadCandidates(scope: UserScope, options: { status?: string } = {}): StateCandidateView[] {
  assertScopeValid(scope);
  const lessons = sqlite
    .prepare(
      `SELECT lesson_id AS object_id, 'lesson' AS kind, title, status, origin, owner_kind, owner_id,
              draft_version_id, current_version_id, created_at, updated_at
       FROM agent_space_lessons
       WHERE user_id=? AND project_id=? AND instance_id=?`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId);
  const workflows = sqlite
    .prepare(
      `SELECT workflow_id AS object_id, 'workflow' AS kind, title, status, origin, owner_kind, owner_id,
              draft_version_id, current_version_id, created_at, updated_at
       FROM agent_space_workflows
       WHERE user_id=? AND project_id=? AND instance_id=?`,
    )
    .all(scope.userId, scope.projectId, scope.instanceId);
  const rows = [...lessons, ...workflows] as Array<Omit<RawRow, "content_json">>;
  const rejectedKeys = new Set(
    rows.filter((r) => r.status === "rejected").map((r) => `${r.owner_id}:${r.title}`),
  );
  return rows
    .filter((r) => (options.status ? r.status === options.status : true))
    .map((r) => {
      const versionId = r.draft_version_id ?? r.current_version_id;
      let content: Record<string, unknown> = {};
      if (versionId) {
        const table = r.kind === "lesson" ? "agent_space_lesson_versions" : "agent_space_workflow_versions";
        const idCol = r.kind === "lesson" ? "lesson_id" : "workflow_id";
        const versionRow = sqlite
          .prepare(`SELECT content_json FROM ${table} WHERE version_id=? AND ${idCol}=?`)
          .get(versionId, r.object_id) as { content_json: string } | undefined;
        if (versionRow) {
          try {
            content = JSON.parse(versionRow.content_json) as Record<string, unknown>;
          } catch { /* keep empty */ }
        }
      }
      return {
        objectId: r.object_id,
        kind: r.kind,
        title: r.title,
        status: r.status,
        origin: r.origin,
        ownerKind: r.owner_kind,
        ownerId: r.owner_id,
        surface: r.owner_kind === "task" ? ("task" as const) : ("conversation" as const),
        versionId: versionId ?? "",
        content,
        previouslyRejected: r.status !== "rejected" && rejectedKeys.has(`${r.owner_id}:${r.title}`),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    })
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 待审阅候选（draft）：低优先级网页待确认改进的数据源。 */
export function listPendingStateCandidates(scope: UserScope): StateCandidateView[] {
  return loadCandidates(scope, { status: "draft" });
}

/** 全量候选（含已批准/拒绝历史）。 */
export function listAllStateCandidates(scope: UserScope): StateCandidateView[] {
  return loadCandidates(scope);
}

export function getStateCandidate(scope: UserScope, objectId: string): StateCandidateView | null {
  return loadCandidates(scope).find((candidate) => candidate.objectId === objectId) ?? null;
}

/** 批准候选（approve + activate）：显式动作走 portal 凭证（R9 消耗同事务）。 */
export function portalApproveStateCandidate(input: {
  scope: UserScope;
  kind: "lesson" | "workflow";
  objectId: string;
  versionId: string;
  portalRequestId: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  const approvalRef = registerPortalActionAuthorization({
    scope: input.scope,
    operation: "state.approve",
    objectType: input.kind === "lesson" ? "agent_space_lesson" : "agent_space_workflow",
    objectId: input.objectId,
    versionId: input.versionId,
    extraBinding: { kind: input.kind },
    sourceRef: `${input.scope.userId}:${input.portalRequestId}`,
    actor: input.actor,
  });
  approveStateCandidate({
    scope: input.scope,
    kind: input.kind,
    objectId: input.objectId,
    expectedVersionId: input.versionId,
    approvedBy: input.scope.userId,
    approvalRef,
    actor: input.actor,
  });
}

/** 拒绝候选（rejected 终态；此后同 owner 同标题的新草案标记勿重复打扰）。 */
export function portalRejectStateCandidate(input: {
  scope: UserScope;
  kind: "lesson" | "workflow";
  objectId: string;
  reason?: string;
  actor: string;
}): void {
  assertScopeValid(input.scope);
  transitionStateCandidate({
    scope: input.scope,
    kind: input.kind,
    objectId: input.objectId,
    toStatus: "rejected",
    reason: input.reason,
    actor: input.actor,
  });
}
