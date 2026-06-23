/**
 * 复盘观点(review_viewpoints)后端抽象(WP4.8,2026-06-21)。
 *
 * 与 portfolio/watchlist/plan/daily-plan/method-change 同样的双轨模式,通过 WORKSPACE_BACKEND 切换:
 *   - "sqlite"(默认):行为不变,读写 review_viewpoints 表
 *   - "workspace":读写 memory/review_viewpoints.jsonl(read-modify-write 模式)
 *
 * 设计:jsonl 不是 append-only,而是 read-modify-write。
 * 业务复合 key = `${sourceDate}#${viewpointId}`,因为:
 *   - viewpointId 是用户手写(如 "v1"),跨日期可能重复
 *   - syncReviewViewpoints 是"按 sourceDate 整组替换"(重跑日复盘时,旧观点被新观点替换)
 *   - syncViewpointResolutions 是"按 viewpointId 更新状态"(原 SQLite 不带 sourceDate,宽容语义)
 *
 * review_viewpoints 是"state"(按 sourceDate 分组的最新状态),不是"event stream"。
 * 与 method_changes(append-only 版本快照)和 daily_plans(upsert by date yaml)是不同模式。
 */

import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { reviewViewpoints } from "../db/schema.js";
import { ensureWorkspace } from "./workspace.js";
import { WorkspaceStore } from "./workspace-store.js";
import { ACTIVE_BACKEND, type BackendKind } from "./data-backend.js";

export type ViewpointStatus = "open" | "validated" | "invalidated" | "pending";

export interface ReviewViewpointRecord {
  /** sqlite 路径有(rowId),workspace 路径用 composite key `${sourceDate}#${viewpointId}`。 */
  id: string;
  userId: string;
  instanceId: string;
  sourceDate: string;
  viewpointId: string;
  view: string;
  reason: string;
  action: string;
  validation: string;
  expectedReviewDate: string;
  status: ViewpointStatus;
  resolution?: string | null;
  resolvedAt?: string | null;
  /** WP5.1 扩展:观点失效信号(用于周复盘自动回测)。空数组表示未声明。 */
  invalidationSignals: string[];
  /** WP5.1 扩展:置信度,对齐 decision_record schema。默认 "unknown"。 */
  confidence: "unknown" | "low" | "medium" | "high";
  /** WP5.1 扩展:任务类型,对齐 decision_record schema。默认 "daily_review"。 */
  taskType: string;
  /** WP5.1 扩展:决策类型,对齐 decision_record schema。默认 "viewpoint"。 */
  decisionType: string;
  createdAt: string;
  updatedAt: string;
}

/** 业务字段(无 id / 状态字段),供 replaceByDate 接收。 */
export interface ViewpointDraft {
  viewpointId: string;
  view: string;
  reason: string;
  action: string;
  validation: string;
  expectedReviewDate: string;
  /** WP5.1 扩展:可选失效信号。不传默认空数组。 */
  invalidationSignals?: string[];
  /** WP5.1 扩展:可选置信度。不传默认 "unknown"。 */
  confidence?: "unknown" | "low" | "medium" | "high";
}

export interface ReplaceByDateInput {
  userId: string;
  instanceId: string;
  sourceDate: string;
  /** 该 sourceDate 下要保留的全部 viewpoints,会替换原有同 sourceDate 的所有记录。 */
  viewpoints: ViewpointDraft[];
}

export interface ResolveInput {
  userId: string;
  instanceId: string;
  viewpointId: string;
  /** 可选:精确匹配的 sourceDate。不传则按 viewpointId 找最新一条(兼容原 SQLite 宽容语义)。 */
  sourceDate?: string;
  status: "validated" | "invalidated" | "pending";
  resolution?: string | null;
}

export interface ListOptions {
  status?: ViewpointStatus;
  sourceDateFrom?: string;
  sourceDateTo?: string;
  expectedReviewDateTo?: string;
  limit?: number;
}

export interface ReviewViewpointBackend {
  /** 按 sourceDate 整组替换:删除该 sourceDate 全部记录,再插入 viewpoints。空数组相当于清空当天。 */
  replaceByDate(input: ReplaceByDateInput): Promise<ReviewViewpointRecord[]>;
  /** 按 viewpointId 更新状态(原 SQLite 行为)。sourceDate 可选精确匹配。 */
  resolve(input: ResolveInput): Promise<ReviewViewpointRecord | null>;
  /** 列表查询,支持 status / sourceDate 范围 / expectedReviewDate 过滤,按 sourceDate desc + viewpointId desc。 */
  list(userId: string, instanceId: string, options: ListOptions): Promise<ReviewViewpointRecord[]>;
}

// ============ SQLite 实现 ============

function fromRow(row: typeof reviewViewpoints.$inferSelect): ReviewViewpointRecord {
  // SQLite 表里没有 invalidation_signals/confidence/task_type/decision_type 列(WP5.1 字段扩展不动 schema),
  // 读出来时给默认值,与 workspace 路径行为对齐。
  return {
    id: String(row.id),
    userId: row.userId,
    instanceId: row.instanceId,
    sourceDate: row.sourceDate,
    viewpointId: row.viewpointId,
    view: row.view,
    reason: row.reason,
    action: row.action,
    validation: row.validation,
    expectedReviewDate: row.expectedReviewDate,
    status: row.status as ViewpointStatus,
    resolution: row.resolution,
    resolvedAt: row.resolvedAt,
    invalidationSignals: [],
    confidence: "unknown",
    taskType: "daily_review",
    decisionType: "viewpoint",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const sqliteReviewViewpointBackend: ReviewViewpointBackend = {
  async replaceByDate(input) {
    const now = new Date().toISOString();
    await db
      .delete(reviewViewpoints)
      .where(and(
        eq(reviewViewpoints.userId, input.userId),
        eq(reviewViewpoints.instanceId, input.instanceId),
        eq(reviewViewpoints.sourceDate, input.sourceDate),
      ));
    if (input.viewpoints.length === 0) return [];
    const rows = await db
      .insert(reviewViewpoints)
      .values(input.viewpoints.map((v) => ({
        userId: input.userId,
        instanceId: input.instanceId,
        sourceDate: input.sourceDate,
        viewpointId: v.viewpointId,
        view: v.view,
        reason: v.reason,
        action: v.action,
        validation: v.validation,
        expectedReviewDate: v.expectedReviewDate,
        status: "open" as const,
        createdAt: now,
        updatedAt: now,
      })))
      .returning();
    // SQLite 路径返回的 record 不带 invalidationSignals/confidence 等扩展字段(表里没存),
    // 但 fromRow 会给默认值。如果调用方传了 draft 的扩展字段,这里需要透传回去(避免调用方写完读不到)。
    return rows.map((row, idx) => {
      const base = fromRow(row);
      const draft = input.viewpoints[idx];
      return {
        ...base,
        invalidationSignals: draft.invalidationSignals ?? [],
        confidence: draft.confidence ?? "unknown",
      };
    });
  },

  async resolve(input) {
    const conditions: SQL[] = [
      eq(reviewViewpoints.userId, input.userId),
      eq(reviewViewpoints.instanceId, input.instanceId),
      eq(reviewViewpoints.viewpointId, input.viewpointId),
    ];
    if (input.sourceDate) {
      conditions.push(eq(reviewViewpoints.sourceDate, input.sourceDate));
    }
    const candidates = await db
      .select()
      .from(reviewViewpoints)
      .where(and(...conditions))
      .orderBy(desc(reviewViewpoints.sourceDate), desc(reviewViewpoints.id))
      .limit(1);
    if (candidates.length === 0) return null;
    const target = candidates[0];
    const now = new Date().toISOString();
    await db
      .update(reviewViewpoints)
      .set({
        status: input.status,
        resolution: input.resolution ?? null,
        resolvedAt: input.status === "pending" ? null : now,
        updatedAt: now,
      })
      .where(eq(reviewViewpoints.id, target.id));
    return {
      ...fromRow(target),
      status: input.status,
      resolution: input.resolution ?? null,
      resolvedAt: input.status === "pending" ? null : now,
      updatedAt: now,
    };
  },

  async list(userId, instanceId, options) {
    const conditions: SQL[] = [
      eq(reviewViewpoints.userId, userId),
      eq(reviewViewpoints.instanceId, instanceId),
    ];
    if (options.status) {
      conditions.push(eq(reviewViewpoints.status, options.status));
    }
    if (options.sourceDateFrom) {
      conditions.push(gte(reviewViewpoints.sourceDate, options.sourceDateFrom));
    }
    if (options.sourceDateTo) {
      conditions.push(lte(reviewViewpoints.sourceDate, options.sourceDateTo));
    }
    if (options.expectedReviewDateTo) {
      conditions.push(lte(reviewViewpoints.expectedReviewDate, options.expectedReviewDateTo));
    }
    const rows = await db
      .select()
      .from(reviewViewpoints)
      .where(and(...conditions))
      .orderBy(desc(reviewViewpoints.sourceDate), desc(reviewViewpoints.id))
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

interface ReviewViewpointYamlRecord {
  viewpoint_key: string;  // composite key `${sourceDate}#${viewpointId}`
  user_id: string;
  instance_id: string;
  source_date: string;
  viewpoint_id: string;
  view: string;
  reason: string;
  action: string;
  validation: string;
  expected_review_date: string;
  status: ViewpointStatus;
  resolution?: string | null;
  resolved_at?: string | null;
  /** WP5.1 扩展:观点失效信号。 */
  invalidation_signals?: string[];
  /** WP5.1 扩展:置信度。 */
  confidence?: "unknown" | "low" | "medium" | "high";
  /** WP5.1 扩展:任务类型。 */
  task_type?: string;
  /** WP5.1 扩展:决策类型。 */
  decision_type?: string;
  created_at: string;
  updated_at: string;
}

function compositeKey(sourceDate: string, viewpointId: string): string {
  return `${sourceDate}#${viewpointId}`;
}

function toYaml(rec: ReviewViewpointRecord): ReviewViewpointYamlRecord {
  return {
    viewpoint_key: compositeKey(rec.sourceDate, rec.viewpointId),
    user_id: rec.userId,
    instance_id: rec.instanceId,
    source_date: rec.sourceDate,
    viewpoint_id: rec.viewpointId,
    view: rec.view,
    reason: rec.reason,
    action: rec.action,
    validation: rec.validation,
    expected_review_date: rec.expectedReviewDate,
    status: rec.status,
    resolution: rec.resolution ?? null,
    resolved_at: rec.resolvedAt ?? null,
    invalidation_signals: rec.invalidationSignals,
    confidence: rec.confidence,
    task_type: rec.taskType,
    decision_type: rec.decisionType,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
  };
}

function fromYaml(rec: ReviewViewpointYamlRecord): ReviewViewpointRecord {
  return {
    id: rec.viewpoint_key,
    userId: rec.user_id,
    instanceId: rec.instance_id,
    sourceDate: rec.source_date,
    viewpointId: rec.viewpoint_id,
    view: rec.view,
    reason: rec.reason,
    action: rec.action,
    validation: rec.validation,
    expectedReviewDate: rec.expected_review_date,
    status: rec.status,
    resolution: rec.resolution ?? null,
    resolvedAt: rec.resolved_at ?? null,
    // 兼容老记录(扩展字段未写入)
    invalidationSignals: rec.invalidation_signals ?? [],
    confidence: rec.confidence ?? "unknown",
    taskType: rec.task_type ?? "daily_review",
    decisionType: rec.decision_type ?? "viewpoint",
    createdAt: rec.created_at,
    updatedAt: rec.updated_at,
  };
}

export const workspaceReviewViewpointBackend: ReviewViewpointBackend = {
  async replaceByDate(input) {
    const store = await ensureInitialized(input.userId);
    const all = await store.readReviewViewpoints<ReviewViewpointYamlRecord>();
    // 过滤掉该 sourceDate 的旧记录,保留其他日期的
    const kept = all.filter((r) => r.source_date !== input.sourceDate);
    // 追加新记录
    const now = new Date().toISOString();
    const added: ReviewViewpointYamlRecord[] = input.viewpoints.map((v) => ({
      viewpoint_key: compositeKey(input.sourceDate, v.viewpointId),
      user_id: input.userId,
      instance_id: input.instanceId,
      source_date: input.sourceDate,
      viewpoint_id: v.viewpointId,
      view: v.view,
      reason: v.reason,
      action: v.action,
      validation: v.validation,
      expected_review_date: v.expectedReviewDate,
      status: "open" as const,
      resolution: null,
      resolved_at: null,
      // WP5.1 扩展字段
      invalidation_signals: v.invalidationSignals ?? [],
      confidence: v.confidence ?? "unknown",
      task_type: "daily_review",
      decision_type: "viewpoint",
      created_at: now,
      updated_at: now,
    }));
    await store.writeReviewViewpoints([...kept, ...added]);
    return added.map(fromYaml);
  },

  async resolve(input) {
    const store = await ensureInitialized(input.userId);
    const all = await store.readReviewViewpoints<ReviewViewpointYamlRecord>();
    // 找出匹配 viewpointId 的候选,按 sourceDate desc 排序取最新
    const candidates = all
      .filter((r) =>
        r.user_id === input.userId
        && r.instance_id === input.instanceId
        && r.viewpoint_id === input.viewpointId
        && (!input.sourceDate || r.source_date === input.sourceDate)
      )
      .sort((a, b) => b.source_date.localeCompare(a.source_date));
    if (candidates.length === 0) return null;
    const target = candidates[0];
    const now = new Date().toISOString();
    const updated: ReviewViewpointYamlRecord = {
      ...target,
      status: input.status,
      resolution: input.resolution ?? null,
      resolved_at: input.status === "pending" ? null : now,
      updated_at: now,
    };
    // 全量重写:用 updated 替换 target(viewpoint_key 一致)
    const next = all.map((r) => r.viewpoint_key === target.viewpoint_key ? updated : r);
    await store.writeReviewViewpoints(next);
    return fromYaml(updated);
  },

  async list(userId, _instanceId, options) {
    const store = await ensureInitialized(userId);
    const all = await store.readReviewViewpoints<ReviewViewpointYamlRecord>();
    let filtered = all.filter((r) => {
      if (options.status && r.status !== options.status) return false;
      if (options.sourceDateFrom && r.source_date < options.sourceDateFrom) return false;
      if (options.sourceDateTo && r.source_date > options.sourceDateTo) return false;
      if (options.expectedReviewDateTo && r.expected_review_date > options.expectedReviewDateTo) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const cmp = b.source_date.localeCompare(a.source_date);
      if (cmp !== 0) return cmp;
      return b.viewpoint_id.localeCompare(a.viewpoint_id);
    });
    if (options.limit) {
      filtered = filtered.slice(0, options.limit);
    }
    return filtered.map(fromYaml);
  },
};

// ============ 出口:由 WORKSPACE_BACKEND 选择 ============

function selectBackend(kind: BackendKind): ReviewViewpointBackend {
  return kind === "workspace" ? workspaceReviewViewpointBackend : sqliteReviewViewpointBackend;
}

export const reviewViewpointBackend: ReviewViewpointBackend = selectBackend(ACTIVE_BACKEND);

export function __resetReviewViewpointBackendWorkspaceInitCache(): void {
  workspaceInitialized = false;
}
