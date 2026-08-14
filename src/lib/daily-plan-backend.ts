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
import { db, sqlite } from "../db/index.js";
import { dailyPlans } from "../db/schema.js";
import { ensureWorkspace } from "./workspace.js";
import { WorkspaceStore, type DailyPlanYaml } from "./workspace-store.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "./user-context.js";
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

/**
 * Mastra service-owned read projection. Imported daily plans live in the
 * review/memory ledger; this adapter never reads or creates a Workspace file.
 */
export const mastraDailyPlanBackend: DailyPlanBackend = {
  async upsert(userId, instanceId, plan) {
    const now = new Date().toISOString();
    const payload = JSON.stringify({
      plan_date: plan.planDate,
      generated_at: plan.generatedAt,
      summary: plan.summary ?? null,
      content: plan.content,
      data: plan.data ?? null,
    });
    const projectId = process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
    sqlite.transaction(() => {
      const existing = sqlite.prepare(
        "SELECT record_id AS recordId FROM mastra_review_memory_records WHERE user_id = ? AND project_id = ? AND instance_id = ? AND record_type = 'daily_plan' AND business_key = ? LIMIT 1",
      ).get(userId, projectId, instanceId, plan.planDate) as { recordId?: string } | undefined;
      if (existing?.recordId) {
        sqlite.prepare(
          "UPDATE mastra_review_memory_records SET payload_json = ?, source_path = ?, source_checksum = ?, migration_batch_id = ?, created_at = ? WHERE record_id = ? AND user_id = ? AND project_id = ? AND instance_id = ?",
        ).run(payload, "service-owned://daily-plans", `service:${now}`, "service-owned", now, existing.recordId, userId, projectId, instanceId);
      } else {
        sqlite.prepare(
          "INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_line,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(`daily-plan-${userId}-${instanceId}-${plan.planDate}`, userId, projectId, instanceId, "daily_plan", plan.planDate, payload, "service-owned://daily-plans", null, `service:${now}`, "service-owned", now);
      }
    })();
  },

  async get(userId, instanceId, planDate) {
    const record = await readMastraDailyPlan(userId, instanceId, planDate);
    return record;
  },

  async getPrevious(userId, instanceId, beforeDate) {
    const rows = readMastraDailyRows(userId, instanceId)
      .filter((row) => row.planDate < beforeDate)
      .sort((a, b) => b.planDate.localeCompare(a.planDate));
    return rows[0] || null;
  },

  async listInRange(userId, instanceId, startDate, endDate) {
    return readMastraDailyRows(userId, instanceId)
      .filter((row) => row.planDate >= startDate && row.planDate <= endDate)
      .sort((a, b) => b.planDate.localeCompare(a.planDate));
  },

  async getLatest(userId, instanceId) {
    return readMastraDailyRows(userId, instanceId)
      .sort((a, b) => b.planDate.localeCompare(a.planDate))[0] || null;
  },
};

function readMastraDailyRows(userId: string, instanceId: string): DailyPlanRecord[] {
  const rows = sqlite
    .prepare(
      "SELECT payload_json AS payloadJson FROM mastra_review_memory_records " +
        "WHERE user_id = ? AND project_id = ? AND instance_id = ? AND record_type = 'daily_plan'",
    )
    .all(userId, process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID, instanceId) as Array<{ payloadJson: string }>;
  return rows.map((row) => parseMastraDailyPayload(row.payloadJson));
}

async function readMastraDailyPlan(userId: string, instanceId: string, planDate: string): Promise<DailyPlanRecord | null> {
  return readMastraDailyRows(userId, instanceId).find((row) => row.planDate === planDate) || null;
}

function parseMastraDailyPayload(raw: string): DailyPlanRecord {
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (
      !payload ||
      typeof payload.plan_date !== "string" ||
      typeof payload.generated_at !== "string" ||
      typeof payload.content !== "string"
    ) {
      throw new Error("daily plan payload is missing required fields");
    }
    return {
      planDate: payload.plan_date,
      generatedAt: payload.generated_at,
      summary: typeof payload.summary === "string" ? payload.summary : null,
      content: payload.content,
      data: payload.data ?? null,
    };
  } catch (error) {
    throw new Error(`MASTRA_PROJECTION_INVALID: daily plan payload is invalid: ${(error as Error).message}`);
  }
}

// ============ 出口:由 WORKSPACE_BACKEND 选择 ============

function selectBackend(kind: BackendKind): DailyPlanBackend {
  return kind === "workspace" ? workspaceDailyPlanBackend : kind === "mastra" ? mastraDailyPlanBackend : sqliteDailyPlanBackend;
}

export const dailyPlanBackend: DailyPlanBackend = selectBackend(ACTIVE_BACKEND);

// 便于测试时按需重置缓存(workspace 初始化只一次)。
export function __resetDailyPlanBackendWorkspaceInitCache(): void {
  workspaceInitialized = false;
}

export { DEFAULT_USER_ID, DEFAULT_INSTANCE_ID };
