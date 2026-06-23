/**
 * SQLite 实现 portfolio backend。
 *
 * 从 src/handlers/portfolio.ts 原有逻辑提取,保持行为完全一致。
 * 本模块存在的意义是:工作包 4 切换为 workspace backend 时,SQLite 仍可作为回退。
 *
 * 注:2026-06-22 修正 — 录入并存储每股成本价(单价),用于浮亏/盈亏比计算;
 * 数量与总金额仍属于用户隐私,不存储。
 */

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { portfolio, tradeActions } from "../db/schema.js";
import type { PortfolioBackend, PortfolioRow, TradeActionRow } from "./data-backend.js";

function serialize(row: typeof portfolio.$inferSelect): PortfolioRow {
  return {
    rowId: row.id,
    userId: row.userId,
    instanceId: row.instanceId,
    code: row.stockCode,
    name: row.stockName,
    buyDate: row.buyDate,
    costPrice: row.buyPrice ?? null,
    sellPrice: row.sellPrice,
    sellDate: row.sellDate,
    status: row.status as "open" | "closed",
  };
}

export const sqlitePortfolioBackend: PortfolioBackend = {
  async listActive(userId, instanceId) {
    const rows = await db
      .select()
      .from(portfolio)
      .where(and(eq(portfolio.userId, userId), eq(portfolio.instanceId, instanceId), isNull(portfolio.sellDate)));
    return rows.map(serialize);
  },

  async listAll(userId, instanceId) {
    const rows = await db
      .select()
      .from(portfolio)
      .where(and(eq(portfolio.userId, userId), eq(portfolio.instanceId, instanceId)));
    return rows.map(serialize);
  },

  async findActive(userId, instanceId, code) {
    const rows = await db
      .select()
      .from(portfolio)
      .where(
        and(
          eq(portfolio.userId, userId),
          eq(portfolio.instanceId, instanceId),
          eq(portfolio.stockCode, code),
          isNull(portfolio.sellDate)
        )
      )
      .limit(1);
    return rows[0] ? serialize(rows[0]) : null;
  },

  async upsertActive(userId, instanceId, input) {
    const existing = await this.findActive(userId, instanceId, input.code);
    const buyDate = input.buyDate ?? new Date().toISOString().slice(0, 10);
    const costPrice = input.costPrice ?? null;

    if (existing) {
      await db
        .update(portfolio)
        .set({
          stockName: input.name,
          buyDate,
          buyPrice: costPrice,
          status: "open",
        })
        .where(eq(portfolio.id, existing.rowId!));
      return { ...existing, name: input.name, buyDate, costPrice };
    }

    const inserted = await db
      .insert(portfolio)
      .values({
        userId,
        instanceId,
        stockCode: input.code,
        stockName: input.name,
        buyDate,
        buyPrice: costPrice,
        status: "open",
      })
      .returning();
    return serialize(inserted[0]);
  },

  async markClosed(userId, instanceId, code, sellPrice) {
    const existing = await this.findActive(userId, instanceId, code);
    if (!existing) return null;
    const price = sellPrice ?? 0;
    await db
      .update(portfolio)
      .set({
        sellPrice: price,
        sellDate: new Date().toISOString().slice(0, 10),
        status: "closed",
      })
      .where(eq(portfolio.id, existing.rowId!));
    return {
      ...existing,
      sellPrice: price,
      sellDate: new Date().toISOString().slice(0, 10),
      status: "closed" as const,
    };
  },

  async recordTradeAction(action) {
    await db.insert(tradeActions).values({
      userId: action.userId,
      instanceId: action.instanceId,
      stockCode: action.code,
      action: action.action,
      price: action.price ?? null,
      quantity: action.quantity ?? null,
      notes: action.notes ?? null,
      createdAt: action.createdAt,
    });
  },
};
