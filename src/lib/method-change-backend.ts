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

import { and, desc, eq, gte, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { methodChangeCandidates } from "../db/schema.js";
import { ensureWorkspace } from "./workspace.js";
import { WorkspaceStore } from "./workspace-store.js";
import { ACTIVE_BACKEND, type BackendKind } from "./data-backend.js";
import { sqlite } from "../db/index.js";
import { upsertReviewMemoryRecord } from "./review-memory-store.js";

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
  /** 列出候选(去重版本,按 updated_at desc)。status 可选过滤。maxAgeDays 可选:仅返回 N 天内的候选,用于避免旧 proposed 候选污染 dashboard 上下文。 */
  list(userId: string, instanceId: string, options: { status?: MethodChangeStatus; limit?: number; maxAgeDays?: number }): Promise<MethodChangeRecord[]>;
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
    if (options.maxAgeDays && options.maxAgeDays > 0) {
      const cutoff = new Date(Date.now() - options.maxAgeDays * 24 * 3600 * 1000).toISOString();
      conditions.push(gte(methodChangeCandidates.createdAt, cutoff));
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

export const mastraMethodChangeBackend: MethodChangeBackend = {
  async propose(input) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const payload = {
      candidate_id: id, user_id: input.userId, instance_id: input.instanceId,
      source_review_id: input.sourceReviewId ?? null, source_type: input.sourceType || "review",
      proposed_change: input.proposedChange, reason: input.reason,
      affected_resource: input.affectedResource || "methodology_profile", status: "proposed",
      decision_note: input.decisionNote ?? null, confirmed_at: null, created_at: now, updated_at: now,
    };
    upsertReviewMemoryRecord({
      userId: input.userId,
      projectId: process.env.MASTRA_PROJECT_ID?.trim() || "invest-agent",
      instanceId: input.instanceId,
      recordType: "method_change_service_migration",
      businessKey: `service:${id}:${now}`,
      recordId: `method-change-${id}`,
      payload,
      sourcePath: "service-owned://method-changes",
    });
    return payloadToMethod(payload);
  },
  async get(userId, instanceId, id) {
    return mastraMethodChanges(userId, instanceId).find((row) => row.id === id) || null;
  },
  async decide(input) {
    const existing = await this.get(input.userId, input.instanceId, input.id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const payload = { candidate_id: existing.id, user_id: existing.userId, instance_id: existing.instanceId, source_review_id: existing.sourceReviewId, source_type: existing.sourceType, proposed_change: existing.proposedChange, reason: existing.reason, affected_resource: existing.affectedResource, status: input.status, decision_note: input.decisionNote ?? null, confirmed_at: input.status === "confirmed" ? now : null, created_at: existing.createdAt, updated_at: now };
    const projectId = process.env.MASTRA_PROJECT_ID?.trim() || "invest-agent";
    const existingLedger = sqlite.prepare("SELECT record_id AS recordId FROM mastra_review_memory_records WHERE user_id = ? AND project_id = ? AND instance_id = ? AND record_type = 'method_change_service_migration' AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1").get(input.userId, projectId, input.instanceId, `%%\"candidate_id\":\"${input.id}\"%%`) as { recordId?: string } | undefined;
    if (existingLedger?.recordId) {
      sqlite.prepare("UPDATE mastra_review_memory_records SET payload_json = ?, source_path = ?, source_checksum = ?, migration_batch_id = ?, created_at = ? WHERE record_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?").run(JSON.stringify(payload), "service-owned://method-changes", `service:${now}`, "service-owned", now, existingLedger.recordId, input.userId, projectId, input.instanceId);
    } else {
      upsertReviewMemoryRecord({
        userId: input.userId,
        projectId,
        instanceId: input.instanceId,
        recordType: "method_change_service_migration",
        businessKey: `service:${input.id}:${now}`,
        recordId: `method-change-${input.id}-${now}`,
        payload,
        sourcePath: "service-owned://method-changes",
      });
    }
    return payloadToMethod(payload);
  },
  async list(userId, instanceId, options) {
    let rows = mastraMethodChanges(userId, instanceId);
    if (options.status) rows = rows.filter((row) => row.status === options.status);
    if (options.maxAgeDays && options.maxAgeDays > 0) {
      const cutoff = Date.now() - options.maxAgeDays * 24 * 3600 * 1000;
      rows = rows.filter((row) => Date.parse(row.createdAt) >= cutoff);
    }
    return rows.slice(0, options.limit ?? 100);
  },
};

function mastraMethodChanges(userId: string, instanceId: string): MethodChangeRecord[] {
  const rows = sqlite.prepare(
    "SELECT business_key AS businessKey, payload_json AS payloadJson FROM mastra_review_memory_records " +
      "WHERE user_id = ? AND project_id = ? AND instance_id = ? AND record_type = 'method_change_service_migration' " +
      "ORDER BY created_at DESC, record_id DESC",
  ).all(userId, process.env.MASTRA_PROJECT_ID?.trim() || "invest-agent", instanceId) as Array<{ businessKey: string; payloadJson: string }>;
  const latest = new Map<string, MethodChangeRecord>();
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; } catch { continue; }
    const candidateId = typeof payload.candidate_id === "string" ? payload.candidate_id : undefined;
    if (!candidateId || payload.type === "template_init" || latest.has(candidateId)) continue;
    if (typeof payload.proposed_change !== "string" || typeof payload.reason !== "string") continue;
    const status = payload.status === "confirmed" || payload.status === "rejected" ? payload.status : "proposed";
    latest.set(candidateId, {
      id: candidateId,
      userId,
      instanceId,
      sourceReviewId: typeof payload.source_review_id === "string" ? payload.source_review_id : null,
      sourceType: typeof payload.source_type === "string" ? payload.source_type : "review",
      proposedChange: payload.proposed_change,
      reason: payload.reason,
      affectedResource: typeof payload.affected_resource === "string" ? payload.affected_resource : "methodology_profile",
      status,
      decisionNote: typeof payload.decision_note === "string" ? payload.decision_note : null,
      confirmedAt: typeof payload.confirmed_at === "string" ? payload.confirmed_at : null,
      createdAt: typeof payload.created_at === "string" ? payload.created_at : "",
      updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : "",
    });
  }
  return [...latest.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function payloadToMethod(payload: Record<string, any>): MethodChangeRecord {
  return { id: payload.candidate_id, userId: payload.user_id, instanceId: payload.instance_id, sourceReviewId: payload.source_review_id ?? null, sourceType: payload.source_type || "review", proposedChange: payload.proposed_change, reason: payload.reason, affectedResource: payload.affected_resource || "methodology_profile", status: payload.status === "confirmed" || payload.status === "rejected" ? payload.status : "proposed", decisionNote: payload.decision_note ?? null, confirmedAt: payload.confirmed_at ?? null, createdAt: payload.created_at || "", updatedAt: payload.updated_at || "" };
}

// ============ 出口:由 WORKSPACE_BACKEND 选择 ============

function selectBackend(kind: BackendKind): MethodChangeBackend {
  return mastraMethodChangeBackend; /* E8: mastra only */
}

export const methodChangeBackend: MethodChangeBackend = selectBackend(ACTIVE_BACKEND);

export function __resetMethodChangeBackendWorkspaceInitCache(): void {
  workspaceInitialized = false;
}
