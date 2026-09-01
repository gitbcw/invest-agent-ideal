/**
 * Service-owned backend for the Mastra portfolio projection.
 *
 * The projection intentionally preserves the complete imported YAML payload;
 * this adapter exposes the legacy row-shaped interfaces to callers while the
 * migration branch converges. Missing projections behave like a fresh
 * WorkspaceStore: reads return empty defaults and writes lazily create the
 * row, so brand-new users get the same tool and scheduler behavior as the
 * workspace backend instead of a hard projection failure.
 */
import { randomUUID } from "node:crypto";
import { sqlite } from "../db/index.js";
import { beijingDateKey } from "./market-calendar.js";
import type { PlanBackend, PlanRow, PortfolioBackend, PortfolioRow, TradeActionRow, WatchlistBackend, WatchlistRow } from "./data-backend.js";
import { upsertReviewMemoryRecord } from "./review-memory-store.js";

type Scope = { userId: string; instanceId: string };
type Projection = {
  cash?: unknown;
  holdings?: unknown;
  watchlist?: unknown;
  stockPlans?: unknown;
};

export function getMastraPortfolioRevision(userId: string, instanceId: string): string | null {
  const row = sqlite.prepare("SELECT source_revision AS sourceRevision FROM mastra_portfolio_states WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1").get(userId, projectId(), instanceId) as { sourceRevision?: string | null } | undefined;
  return row?.sourceRevision ?? null;
}

export function readMastraPortfolioProjection(userId: string, instanceId: string): Projection {
  return readProjection({ userId, instanceId });
}

/** Revisions are stored with mixed timezone spellings (Z vs +08:00) for the
 * same instant, so equality must compare parsed instants, never raw strings. */
export function isSameRevisionInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

export function replaceMastraPortfolioProjection(userId: string, instanceId: string, next: Projection, expectedRevision: string | null): string {
  const now = new Date().toISOString();
  sqlite.transaction(() => {
    const row = sqlite.prepare("SELECT source_revision AS sourceRevision FROM mastra_portfolio_states WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1").get(userId, projectId(), instanceId) as { sourceRevision?: string | null } | undefined;
    const currentRevision = row?.sourceRevision ?? null;
    if (!isSameRevisionInstant(currentRevision, expectedRevision)) throw new MastraProjectionError("MASTRA_REVISION_CONFLICT", `MASTRA_REVISION_CONFLICT: expected ${expectedRevision ?? "null"}, current ${currentRevision ?? "null"}`);
    if (row) {
      sqlite.prepare("UPDATE mastra_portfolio_states SET portfolio_json = ?, source_path = ?, source_checksum = ?, source_revision = ?, updated_at = ? WHERE user_id = ? AND project_id = ? AND instance_id = ?").run(JSON.stringify(next), "service-owned://portfolio", `service:${now}`, now, now, userId, projectId(), instanceId);
    } else {
      sqlite.prepare("INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(userId, projectId(), instanceId, JSON.stringify(next), "service-owned://portfolio", `service:${now}`, now, "service-owned", now, now);
    }
  })();
  return now;
}

export class MastraProjectionError extends Error {
  constructor(readonly code: "MASTRA_PROJECTION_NOT_FOUND" | "MASTRA_PROJECTION_INVALID" | "MASTRA_BACKEND_READ_ONLY" | "MASTRA_REVISION_CONFLICT", message: string) {
    super(message);
    this.name = "MastraProjectionError";
  }
}

function projectId(): string {
  return process.env.MASTRA_PROJECT_ID?.trim() || "invest-agent";
}

function readProjection(scope: Scope): Projection {
  const row = sqlite.prepare(
    "SELECT portfolio_json AS portfolioJson FROM mastra_portfolio_states WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
  ).get(scope.userId, projectId(), scope.instanceId) as { portfolioJson?: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(String(row.portfolioJson));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("projection is not an object");
    return parsed as Projection;
  } catch (error) {
    throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", `Mastra portfolio projection is invalid: ${(error as Error).message}`);
  }
}

function records(value: unknown, label: string): Record<string, any>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", `Mastra ${label} projection is not a list of objects`);
  }
  return value as Record<string, any>[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | null | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : value == null ? null : undefined;
}

function readOnly(): never {
  throw new MastraProjectionError("MASTRA_BACKEND_READ_ONLY", "MASTRA_BACKEND_READ_ONLY: Mastra projection backend is read-only until service-owned mutation transactions are enabled");
}

function mutateProjection(scope: Scope, mutate: (projection: Projection) => void, expectedRevision?: string | null): Projection {
  const now = new Date().toISOString();
  return sqlite.transaction(() => {
    const row = sqlite.prepare(
      "SELECT portfolio_json AS portfolioJson, source_revision AS sourceRevision FROM mastra_portfolio_states WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1",
    ).get(scope.userId, projectId(), scope.instanceId) as { portfolioJson?: string; sourceRevision?: string | null } | undefined;
    const currentRevision = row?.sourceRevision ?? null;
    if (expectedRevision !== undefined && !isSameRevisionInstant(expectedRevision, currentRevision)) {
      throw new MastraProjectionError("MASTRA_REVISION_CONFLICT", `MASTRA_REVISION_CONFLICT: expected ${expectedRevision ?? "null"}, current ${currentRevision ?? "null"}`);
    }
    let projection: Projection;
    if (!row) {
      projection = {};
    } else {
      try {
        projection = JSON.parse(String(row.portfolioJson)) as Projection;
        if (!projection || typeof projection !== "object" || Array.isArray(projection)) throw new Error("projection is not an object");
      } catch (error) {
        throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", `MASTRA_PROJECTION_INVALID: ${(error as Error).message}`);
      }
    }
    mutate(projection);
    if (row) {
      sqlite.prepare(
        "UPDATE mastra_portfolio_states SET portfolio_json = ?, source_path = ?, source_checksum = ?, source_revision = ?, updated_at = ? WHERE user_id = ? AND project_id = ? AND instance_id = ?",
      ).run(JSON.stringify(projection), "service-owned://portfolio", `service:${now}`, now, now, scope.userId, projectId(), scope.instanceId);
    } else {
      sqlite.prepare(
        "INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(scope.userId, projectId(), scope.instanceId, JSON.stringify(projection), "service-owned://portfolio", `service:${now}`, now, "service-owned", now, now);
    }
    return projection;
  })();
}

function appendTradeAction(action: TradeActionRow): void {
  // Trade confirmations are an event stream: each confirmation carries a fresh
  // UUID in its business key, so the shared upsert always takes the insert path.
  upsertReviewMemoryRecord({
    userId: action.userId,
    projectId: projectId(),
    instanceId: action.instanceId,
    recordType: "service_event",
    businessKey: `trade:${action.code}:${action.createdAt}:${randomUUID()}`,
    recordId: `service-event-${randomUUID()}`,
    payload: { event_type: "action_confirmed", ...action },
    sourcePath: "service-owned://trade-actions",
  });
}

function holdingRow(row: Record<string, any>): PortfolioRow {
  const code = text(row.code);
  const name = text(row.name);
  if (!code || !name) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", "Mastra holding is missing code or name");
  const closed = row.status === "closed" || row.sell_date != null || row.sellDate != null;
  return {
    code,
    name,
    buyDate: text(row.buy_date) || text(row.buyDate) || "",
    costPrice: number(row.cost_price ?? row.costPrice ?? row.cost) ?? null,
    sellPrice: number(row.sell_price ?? row.sellPrice) ?? null,
    sellDate: text(row.sell_date) || text(row.sellDate) || null,
    status: closed ? "closed" : "open",
  };
}

function watchlistRow(row: Record<string, any>): WatchlistRow {
  const code = text(row.code);
  const name = text(row.name);
  if (!code || !name) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", "Mastra watchlist item is missing code or name");
  return {
    code,
    name,
    addedAt: text(row.added_at) || text(row.addedAt),
    reason: text(row.trigger) || text(row.reason) || null,
    source: text(row.source),
  };
}

function planRow(row: Record<string, any>): PlanRow {
  const code = text(row.code);
  const name = text(row.name);
  if (!code || !name) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", "Mastra stock plan is missing code or name");
  return {
    code,
    name,
    support: number(row.support) ?? null,
    resistance: number(row.resistance) ?? null,
    targetPrice: number(row.target_price ?? row.targetPrice) ?? null,
    stopLoss: number(row.stop_loss ?? row.stopLoss) ?? null,
    notes: text(row.notes) || null,
    watchConditions: row.watch_conditions ?? row.watchConditions,
    linkedAlertRuleIds: row.linked_alert_rule_ids ?? row.linkedAlertRuleIds,
    planType: text(row.plan_type) || text(row.planType),
    strategyKey: text(row.strategy_key) || text(row.strategyKey) || null,
    updatedAt: text(row.updated_at) || text(row.updatedAt),
  };
}

function scope(userId: string, instanceId: string): Scope { return { userId, instanceId }; }

export const mastraPortfolioBackend: PortfolioBackend = {
  async listActive(userId, instanceId) {
    return records(readProjection(scope(userId, instanceId)).holdings, "holdings").map(holdingRow).filter((row) => row.status === "open");
  },
  async listAll(userId, instanceId) {
    return records(readProjection(scope(userId, instanceId)).holdings, "holdings").map(holdingRow);
  },
  async findActive(userId, instanceId, code) {
    return (await this.listActive(userId, instanceId)).find((row) => row.code === code) || null;
  },
  async upsertActive(userId, instanceId, input) {
    const buyDate = input.buyDate ?? beijingDateKey();
    const next = mutateProjection(scope(userId, instanceId), (projection) => {
      const holdings = records(projection.holdings, "holdings");
      const existing = holdings.find((row) => text(row.code) === input.code && row.status !== "closed" && row.sell_date == null && row.sellDate == null);
      if (existing) {
        existing.name = input.name;
        existing.buy_date = buyDate;
        existing.cost_price = input.costPrice ?? null;
        existing.status = "open";
      } else {
        holdings.push({ name: input.name, code: input.code, buy_date: buyDate, cost_price: input.costPrice ?? null, sell_date: null, sell_price: null, status: "open" });
      }
      projection.holdings = holdings;
    }, input.expectedRevision);
    const row = records(next.holdings, "holdings").map(holdingRow).find((item) => item.code === input.code && item.status === "open");
    if (!row) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", "MASTRA_PROJECTION_INVALID: holding write did not produce a readable row");
    return row;
  },
  async markClosed(userId, instanceId, code, sellPrice, expectedRevision) {
    let changed = false;
    const next = mutateProjection(scope(userId, instanceId), (projection) => {
      const holdings = records(projection.holdings, "holdings");
      const existing = holdings.find((row) => text(row.code) === code && row.status !== "closed" && row.sell_date == null && row.sellDate == null);
      if (!existing) return;
      existing.sell_price = sellPrice ?? 0;
      existing.sell_date = beijingDateKey();
      existing.status = "closed";
      changed = true;
      projection.holdings = holdings;
    }, expectedRevision);
    if (!changed) return null;
    return records(next.holdings, "holdings").map(holdingRow).find((item) => item.code === code && item.status === "closed") || null;
  },
  async recordTradeAction(action) { appendTradeAction(action); },
};

export const mastraWatchlistBackend: WatchlistBackend = {
  async list(userId, instanceId) { return records(readProjection(scope(userId, instanceId)).watchlist, "watchlist").map(watchlistRow); },
  async find(userId, instanceId, code) { return (await this.list(userId, instanceId)).find((row) => row.code === code) || null; },
  async add(userId, instanceId, input) {
    const now = input.addedAt ?? new Date().toISOString();
    const next = mutateProjection(scope(userId, instanceId), (projection) => {
      const rows = records(projection.watchlist, "watchlist");
      if (rows.some((row) => text(row.code) === input.code)) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", `watchlist item already exists: ${input.code}`);
      rows.push({ code: input.code, name: input.name, trigger: input.reason, source: input.source ?? "manual", added_at: now });
      projection.watchlist = rows;
    }, input.expectedRevision);
    return records(next.watchlist, "watchlist").map(watchlistRow).find((row) => row.code === input.code)!;
  },
  async patch(userId, instanceId, code, patch) {
    let changed = false;
    const next = mutateProjection(scope(userId, instanceId), (projection) => {
      const rows = records(projection.watchlist, "watchlist");
      const row = rows.find((item) => text(item.code) === code);
      if (!row) return;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.reason !== undefined) row.trigger = patch.reason;
      if (patch.source !== undefined) row.source = patch.source;
      changed = true;
      projection.watchlist = rows;
    }, patch.expectedRevision);
    return changed ? records(next.watchlist, "watchlist").map(watchlistRow).find((row) => row.code === code) || null : null;
  },
  async remove(userId, instanceId, code, expectedRevision) {
    let removed: WatchlistRow | null = null;
    mutateProjection(scope(userId, instanceId), (projection) => {
      const rows = records(projection.watchlist, "watchlist");
      const index = rows.findIndex((item) => text(item.code) === code);
      if (index < 0) return;
      removed = watchlistRow(rows[index]);
      rows.splice(index, 1);
      projection.watchlist = rows;
    }, expectedRevision);
    return removed;
  },
};

export const mastraPlanBackend: PlanBackend = {
  async list(userId, instanceId) { return records(readProjection(scope(userId, instanceId)).stockPlans, "stock plans").map(planRow); },
  async find(userId, instanceId, code) { return (await this.list(userId, instanceId)).find((row) => row.code === code) || null; },
  async upsert(userId, instanceId, input) {
    const next = mutateProjection(scope(userId, instanceId), (projection) => {
      const rows = records(projection.stockPlans, "stock plans");
      const existing = rows.find((row) => text(row.code) === input.code);
      const value = {
        ...(existing ?? {}), code: input.code, name: input.name,
        support: input.support ?? null, resistance: input.resistance ?? null,
        target_price: input.targetPrice ?? null, stop_loss: input.stopLoss ?? null,
        notes: input.notes ?? null, watch_conditions: input.watchConditions,
        linked_alert_rule_ids: input.linkedAlertRuleIds, plan_type: input.planType ?? "manual",
        strategy_key: input.strategyKey ?? null, updated_at: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, value); else rows.push(value);
      projection.stockPlans = rows;
    }, input.expectedRevision);
    const row = records(next.stockPlans, "stock plans").map(planRow).find((item) => item.code === input.code);
    if (!row) throw new MastraProjectionError("MASTRA_PROJECTION_INVALID", "MASTRA_PROJECTION_INVALID: plan write did not produce a readable row");
    return row;
  },
  async remove(userId, instanceId, code, expectedRevision) {
    let removed: PlanRow | null = null;
    mutateProjection(scope(userId, instanceId), (projection) => {
      const rows = records(projection.stockPlans, "stock plans");
      const index = rows.findIndex((item) => text(item.code) === code);
      if (index < 0) return;
      removed = planRow(rows[index]);
      rows.splice(index, 1);
      projection.stockPlans = rows;
    }, expectedRevision);
    return removed;
  },
};
