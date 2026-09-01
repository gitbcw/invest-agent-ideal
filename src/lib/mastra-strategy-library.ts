/**
 * Service-owned trading-strategy library for the Mastra backend.
 *
 * Workspace keeps the library in `config/trading_strategies.yaml`; this module
 * stores the same TradingStrategy list inside the `mastra_project_profiles`
 * projection under a dedicated `tradingStrategies` sibling key. Reads fall
 * back to an empty list when no projection row exists, and every write merges
 * with the raw existing payload so sibling projection domains survive.
 */
import { sqlite } from "../db/index.js";
import { beijingDateKey } from "./market-calendar.js";
import { DEFAULT_PROJECT_ID } from "../lib/user-context.js";
import type { TradingStrategy } from "../lib/workspace-store.js";

export interface MastraStrategyLibraryScope {
  userId: string;
  instanceId: string;
  projectId?: string;
}

function resolveProjectId(scope: MastraStrategyLibraryScope): string {
  return scope.projectId || process.env.MASTRA_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
}

function readProfileObject(scope: MastraStrategyLibraryScope, projectId: string): Record<string, any> | null {
  const row = sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(scope.userId, projectId, scope.instanceId) as { value?: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new Error(`MASTRA_PROJECTION_INVALID: strategy profile payload is invalid: ${(error as Error).message}`);
  }
}

function strategiesOf(profile: Record<string, any>): TradingStrategy[] {
  const raw = profile.tradingStrategies;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("MASTRA_PROJECTION_INVALID: tradingStrategies is not a list of strategy objects");
  }
  return raw as TradingStrategy[];
}

function persistProfile(scope: MastraStrategyLibraryScope, projectId: string, profile: Record<string, any>): void {
  const now = new Date().toISOString();
  const exists = sqlite.prepare("SELECT 1 AS one FROM mastra_project_profiles WHERE user_id=? AND project_id=? AND instance_id=? LIMIT 1")
    .get(scope.userId, projectId, scope.instanceId);
  if (exists) {
    sqlite.prepare("UPDATE mastra_project_profiles SET profile_json=?, source_revision=?, updated_at=? WHERE user_id=? AND project_id=? AND instance_id=?")
      .run(JSON.stringify(profile), now, now, scope.userId, projectId, scope.instanceId);
  } else {
    sqlite.prepare("INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(scope.userId, projectId, scope.instanceId, JSON.stringify(profile), "service-owned://strategy-library", `service:${now}`, now, "service-owned", now, now);
  }
}

export function readMastraTradingStrategies(scope: MastraStrategyLibraryScope): TradingStrategy[] {
  const projectId = resolveProjectId(scope);
  const profile = readProfileObject(scope, projectId);
  return profile ? strategiesOf(profile) : [];
}

/** Upsert by key with the same stamping semantics as WorkspaceStore.writeTradingStrategy. */
export function writeMastraTradingStrategy(scope: MastraStrategyLibraryScope, strategy: TradingStrategy): TradingStrategy[] {
  const projectId = resolveProjectId(scope);
  return sqlite.transaction(() => {
    const profile = readProfileObject(scope, projectId) ?? {};
    const list = strategiesOf(profile);
    const today = beijingDateKey();
    const idx = list.findIndex((item) => item.key === strategy.key);
    const stamped: TradingStrategy = {
      ...strategy,
      enabled: strategy.enabled ?? true,
      created_at: strategy.created_at ?? (idx >= 0 ? list[idx].created_at : today),
      updated_at: today,
    };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    persistProfile(scope, projectId, { ...profile, tradingStrategies: list });
    return list;
  })();
}

/** Remove by key; returns true when a strategy was removed. Orphan plan.strategy_key references are not cascaded, matching workspace semantics. */
export function removeMastraTradingStrategy(scope: MastraStrategyLibraryScope, key: string): boolean {
  const projectId = resolveProjectId(scope);
  return sqlite.transaction(() => {
    const profile = readProfileObject(scope, projectId);
    if (!profile) return false;
    const list = strategiesOf(profile);
    const idx = list.findIndex((item) => item.key === key);
    if (idx < 0) return false;
    list.splice(idx, 1);
    persistProfile(scope, projectId, { ...profile, tradingStrategies: list });
    return true;
  })();
}
