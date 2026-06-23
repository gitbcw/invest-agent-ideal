/**
 * SQLite 实现 watchlist backend。
 *
 * 从 src/handlers/watchlist.ts 原有逻辑提取,保持行为一致。
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { watchlist } from "../db/schema.js";
import type { WatchlistBackend, WatchlistRow } from "./data-backend.js";

function serialize(row: typeof watchlist.$inferSelect): WatchlistRow {
  return {
    rowId: row.id,
    userId: row.userId,
    instanceId: row.instanceId,
    code: row.stockCode,
    name: row.stockName,
    addedAt: row.addedAt,
    reason: row.reason,
    source: row.source,
  };
}

export const sqliteWatchlistBackend: WatchlistBackend = {
  async list(userId, instanceId) {
    const rows = await db
      .select()
      .from(watchlist)
      .where(and(eq(watchlist.userId, userId), eq(watchlist.instanceId, instanceId)));
    return rows.map(serialize);
  },

  async find(userId, instanceId, code) {
    const rows = await db
      .select()
      .from(watchlist)
      .where(
        and(
          eq(watchlist.userId, userId),
          eq(watchlist.instanceId, instanceId),
          eq(watchlist.stockCode, code)
        )
      )
      .limit(1);
    return rows[0] ? serialize(rows[0]) : null;
  },

  async add(userId, instanceId, input) {
    const inserted = await db
      .insert(watchlist)
      .values({
        userId,
        instanceId,
        stockCode: input.code,
        stockName: input.name,
        addedAt: input.addedAt ?? new Date().toISOString(),
        reason: input.reason ?? null,
        source: input.source ?? "manual",
      })
      .returning();
    return serialize(inserted[0]);
  },

  async patch(userId, instanceId, code, patch) {
    const existing = await this.find(userId, instanceId, code);
    if (!existing) return null;
    const nextReason = patch.reason ?? existing.reason ?? undefined;
    const nextSource = patch.source ?? existing.source ?? undefined;
    const nextName = patch.name ?? existing.name;
    await db
      .update(watchlist)
      .set({
        stockName: nextName,
        reason: nextReason ?? null,
        source: nextSource ?? "manual",
      })
      .where(eq(watchlist.id, existing.rowId!));
    return {
      ...existing,
      name: nextName,
      reason: nextReason ?? null,
      source: nextSource ?? "manual",
    };
  },

  async remove(userId, instanceId, code) {
    const existing = await this.find(userId, instanceId, code);
    if (!existing) return null;
    await db
      .delete(watchlist)
      .where(
        and(
          eq(watchlist.userId, userId),
          eq(watchlist.instanceId, instanceId),
          eq(watchlist.stockCode, code)
        )
      );
    return existing;
  },
};
