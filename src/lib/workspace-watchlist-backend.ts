/**
 * Workspace 实现 watchlist backend。
 *
 * 用 WorkspaceStore 读写 config/portfolio.yaml 的 watchlist 段。
 * instanceId 在 workspace 模式下忽略。
 */

import { getWorkspaceStore, type PortfolioWatchItem } from "./workspace-store.js";
import type { WatchlistBackend, WatchlistRow } from "./data-backend.js";

function toRow(item: PortfolioWatchItem): WatchlistRow {
  return {
    code: item.code,
    name: item.name,
    addedAt: item.added_at,
    reason: item.trigger ?? null,
    source: item.source,
  };
}

export const workspaceWatchlistBackend: WatchlistBackend = {
  async list(_userId) {
    const store = getWorkspaceStore(_userId);
    const items = await store.listWatchlist();
    return items.map(toRow);
  },

  async find(_userId, _instanceId, code) {
    const store = getWorkspaceStore(_userId);
    const items = await store.listWatchlist();
    const hit = items.find((w) => w.code === code);
    return hit ? toRow(hit) : null;
  },

  async add(_userId, _instanceId, input) {
    const store = getWorkspaceStore(_userId);
    const item: PortfolioWatchItem = {
      name: input.name,
      code: input.code,
      trigger: input.reason,
      source: input.source ?? "manual",
      added_at: input.addedAt ?? new Date().toISOString(),
    };
    await store.upsertWatchItem(item);
    return toRow(item);
  },

  async patch(_userId, _instanceId, code, patch) {
    const store = getWorkspaceStore(_userId);
    const existing = await this.find(_userId, _instanceId, code);
    if (!existing) return null;
    const nextReason = patch.reason ?? existing.reason ?? undefined;
    const nextSource = patch.source ?? existing.source ?? undefined;
    const nextName = patch.name ?? existing.name;
    const item: PortfolioWatchItem = {
      name: nextName,
      code,
      trigger: nextReason,
      source: nextSource ?? "manual",
      added_at: existing.addedAt,
    };
    await store.upsertWatchItem(item);
    return {
      ...existing,
      name: nextName,
      reason: nextReason ?? null,
      source: nextSource ?? "manual",
    };
  },

  async remove(_userId, _instanceId, code) {
    const store = getWorkspaceStore(_userId);
    const existing = await this.find(_userId, _instanceId, code);
    if (!existing) return null;
    await store.removeWatchItem(code);
    return existing;
  },
};
