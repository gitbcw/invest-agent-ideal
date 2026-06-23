/**
 * SQLite 实现 stock plan backend。
 *
 * 从 src/handlers/plan.ts 原有逻辑提取。
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { stockPlans } from "../db/schema.js";
import type { PlanBackend, PlanRow } from "./data-backend.js";

function serialize(row: typeof stockPlans.$inferSelect): PlanRow {
  return {
    rowId: row.id,
    userId: row.userId,
    instanceId: row.instanceId,
    code: row.stockCode,
    name: row.stockName,
    support: row.support,
    resistance: row.resistance,
    targetPrice: row.targetPrice,
    stopLoss: row.stopLoss,
    notes: row.notes,
    watchConditions: row.watchConditions ? safeJsonParse(row.watchConditions) : undefined,
    linkedAlertRuleIds: row.linkedAlertRuleIds
      ? safeJsonParse<string[]>(row.linkedAlertRuleIds)
      : undefined,
    planType: row.planType,
    strategyKey: row.strategyKey,
    updatedAt: row.updatedAt,
  };
}

function safeJsonParse<T = unknown>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function serializeLinkedIds(ids?: string[]): string | null {
  if (!ids || ids.length === 0) return null;
  return JSON.stringify(ids);
}

function serializeWatchConditions(cond: unknown): string | null {
  if (cond == null) return null;
  if (typeof cond === "string") return cond;
  try {
    return JSON.stringify(cond);
  } catch {
    return null;
  }
}

export const sqlitePlanBackend: PlanBackend = {
  async list(userId, instanceId) {
    const rows = await db
      .select()
      .from(stockPlans)
      .where(and(eq(stockPlans.userId, userId), eq(stockPlans.instanceId, instanceId)));
    return rows.map(serialize);
  },

  async find(userId, instanceId, code) {
    const rows = await db
      .select()
      .from(stockPlans)
      .where(
        and(
          eq(stockPlans.userId, userId),
          eq(stockPlans.instanceId, instanceId),
          eq(stockPlans.stockCode, code)
        )
      )
      .limit(1);
    return rows[0] ? serialize(rows[0]) : null;
  },

  async upsert(userId, instanceId, input) {
    const existing = await this.find(userId, instanceId, input.code);
    const updatedAt = new Date().toISOString();
    if (existing) {
      await db
        .update(stockPlans)
        .set({
          stockName: input.name,
          support: input.support ?? null,
          resistance: input.resistance ?? null,
          targetPrice: input.targetPrice ?? null,
          stopLoss: input.stopLoss ?? null,
          notes: input.notes ?? null,
          watchConditions: serializeWatchConditions(input.watchConditions),
          linkedAlertRuleIds: serializeLinkedIds(input.linkedAlertRuleIds),
          planType: input.planType ?? "manual",
          strategyKey: input.strategyKey ?? null,
          updatedAt,
        })
        .where(eq(stockPlans.id, existing.rowId!));
      return { ...existing, ...input, updatedAt };
    }

    const inserted = await db
      .insert(stockPlans)
      .values({
        userId,
        instanceId,
        stockCode: input.code,
        stockName: input.name,
        support: input.support ?? null,
        resistance: input.resistance ?? null,
        targetPrice: input.targetPrice ?? null,
        stopLoss: input.stopLoss ?? null,
        notes: input.notes ?? null,
        watchConditions: serializeWatchConditions(input.watchConditions),
        linkedAlertRuleIds: serializeLinkedIds(input.linkedAlertRuleIds),
        planType: input.planType ?? "manual",
        strategyKey: input.strategyKey ?? null,
        updatedAt,
      })
      .returning();
    return serialize(inserted[0]);
  },

  async remove(userId, instanceId, code) {
    const existing = await this.find(userId, instanceId, code);
    if (!existing) return null;
    await db
      .delete(stockPlans)
      .where(eq(stockPlans.id, existing.rowId!));
    return existing;
  },
};
