/**
 * Workspace 实现 portfolio backend。
 *
 * 用 WorkspaceStore 读写 config/portfolio.yaml,
 * 用 memory/behavior_events.jsonl 记录交易动作。
 *
 * userId 用于定位工作空间;instanceId 在 workspace 模式下忽略
 * (单工作空间只对应单用户,不存在 instance 概念)。
 *
 * 注:2026-06-22 修正 — 录入并存储每股成本价(单价),用于浮亏/盈亏比计算;
 * 数量与总金额仍属于用户隐私,不存储。
 */

import { getWorkspaceStore, type PortfolioHolding } from "./workspace-store.js";
import type { PortfolioBackend, PortfolioRow } from "./data-backend.js";

function toRow(h: PortfolioHolding): PortfolioRow {
  return {
    code: h.code,
    name: h.name,
    buyDate: h.buy_date ?? "",
    costPrice: h.cost_price ?? null,
    sellPrice: h.sell_price ?? null,
    sellDate: h.sell_date ?? null,
    status: (h.status === "closed" ? "closed" : "open") as "open" | "closed",
  };
}

export const workspacePortfolioBackend: PortfolioBackend = {
  async listActive(_userId, _instanceId) {
    const store = getWorkspaceStore(_userId);
    const holdings = await store.listActiveHoldings();
    return holdings.map(toRow);
  },

  async listAll(_userId, _instanceId) {
    const store = getWorkspaceStore(_userId);
    const holdings = await store.listHoldings();
    return holdings.map(toRow);
  },

  async findActive(_userId, _instanceId, code) {
    const store = getWorkspaceStore(_userId);
    const active = await store.listActiveHoldings();
    const hit = active.find((h) => h.code === code);
    return hit ? toRow(hit) : null;
  },

  async upsertActive(_userId, _instanceId, input) {
    const store = getWorkspaceStore(_userId);
    const buyDate = input.buyDate ?? new Date().toISOString().slice(0, 10);
    const costPrice = input.costPrice ?? null;
    const holding: PortfolioHolding = {
      name: input.name,
      code: input.code,
      buy_date: buyDate,
      cost_price: costPrice,
      sell_date: null,
      sell_price: null,
      status: "open",
    };
    await store.upsertHolding(holding);
    return { ...holding, buyDate, costPrice } as PortfolioRow;
  },

  async markClosed(_userId, _instanceId, code, sellPrice) {
    const store = getWorkspaceStore(_userId);
    const existing = await this.findActive(_userId, _instanceId, code);
    if (!existing) return null;
    const price = sellPrice ?? 0;
    await store.upsertHolding({
      name: existing.name,
      code: existing.code,
      buy_date: existing.buyDate,
      cost_price: existing.costPrice ?? null,
      sell_price: price,
      sell_date: new Date().toISOString().slice(0, 10),
      status: "closed",
    });
    return {
      ...existing,
      sellPrice: price,
      sellDate: new Date().toISOString().slice(0, 10),
      status: "closed" as const,
    };
  },

  async recordTradeAction(action) {
    const store = getWorkspaceStore(action.userId);
    await store.appendBehaviorEvent({
      event_type: "action_confirmed",
      occurred_at: action.createdAt,
      payload: {
        code: action.code,
        action: action.action,
        price: action.price ?? null,
        quantity: action.quantity ?? null,
        notes: action.notes ?? null,
        instance_id: action.instanceId,
      },
    });
  },
};
