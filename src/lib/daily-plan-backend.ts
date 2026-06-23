/**
 * 日级预案/复盘产物后端抽象(WP4.7,2026-06-21)。
 *
 * 与 portfolio/watchlist/plan 同样的双轨模式,通过 WORKSPACE_BACKEND 切换:
 *   - "sqlite"(默认):行为不变,读写 daily_plans 表
 *   - "workspace":读写 plans/daily/<date>.yaml
 *
 * daily_plans 语义是"每 date 一份 upsert 状态"(非事件流),所以 workspace 用 yaml 而非 jsonl。
 * data 字段在 SQLite 是 JSON 字符串,workspace 下直接嵌套对象。
 */

import { and, desc, eq, gte, lt, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { dailyPlans } from "../db/schema.js";
import { ensureWorkspace } from "./workspace.js";
import { WorkspaceStore, type DailyPlanYaml } from "./workspace-store.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "./user-context.js";
import { ACTIVE_BACKEND, type BackendKind } from "./data-backend.js";

export interface DailyPlanRecord {
  planDate: string;
  generatedAt: string;
  summary?: string | null;
  content: string;
  /** 结构化元数据。SQLite 路径下从 JSON 反序列化失败则为 null。 */
  data: unknown;
}

export interface DailyPlanBackend {
  /** upsert by (userId, instanceId, planDate)。 */
  upsert(userId: string, instanceId: string, plan: DailyPlanRecord): Promise<void>;
  /** 精确按 planDate 读。 */
  get(userId: string, instanceId: string, planDate: string): Promise<DailyPlanRecord | null>;
  /** 取 planDate < beforeDate 的最新一条。 */
  getPrevious(userId: string, instanceId: string, beforeDate: string): Promise<DailyPlanRecord | null>;
  /** 取 [startDate, endDate] 闭区间所有记录,按 planDate 倒序。 */
  listInRange(userId: string, instanceId: string, startDate: string, endDate: string): Promise<DailyPlanRecord[]>;
  /** 取最新一条。 */
  getLatest(userId: string, instanceId: string): Promise<DailyPlanRecord | null>;
}

// ============ SQLite 实现 ============

function safeJsonParse(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fromRow(row: typeof dailyPlans.$inferSelect): DailyPlanRecord {
  return {
    planDate: row.planDate,
    generatedAt: row.generatedAt,
    summary: row.summary,
    content: row.content,
    data: safeJsonParse(row.data),
  };
}

export const sqliteDailyPlanBackend: DailyPlanBackend = {
  async upsert(userId, instanceId, plan) {
    const existing = await db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceId), eq(dailyPlans.planDate, plan.planDate)))
      .limit(1);
    const values = {
      userId,
      instanceId,
      planDate: plan.planDate,
      generatedAt: plan.generatedAt,
      summary: plan.summary ?? null,
      content: plan.content,
      data: JSON.stringify(plan.data ?? null),
    };
    if (existing.length > 0) {
      await db.update(dailyPlans).set(values).where(eq(dailyPlans.id, existing[0].id));
    } else {
      await db.insert(dailyPlans).values(values);
    }
  },

  async get(userId, instanceId, planDate) {
    const rows = await db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceId), eq(dailyPlans.planDate, planDate)))
      .limit(1);
    return rows.length > 0 ? fromRow(rows[0]) : null;
  },

  async getPrevious(userId, instanceId, beforeDate) {
    const rows = await db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceId), lt(dailyPlans.planDate, beforeDate)))
      .orderBy(desc(dailyPlans.planDate), desc(dailyPlans.generatedAt))
      .limit(1);
    return rows.length > 0 ? fromRow(rows[0]) : null;
  },

  async listInRange(userId, instanceId, startDate, endDate) {
    const rows = await db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceId), gte(dailyPlans.planDate, startDate), lte(dailyPlans.planDate, endDate)))
      .orderBy(desc(dailyPlans.planDate));
    return rows.map(fromRow);
  },

  async getLatest(userId, instanceId) {
    const rows = await db
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.instanceId, instanceId)))
      .orderBy(desc(dailyPlans.planDate))
      .limit(1);
    return rows.length > 0 ? fromRow(rows[0]) : null;
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

function fromYaml(yaml: DailyPlanYaml): DailyPlanRecord {
  return {
    planDate: yaml.plan_date,
    generatedAt: yaml.generated_at,
    summary: yaml.summary ?? null,
    content: yaml.content,
    data: yaml.data ?? null,
  };
}

export const workspaceDailyPlanBackend: DailyPlanBackend = {
  async upsert(userId, _instanceId, plan) {
    const store = await ensureInitialized(userId);
    await store.writeDailyPlan({
      plan_date: plan.planDate,
      generated_at: plan.generatedAt,
      summary: plan.summary ?? undefined,
      content: plan.content,
      data: plan.data ?? undefined,
    });
  },

  async get(userId, _instanceId, planDate) {
    const store = await ensureInitialized(userId);
    const yaml = await store.readDailyPlan(planDate);
    return yaml ? fromYaml(yaml) : null;
  },

  async getPrevious(userId, _instanceId, beforeDate) {
    const store = await ensureInitialized(userId);
    const list = await store.listDailyPlans({ endDate: beforeDate, limit: 100 });
    // 取严格小于 beforeDate 的第一条(listDailyPlans 已按倒序)
    const hit = list.find((p) => p.plan_date < beforeDate);
    return hit ? fromYaml(hit) : null;
  },

  async listInRange(userId, _instanceId, startDate, endDate) {
    const store = await ensureInitialized(userId);
    const list = await store.listDailyPlans({ startDate, endDate });
    return list.map(fromYaml);
  },

  async getLatest(userId, _instanceId) {
    const store = await ensureInitialized(userId);
    const list = await store.listDailyPlans({ limit: 1 });
    return list.length > 0 ? fromYaml(list[0]) : null;
  },
};

// ============ 出口:由 WORKSPACE_BACKEND 选择 ============

function selectBackend(kind: BackendKind): DailyPlanBackend {
  return kind === "workspace" ? workspaceDailyPlanBackend : sqliteDailyPlanBackend;
}

export const dailyPlanBackend: DailyPlanBackend = selectBackend(ACTIVE_BACKEND);

// 便于测试时按需重置缓存(workspace 初始化只一次)。
export function __resetDailyPlanBackendWorkspaceInitCache(): void {
  workspaceInitialized = false;
}

export { DEFAULT_USER_ID, DEFAULT_INSTANCE_ID };
