/**
 * 方法变更候选(method_change_candidates)后端抽象(WP4.9,2026-06-21)。
 *
 * 与 portfolio/watchlist/plan/daily-plan 同样的双轨模式,通过 WORKSPACE_BACKEND 切换:
 *   - "sqlite"(默认):行为不变,读写 method_change_candidates 表
 *   - "workspace":读写 memory/method_changes.jsonl(append-only 版本快照)
 *
 * 设计:jsonl 是 append-only,每条 append 一个候选的"版本快照"(candidateId+updatedAt 唯一)。
 * decide 操作不修改原记录,而是 append 一条新版本(status/decisionNote/confirmedAt 更新)。
 * list 返回每个候选的最新版本,审计可通过 listMethodChangeVersions 看全部历史。
 */

import { and, desc, eq, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { methodChangeCandidates } from "../db/schema.js";
import { ensureWorkspace } from "./workspace.js";
import { WorkspaceStore } from "./workspace-store.js";
import { ACTIVE_BACKEND, type BackendKind } from "./data-backend.js";

export type MethodChangeStatus = "proposed" | "confirmed" | "rejected";

export interface MethodChangeRecord {
  /** sqlite 路径有(rowId),workspace 路径用 uuid。 */
  id: string;
  userId: string;
  instanceId: string;
  sourceReviewId?: string | null;
  sourceType: string;
  proposedChange: string;
  reason: string;
  affectedResource: string;
  status: MethodChangeStatus;
  decisionNote?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeInput {
  userId: string;
  instanceId: string;
  sourceReviewId?: string | null;
  sourceType?: string;
  proposedChange: string;
  reason: string;
  affectedResource?: string;
  /** 可选:propose 时附加的决策备注(如任务上下文)。 */
  decisionNote?: string | null;
}

export interface DecideInput {
  userId: string;
  instanceId: string;
  id: string;
  status: "confirmed" | "rejected";
  decisionNote?: string | null;
}

export interface MethodChangeBackend {
  /** 新建一个 proposed 候选,返回完整记录(含 id)。 */
  propose(input: ProposeInput): Promise<MethodChangeRecord>;
  /** 按 id 取最新版本。 */
  get(userId: string, instanceId: string, id: string): Promise<MethodChangeRecord | null>;
  /** 修改 status 为 confirmed/rejected。返回更新后的记录。 */
  decide(input: DecideInput): Promise<MethodChangeRecord | null>;
  /** 列出候选(去重版本,按 updated_at desc)。status 可选过滤。 */
  list(userId: string, instanceId: string, options: { status?: MethodChangeStatus; limit?: number }): Promise<MethodChangeRecord[]>;
}

// ============ SQLite 实现 ============

function fromRow(row: typeof methodChangeCandidates.$inferSelect): MethodChangeRecord {
  return {
    id: String(row.id),
    userId: row.userId,
    instanceId: row.instanceId,
    sourceReviewId: row.sourceReviewId,
    sourceType: row.sourceType,
    proposedChange: row.proposedChange,
    reason: row.reason,
    affectedResource: row.affectedResource,
    status: row.status as MethodChangeStatus,
    decisionNote: row.decisionNote,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const sqliteMethodChangeBackend: MethodChangeBackend = {
  async propose(input) {
    const now = new Date().toISOString();
    const [created] = await db.insert(methodChangeCandidates).values({
      userId: input.userId,
      instanceId: input.instanceId,
      sourceReviewId: input.sourceReviewId ?? null,
      sourceType: input.sourceType || "review",
      proposedChange: input.proposedChange,
      reason: input.reason,
      affectedResource: input.affectedResource || "methodology_profile",
      status: "proposed",
      decisionNote: input.decisionNote ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return fromRow(created);
  },

  async get(userId, instanceId, id) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) return null;
    const rows = await db
      .select()
      .from(methodChangeCandidates)
      .where(and(eq(methodChangeCandidates.userId, userId), eq(methodChangeCandidates.instanceId, instanceId), eq(methodChangeCandidates.id, numId)))
      .limit(1);
    return rows.length > 0 ? fromRow(rows[0]) : null;
  },

  async decide(input) {
    const numId = Number(input.id);
    if (!Number.isFinite(numId)) return null;
    const existing = await sqliteMethodChangeBackend.get(input.userId, input.instanceId, input.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    await db.update(methodChangeCandidates).set({
      status: input.status,
      decisionNote: input.decisionNote ?? null,
      confirmedAt: input.status === "confirmed" ? now : null,
      updatedAt: now,
    }).where(eq(methodChangeCandidates.id, numId));
    return { ...existing, status: input.status, decisionNote: input.decisionNote ?? null, confirmedAt: input.status === "confirmed" ? now : null, updatedAt: now };
  },

  async list(userId, instanceId, options) {
    const conditions: SQL[] = [
      eq(methodChangeCandidates.userId, userId),
      eq(methodChangeCandidates.instanceId, instanceId),
    ];
    if (options.status) {
      conditions.push(eq(methodChangeCandidates.status, options.status));
    }
    const rows = await db
      .select()
      .from(methodChangeCandidates)
      .where(and(...conditions))
      .orderBy(desc(methodChangeCandidates.createdAt))
      .limit(options.limit ?? 100);
    return rows.map(fromRow);
  },
};

// ============ Workspace 实现 ============

let workspaceInitialized = false;

async function ensureInitialized(userId: string): Promise<WorkspaceStore> {
  if (!workspaceInitialized) {
    await ensureWorkspace({ userId });
    workspaceInitialized = true;
  }
  return new WorkspaceStore(userId);
}

interface MethodChangeYamlRecord {
  candidate_id: string;
  user_id: string;
  instance_id: string;
  source_review_id?: string | null;
  source_type: string;
  proposed_change: string;
  reason: string;
  affected_resource: string;
  status: MethodChangeStatus;
  decision_note?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
}

function toYaml(rec: MethodChangeRecord): MethodChangeYamlRecord {
  return {
    candidate_id: rec.id,
    user_id: rec.userId,
    instance_id: rec.instanceId,
    source_review_id: rec.sourceReviewId ?? null,
    source_type: rec.sourceType,
    proposed_change: rec.proposedChange,
    reason: rec.reason,
    affected_resource: rec.affectedResource,
    status: rec.status,
    decision_note: rec.decisionNote ?? null,
    confirmed_at: rec.confirmedAt ?? null,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

function fromYaml(rec: MethodChangeYamlRecord): MethodChangeRecord {
  return {
    id: rec.candidate_id,
    userId: rec.user_id,
    instanceId: rec.instance_id,
    sourceReviewId: rec.source_review_id ?? null,
    sourceType: rec.source_type,
    proposedChange: rec.proposed_change,
    reason: rec.reason,
    affectedResource: rec.affected_resource,
    status: rec.status,
    decisionNote: rec.decision_note ?? null,
    confirmedAt: rec.confirmed_at ?? null,
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
  };
}

export const workspaceMethodChangeBackend: MethodChangeBackend = {
  async propose(input) {
    const store = await ensureInitialized(input.userId);
    const now = new Date().toISOString();
    const rec: MethodChangeRecord = {
      id: randomUUID(),
      userId: input.userId,
      instanceId: input.instanceId,
      sourceReviewId: input.sourceReviewId ?? null,
      sourceType: input.sourceType || "review",
      proposedChange: input.proposedChange,
      reason: input.reason,
      affectedResource: input.affectedResource || "methodology_profile",
      status: "proposed",
      decisionNote: input.decisionNote ?? null,
      confirmedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await store.appendMethodChange(toYaml(rec));
    return rec;
  },

  async get(userId, _instanceId, id) {
    const store = await ensureInitialized(userId);
    const all = await store.listMethodChanges<MethodChangeYamlRecord>({});
    const hit = all.find((r) => r.candidate_id === id);
    return hit ? fromYaml(hit) : null;
  },

  async decide(input) {
    const store = await ensureInitialized(input.userId);
    const existing = await workspaceMethodChangeBackend.get(input.userId, input.instanceId, input.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: MethodChangeRecord = {
      ...existing,
      status: input.status,
      decisionNote: input.decisionNote ?? null,
      confirmedAt: input.status === "confirmed" ? now : null,
      updatedAt: now,
    };
    // append 一条新版本,listMethodChanges 会按 candidate_id 取最新
    await store.appendMethodChange(toYaml(updated));
    return updated;
  },

  async list(userId, _instanceId, options) {
    const store = await ensureInitialized(userId);
    const all = await store.listMethodChanges<MethodChangeYamlRecord>({
      status: options.status,
      limit: options.limit,
    });
    return all.map(fromYaml);
  },
};

// ============ 出口:由 WORKSPACE_BACKEND 选择 ============

function selectBackend(kind: BackendKind): MethodChangeBackend {
  return kind === "workspace" ? workspaceMethodChangeBackend : sqliteMethodChangeBackend;
}

export const methodChangeBackend: MethodChangeBackend = selectBackend(ACTIVE_BACKEND);

export function __resetMethodChangeBackendWorkspaceInitCache(): void {
  workspaceInitialized = false;
}
