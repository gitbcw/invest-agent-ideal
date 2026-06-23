/**
 * Workspace 实现 stock plan backend。
 *
 * 用 WorkspaceStore 读写 config/portfolio.yaml 的 stock_plans 段。
 */

import { getWorkspaceStore, type StockPlan } from "./workspace-store.js";
import type { PlanBackend, PlanRow } from "./data-backend.js";

function toRow(plan: StockPlan): PlanRow {
  return {
    code: plan.code,
    name: plan.name,
    support: plan.support ?? null,
    resistance: plan.resistance ?? null,
    targetPrice: plan.target_price ?? null,
    stopLoss: plan.stop_loss ?? null,
    notes: plan.notes ?? null,
    watchConditions: plan.watch_conditions,
    linkedAlertRuleIds: plan.linked_alert_rule_ids,
    planType: plan.plan_type,
    strategyKey: plan.strategy_key ?? null,
    updatedAt: plan.updated_at,
  };
}

export const workspacePlanBackend: PlanBackend = {
  async list(_userId) {
    const store = getWorkspaceStore(_userId);
    const plans = await store.listStockPlans();
    return plans.map(toRow);
  },

  async find(_userId, _instanceId, code) {
    const store = getWorkspaceStore(_userId);
    const plans = await store.listStockPlans();
    const hit = plans.find((p) => p.code === code);
    return hit ? toRow(hit) : null;
  },

  async upsert(_userId, _instanceId, input) {
    const store = getWorkspaceStore(_userId);
    const plan: StockPlan = {
      name: input.name,
      code: input.code,
      support: input.support ?? null,
      resistance: input.resistance ?? null,
      target_price: input.targetPrice ?? null,
      stop_loss: input.stopLoss ?? null,
      watch_conditions: input.watchConditions,
      linked_alert_rule_ids: input.linkedAlertRuleIds,
      plan_type: input.planType ?? "manual",
      strategy_key: input.strategyKey ?? null,
      notes: input.notes ?? undefined,
    };
    await store.upsertStockPlan(plan);
    const updated = await this.find(_userId, _instanceId, input.code);
    return updated ?? toRow(plan);
  },

  async remove(_userId, _instanceId, code) {
    const store = getWorkspaceStore(_userId);
    const existing = await this.find(_userId, _instanceId, code);
    if (!existing) return null;
    await store.removeStockPlan(code);
    return existing;
  },
};
