/**
 * 交易策略工具层(第一版)。
 *
 * 内部调 WorkspaceStore,读写 workspace/config/trading_strategies.yaml。
 * 不直接访问 SQL,因为策略是用户私人制品,与 composite_indicators.yaml /
 * risk_taxonomy.yaml 的承载方式一致。
 *
 * 与 plan.ts 的关系:策略 → 预案的单向生成链路的上游。本工具只管策略 CRUD,
 * 不负责"基于策略起草预案"(那是 P3b 的 recommend_strategy_for_stock /
 * draft_stock_plan_from_strategy 的事)。
 */

import { getWorkspaceStore, type TradingStrategy } from "../lib/workspace-store.js";
import { DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { logger } from "../lib/logger.js";

export interface TradingStrategyToolInput {
  operation: "query" | "get" | "set" | "remove";
  key?: string;
  name?: string;
  applicability?: string;
  body?: string;
  enabled?: boolean;
}

export async function handleTradingStrategyTool(
  input: TradingStrategyToolInput,
  ctx: UserContext = { userId: DEFAULT_USER_ID },
): Promise<string> {
  switch (input.operation) {
    case "set":
      return setStrategy(ctx.userId, input);
    case "remove":
      return removeStrategy(ctx.userId, input.key ?? "");
    case "get":
      return getStrategy(ctx.userId, input.key ?? "");
    case "query":
    default:
      return queryStrategies(ctx.userId);
  }
}

async function queryStrategies(userId: string): Promise<string> {
  const store = getWorkspaceStore(userId);
  const list = await store.readTradingStrategies();
  if (list.length === 0) {
    return "当前没有交易策略。\n你可以让我按你的口述起草一份(描述适用场景 + 进场/止损/目标规则),确认后写入。";
  }
  const enabled = list.filter((s) => s.enabled !== false);
  const disabled = list.filter((s) => s.enabled === false);
  const lines: string[] = [`交易策略共 ${list.length} 份(启用 ${enabled.length},停用 ${disabled.length}):`];
  for (const s of enabled) {
    lines.push(`- [${s.key}] ${s.name}${s.applicability ? ` — ${s.applicability}` : ""}`);
  }
  if (disabled.length > 0) {
    lines.push("");
    lines.push("已停用:");
    for (const s of disabled) {
      lines.push(`- [${s.key}] ${s.name}`);
    }
  }
  return lines.join("\n");
}

async function getStrategy(userId: string, key: string): Promise<string> {
  if (!key) return "请提供要查看的策略 key。";
  const store = getWorkspaceStore(userId);
  const list = await store.readTradingStrategies();
  const hit = list.find((s) => s.key === key);
  if (!hit) return `未找到 key 为 "${key}" 的策略。`;
  return formatStrategyDetail(hit);
}

async function setStrategy(userId: string, input: TradingStrategyToolInput): Promise<string> {
  if (!input.key) return "新建/更新策略需要提供 key(短标识,如 breakout-pullback)。";
  if (!input.name) return "新建/更新策略需要提供 name(显示名)。";
  if (!input.body) return "新建/更新策略需要提供 body(策略正文)。";

  const store = getWorkspaceStore(userId);
  const existing = (await store.readTradingStrategies()).find((s) => s.key === input.key);
  const strategy: TradingStrategy = {
    key: input.key,
    name: input.name,
    applicability: input.applicability ?? existing?.applicability,
    body: input.body,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  await store.writeTradingStrategy(strategy);
  logger.info(`保存交易策略: ${input.key} (${existing ? "更新" : "新增"})`);
  const tag = existing ? "已更新" : "已新增";
  return `${tag}交易策略 [${input.key}] ${input.name}\n\n${formatStrategyDetail(strategy)}`;
}

async function removeStrategy(userId: string, key: string): Promise<string> {
  if (!key) return "请提供要删除的策略 key。";
  const store = getWorkspaceStore(userId);
  const existing = (await store.readTradingStrategies()).find((s) => s.key === key);
  if (!existing) return `未找到 key 为 "${key}" 的策略,无需删除。`;
  await store.removeTradingStrategy(key);
  logger.info(`删除交易策略: ${key}`);
  // 注:不级联清理 stock_plans.strategy_key,孤儿引用由 Dashboard 标灰处理。
  return `已删除交易策略 [${key}] ${existing.name}\n(基于该策略的存量预案不自动清理,会在概览中标灰提示"原策略已删除")`;
}

function formatStrategyDetail(s: TradingStrategy): string {
  const lines: string[] = [];
  lines.push(`策略 [${s.key}] ${s.name}`);
  if (s.applicability) lines.push(`适用场景: ${s.applicability}`);
  lines.push("正文:");
  lines.push(s.body);
  if (s.enabled === false) lines.push("(已停用)");
  if (s.created_at || s.updated_at) {
    lines.push(`创建: ${s.created_at ?? "-"} | 更新: ${s.updated_at ?? "-"}`);
  }
  return lines.join("\n");
}
